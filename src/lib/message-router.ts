import { BeszelClient, type BeszelClientLogger } from "./beszel-client";
import { coerceObject, errText } from "./coerce";
import type { AdapterConfig } from "./types";

/**
 * Dependencies the message router needs to dispatch an `onMessage`
 * payload. Extracted as a pure interface so `dispatchMessage` is testable
 * without an `ioBroker.Adapter`-instance.
 *
 * v0.4.4 (H4): the router exists primarily to lock the `default:`-branch
 * contract via tests. See `reference_onmessage_default_branch.md` for the
 * cross-adapter pattern and why a missing default leaves the caller
 * callback hanging until ioBroker's ~5 s timeout.
 */
export interface MessageRouterDeps {
  /** Adapter debug logger. */
  log: {
    debug(msg: string): void;
    warn(msg: string): void;
  };
  /**
   * ioBroker sendTo bound against the adapter instance.
   *
   * `callback` matches the ioBroker.Message shape (`MessageCallbackInfo`),
   * not the executable `MessageCallback` — the adapter framework routes
   * the response through this callback-info to the original caller.
   */
  sendTo: (
    from: string,
    command: string,
    response: unknown,
    callback: ioBroker.MessageCallbackInfo | undefined,
  ) => void;
  /**
   * Factory for the throwaway BeszelClient used by `checkConnection`.
   * Injected so the test can swap in a fake instead of a live HTTP client.
   */
  createTestClient: (url: string, username: string, password: string) => BeszelClient;
  /**
   * v0.4.5: optional registration hook called right after `createTestClient`
   * returns a fresh client. Adapter holds a Set so `onUnload` can `cancelAll()`
   * on every test-client whose HTTPS-request might still be inflight at
   * shutdown — otherwise the testClient is local-scope only and the
   * adapter-level `cancelAll()` misses it, possibly keeping the process
   * alive past js-controller's 4-second kill deadline.
   */
  onTestClientCreated?: (client: BeszelClient) => void;
  /**
   * v0.4.5: optional completion hook called after the testClient's
   * `checkConnection` promise settles (success or fail). Adapter drops
   * the client from its Set so the next shutdown doesn't try to abort
   * an already-completed client.
   */
  onTestClientDone?: (client: BeszelClient) => void;
}

/**
 * Build the standard test-client factory used in production. Wraps the
 * adapter logger into the {@link BeszelClientLogger} shape and routes
 * `debug`/`warn` through it.
 *
 * @param logger Adapter debug logger to forward into the BeszelClient.
 * @param delay Adapter-managed delay (`this.delay.bind(this)`) so a 429 during
 *   checkConnection backs off and any in-flight wait is cancelled on unload.
 */
export function makeTestClientFactory(
  logger: BeszelClientLogger,
  delay: (ms: number) => Promise<void>,
): MessageRouterDeps["createTestClient"] {
  return (url, username, password) => new BeszelClient(url, username, password, undefined, logger, delay);
}

/**
 * Dispatch a single `ioBroker.Message`. Mirrors the previous inline
 * switch in `main.ts:onMessage` 1:1 — entry-trace before the early-return
 * so broadcast messages without callback are still visible at debug
 * level, and an explicit `default:` branch so unknown commands get
 * `{ error: "Unknown command" }` instead of leaving the callback hanging.
 *
 * @param obj The incoming message payload from the ioBroker framework.
 * @param deps Test-injectable dependencies (logger + sendTo + client factory).
 */
export async function dispatchMessage(obj: ioBroker.Message, deps: MessageRouterDeps): Promise<void> {
  // v0.4.4 (H1): entry log BEFORE the early-return — broadcast messages
  // without callback wouldn't be visible otherwise.
  deps.log.debug(`onMessage: command='${obj?.command}' from='${obj?.from}' has-callback=${!!obj?.callback}`);
  if (!obj.callback) {
    return;
  }
  try {
    switch (obj.command) {
      case "checkConnection": {
        // SEC-3a: checkConnection issues an outbound request to a caller-supplied
        // host — restrict it to the config UIs (admin/web) so an arbitrary script
        // (e.g. system.adapter.javascript.*) cannot use it as an SSRF / port-scan
        // oracle. Fail-safe by construction: a MISSING `from` is allowed (the
        // admin button must always work); only a PRESENT, non-UI origin is
        // rejected, and the reject is logged at warn so an unexpected-but-legit
        // origin is visible and recoverable — never a silent broken button.
        const from = typeof obj.from === "string" ? obj.from : "";
        if (from && !from.startsWith("system.adapter.admin.") && !from.startsWith("system.adapter.web.")) {
          deps.log.warn(`checkConnection rejected from '${from}' — only the admin/web config UI may run it`);
          deps.sendTo(
            obj.from,
            obj.command,
            { success: false, message: "checkConnection is only available from the admin UI" },
            obj.callback,
          );
          return;
        }
        // v0.5.0 (S3): obj.message is typed `unknown` in @iobroker/types ≥7.1
        // — a script calling `sendTo("beszel", "checkConnection", null)` used
        // to throw on `.url` access. Coerce to a plain object first; missing
        // fields fall through to the "missing url/username/password" branch.
        const msg = coerceObject(obj.message) ?? {};
        const config = msg as Partial<AdapterConfig>;
        const url = typeof config.url === "string" ? config.url : "";
        const username = typeof config.username === "string" ? config.username : "";
        const password = typeof config.password === "string" ? config.password : "";

        if (!url || !username || !password) {
          // v0.4.4 (H2): trace missing-config before sendTo.
          deps.log.debug("checkConnection: missing url/username/password in message");
          deps.sendTo(
            obj.from,
            obj.command,
            {
              success: false,
              message: "URL, username and password are required",
            },
            obj.callback,
          );
          return;
        }

        const testClient = deps.createTestClient(url, username, password);
        // v0.4.5: register the test-client so onUnload can abort an
        // inflight HTTPS request — the adapter's `this.client.cancelAll()`
        // only touches the prod-client, not these short-lived testClients.
        deps.onTestClientCreated?.(testClient);
        try {
          const result = await testClient.checkConnection();
          // v0.4.4 (H3): trace checkConnection result.
          deps.log.debug(`checkConnection: result=${result.success ? "ok" : "fail"} (${result.message})`);
          deps.sendTo(obj.from, obj.command, result, obj.callback);
        } finally {
          deps.onTestClientDone?.(testClient);
        }
        break;
      }
      default:
        // v0.4.4 (H4): **architecture fix** — switch had no default-Branch
        // before, so any unknown command left `obj.callback` ungerufen
        // until ioBroker timed out (~5s). Now: explicit error response.
        // See `reference_onmessage_default_branch.md` for the pattern.
        deps.log.debug(`onMessage: unknown command '${obj.command}'`);
        deps.sendTo(obj.from, obj.command, { error: "Unknown command" }, obj.callback);
    }
  } catch (err) {
    // v0.4.4 (H5): trace catch so the debug log shows what failed.
    // The sendTo back to the caller is preserved unchanged.
    deps.log.debug(`onMessage: '${obj.command}' failed: ${errText(err)}`);
    deps.sendTo(obj.from, obj.command, { success: false, message: errText(err) }, obj.callback);
  }
}
