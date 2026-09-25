import { BeszelClient, type BeszelClientLogger } from "./beszel-client";
import { coerceObject, coerceTimeoutMs, errText, normalizeHubUrl, validateHubUrl } from "./coerce";
import { tText } from "./i18n";
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
  createTestClient: (url: string, username: string, password: string, timeoutMs: number) => BeszelClient;
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
  return (url, username, password, timeoutMs) => new BeszelClient(url, username, password, timeoutMs, logger, delay);
}

/**
 * Dispatch a single `ioBroker.Message`. Mirrors the previous inline
 * switch in `main.ts:onMessage` 1:1 — entry-trace before the early-return
 * so broadcast messages without callback are still visible at debug
 * level, and an explicit `default:` branch so unknown commands get an error response
 * instead of leaving the callback hanging. Every text in a response is user-facing (the
 * admin shows it verbatim), so it comes from `admin/i18n` in the system language.
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
          deps.sendTo(obj.from, obj.command, { error: tText("msgAdminOnly") }, obj.callback);
          return;
        }
        // v0.5.0 (S3): obj.message is typed `unknown` in @iobroker/types ≥7.1
        // — a script calling `sendTo("beszel", "checkConnection", null)` used
        // to throw on `.url` access. Coerce to a plain object first; missing
        // fields fall through to the "missing url/username/password" branch.
        const msg = coerceObject(obj.message) ?? {};
        const config = msg as Partial<AdapterConfig>;
        const url = normalizeHubUrl(config.url);
        const username = typeof config.username === "string" ? config.username : "";
        const password = typeof config.password === "string" ? config.password : "";

        if (!url || !username || !password) {
          // v0.4.4 (H2): trace missing-config before sendTo.
          deps.log.debug("checkConnection: missing url/username/password in message");
          deps.sendTo(obj.from, obj.command, { error: tText("msgCredentialsRequired") }, obj.callback);
          return;
        }

        // The same URL check the instance runs at start — a URL the adapter would refuse
        // must not pass the test (a trailing space, a query, credentials in the URL).
        const urlError = validateHubUrl(url);
        if (urlError) {
          deps.log.debug(`checkConnection: invalid URL — ${urlError}`);
          deps.sendTo(obj.from, obj.command, { error: tText("msgUrlInvalid", urlError) }, obj.callback);
          return;
        }

        // v0.18.0: the test runs with the timeout the instance will run with — a test that
        // passes at 15 s while the configured 5 s would time out is no test.
        const testClient = deps.createTestClient(url, username, password, coerceTimeoutMs(config.requestTimeout));
        // v0.4.5: register the test-client so onUnload can abort an
        // inflight HTTPS request — the adapter's `this.client.cancelAll()`
        // only touches the prod-client, not these short-lived testClients.
        deps.onTestClientCreated?.(testClient);
        try {
          const result = await testClient.checkConnection();
          // v0.4.4 (H3): trace checkConnection result.
          deps.log.debug(
            `checkConnection: result=${result.success ? `ok (${result.systems} system(s))` : `fail (${result.reason})`}`,
          );
          // A 404 on the login means the address answers, but not with the Hub API — a
          // reverse-proxy path left out, or another service at that port. The raw 404 body
          // says nothing to the user; the hint names the likely mistake.
          if (!result.success && result.code === "NOT_FOUND") {
            deps.sendTo(obj.from, obj.command, { error: tText("msgHubNotFound") }, obj.callback);
            return;
          }
          // H1: the admin ConfigSendto component reads ONLY response.error/result —
          // never success/message. Map the outcome to that contract so a FAILED test
          // shows the real error instead of a false-positive "Ok" (fleet fix, see
          // reference_jsonconfig_sendto_connection_test).
          deps.sendTo(
            obj.from,
            obj.command,
            !result.success
              ? { error: tText("msgConnectionFailed", result.reason) }
              : result.systems > 0
                ? { result: tText("msgConnected", String(result.systems)) }
                : // A login that sees nothing is not a working connection: the poll would read
                  // an empty list forever. Shown as an error so the user notices.
                  { error: tText("msgConnectedNoSystems") },
            obj.callback,
          );
        } finally {
          deps.onTestClientDone?.(testClient);
        }
        break;
      }
      default:
        // v0.4.4 (H4): **architecture fix** — the switch had no default branch
        // before, so an unknown command left `obj.callback` uncalled until ioBroker
        // timed out (~5 s). Now: an explicit error response.
        // See `reference_onmessage_default_branch.md` for the pattern.
        deps.log.debug(`onMessage: unknown command '${obj.command}'`);
        deps.sendTo(obj.from, obj.command, { error: tText("msgUnknownCommand") }, obj.callback);
    }
  } catch (err) {
    // v0.4.4 (H5): trace catch so the debug log shows what failed.
    // H1: {error} contract so the admin surfaces the failure (not a false "Ok").
    deps.log.debug(`onMessage: '${obj.command}' failed: ${errText(err)}`);
    deps.sendTo(obj.from, obj.command, { error: errText(err) }, obj.callback);
  }
}
