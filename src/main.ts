import * as utils from "@iobroker/adapter-core";
import { I18n } from "@iobroker/adapter-core";
import { join } from "node:path";
import { BeszelClient } from "./lib/beszel-client";
import {
  coercePollInterval,
  coerceTimeoutMs,
  errText,
  normalizeHubUrl,
  sanitizeForLog,
  shouldFetchSystemDetails,
  urlForLog,
  validateHubUrl,
} from "./lib/coerce";
import { dispatchMessage, makeTestClientFactory } from "./lib/message-router";
import { tDesc, tName } from "./lib/i18n";
import { SYSTEM_STATUS_UNKNOWN } from "./lib/metric-registry";
import { StateManager } from "./lib/state-manager";
import type { SystemExtras } from "./lib/state-manager";
import type {
  AdapterConfig,
  BeszelContainer,
  BeszelSystem,
  MonitorProbeStat,
  SystemDetails,
  SystemStats,
} from "./lib/types";

/**
 * How often the two SLOW detail collections (`zfs_pools`, `smart_devices`) are read.
 * The Hub refreshes ZFS details roughly hourly (`system_zfs.go:zfsFetchInterval`) and
 * SMART data even more rarely, so a per-poll read would be load without new data.
 */
const DETAIL_REFRESH_MS = 15 * 60 * 1000;

/** Longest pause between two login attempts once the login keeps failing. */
const AUTH_BACKOFF_MAX_MS = 15 * 60 * 1000;

/** Error classes that mean "the login itself failed" — they share the auth back-off. */
const AUTH_ERROR_CODES: ReadonlySet<string> = new Set([
  "UNAUTHORIZED",
  "AUTH_FAILED",
  "MFA_REQUIRED",
  "PASSWORD_AUTH_DISABLED",
  "AUTH_FORBIDDEN",
]);

/** Node's codes for a TLS certificate the Hub presents but this host does not trust. */
const TLS_ERROR_CODES: ReadonlySet<string> = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT",
  "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
  "CERT_HAS_EXPIRED",
  "CERT_NOT_YET_VALID",
  "ERR_TLS_CERT_ALTNAME_INVALID",
]);

/**
 * A collection read failed for good — the Hub does not serve it (404, older release) or
 * does not let this account read it (403). Everything else (network, timeout, 5xx, an
 * unexpected body) is worth another try. One rule for the extra collections and for
 * `system_details`, which used to apply it the other way round.
 *
 * @param code The classified error.
 */
export function isDefinitiveFailure(code: string): boolean {
  return code === "NOT_FOUND" || code === "FORBIDDEN";
}
/**
 * Beszel adapter — polls a Beszel Hub (PocketBase) and mirrors systems,
 * stats and containers into ioBroker states. Exported so the orchestration
 * unit tests can drive its lifecycle/poll handlers directly.
 */
export class BeszelAdapter extends utils.Adapter {
  private client: BeszelClient | null = null;
  private stateManager: StateManager | null = null;
  /**
   * Factories for the HTTP client + state manager — default to the real
   * constructors. Test seams (fleet pattern, see homewizard `makeClient`):
   * unit tests replace these with fakes to exercise the poll orchestration
   * (error classification, dedup, auth backoff, details cadence) without
   * real network or js-controller.
   *
   * @param url Hub base URL
   * @param username Login username
   * @param password Login password
   * @param timeoutMs Per-request HTTP timeout (ms)
   */
  private makeClient: (url: string, username: string, password: string, timeoutMs: number) => BeszelClient = (
    url,
    username,
    password,
    timeoutMs,
  ) =>
    new BeszelClient(
      url,
      username,
      password,
      timeoutMs,
      {
        debug: (m: string) => this.log.debug(m),
        warn: (m: string) => this.log.warn(m),
      },
      this.delay.bind(this),
    );
  private makeStateManager: () => StateManager = () => new StateManager(this);
  private pollTimer: ioBroker.Interval | undefined = undefined;
  private isPolling = false;
  /**
   * Set first thing in `onUnload`. A poll that is still in flight when the host stops
   * us gets its requests aborted by `cancelAll()` — that rejection is not a Hub
   * problem and must neither log an error nor write states after the final shutdown
   * writes.
   */
  private unloaded = false;
  private lastSystemCount = 0;
  private lastErrorCode = "";
  /**
   * v0.17.0: the two SLOW detail collections (`zfs_pools`, `smart_devices`). The Hub
   * refreshes ZFS details roughly hourly (`system_zfs.go:zfsFetchInterval`) and SMART data
   * even more rarely, so reading them on every 60s poll would be pure load on the Hub for
   * data that cannot have changed. `systemd_services` is NOT in here — the Hub rewrites
   * that table on every agent sample, so it is read with the containers.
   */
  private lastDetailFetch = 0;
  /**
   * v0.18.0: the extra collections this Hub definitively does not serve (404 on an older
   * release, 403 without the read rule). Asking again every poll would be three dead
   * requests a minute for the life of the process; they are asked once more after a
   * restart. Transient failures (network, timeout, 5xx) are NOT recorded here.
   */
  private extrasUnsupported = new Set<"zfs" | "smart" | "services" | "monitors">();
  /** L3: warn once when the container fetch starts failing (403 / transient), trace thereafter. */
  private containersUnavailable = false;
  private authFailCount = 0;
  /**
   * Once the login has failed three times, the next attempt waits (1, 2, 4 … poll
   * intervals, at most 15 minutes) instead of sending the password every poll — the Hub
   * rate-limits logins, and with one-time-password login on every attempt leaves an MFA
   * record behind.
   */
  private authRetryAt = 0;
  /** The poll interval in ms (for the auth back-off). */
  private pollIntervalMs = 60_000;
  /**
   * An empty system list while systems are known is what a dead token looks like:
   * PocketBase serves an invalid token as a guest and filters every list to nothing
   * (HTTP 200, measured on a 0.20.0 Hub — no 401 ever comes). The poll logs in afresh
   * once per such streak; a list that stays empty after that is real.
   */
  private emptyListRetried = false;
  /** The "this account sees no systems" line went out for the current empty streak. */
  private emptyListNoticed = false;
  /** Extra collections whose "more records than read" warning went out already. */
  private truncatedWarned = new Set<string>();
  private failedSystems = new Set<string>();
  /**
   * v0.6.0 (F2): cache of the `system_details` collection (hardware/OS) keyed by system
   * id — `null` until it was read successfully once in this process, so that "never
   * read" (freeze what exists, leave the device icon alone) stays distinct from "read,
   * and this system has no row" (pending system: nothing to show). Plus the set of
   * system ids already *attempted*. The data changes only when a system (re)connects,
   * so it is fetched for a never-seen id and again when a system comes back up
   * (v0.18.0: the Hub re-reads the details from the agent on every reconnect —
   * `detailsFetched` is reset in `setDown` — so a kernel update shows after the reboot).
   *
   * The trigger keys on *attempted* ids (added after each attempt, success or
   * failure), NOT on which ids ended up in `systemDetails`: a `pending` system
   * with no details row, or an older Hub that 404s, must not retrigger a fetch
   * every single poll. Since v0.18.0 the collection is read regardless of the
   * "System info" toggle — the toggle gates the `info.*` datapoints, the OS icon on the
   * device needs the details either way.
   */
  private systemDetails: Map<string, SystemDetails> | null = null;
  private detailsAttempted = new Set<string>();
  /** Status of each system as of the previous poll — the `→ up` transition re-reads its details. */
  private lastStatus = new Map<string, string>();
  /**
   * v0.4.5: short-lived test-clients spawned from `checkConnection` admin
   * messages. The prod-`this.client` is what `onUnload` cancels, so these
   * need their own registry to be reachable at shutdown. Entries are added
   * by `message-router`'s `onTestClientCreated` hook and removed once
   * `checkConnection` settles.
   */
  private testClients = new Set<BeszelClient>();

  /** @param options Adapter options */
  public constructor(options: Partial<utils.AdapterOptions> = {}) {
    super({
      ...options,
      name: "beszel",
    });
    this.on("ready", this.onReady.bind(this));
    this.on("unload", this.onUnload.bind(this));
    this.on("message", this.onMessage.bind(this));
  }

  /**
   * Switch off `supportedMessages.stopInstance` on this instance's own object.
   *
   * The entry was dropped from the manifest, which only helps a FRESH install: an
   * upgrade merges the manifest into the existing instance object and never removes
   * a key, so the old `true` survives in the database — and that is what the host
   * reads. With it the host kills the process one second after asking it to stop,
   * `onUnload` never runs, and every state written while shutting down is dead code
   * (measured on a live js-controller 7.2.2, 2026-08-27).
   *
   * Only written when it is actually still on: an instance-object write restarts the
   * instance, so doing it unconditionally would restart on every single start.
   *
   * @returns true when the correction was written and the restart is coming — the
   *   caller has to stop right there. Carrying on would keep working against a
   *   process the host is already shutting down, which surfaces in the user's log
   *   as failed writes and a closed database (measured on the live server).
   */
  private async clearStopInstanceFlag(): Promise<boolean> {
    const id = `system.adapter.${this.namespace}`;
    try {
      const obj = await this.getForeignObjectAsync(id);
      const supported = obj?.common?.supportedMessages;
      // Correct as soon as the KEY exists at all — not just when `stopInstance` is on.
      // The earlier guard (`if (!supported?.stopInstance)`) never matched its own result,
      // so an instance that had already been "corrected" stayed broken forever.
      if (supported === undefined || supported === null) {
        return false;
      }
      this.log.info("Correcting a leftover setting from an earlier version — this instance restarts once");
      // Delete the whole key rather than writing `{ stopInstance: false }`.
      // `supportedMessages` is a POSITIVE LIST: js-controller stops looking at
      // `common.messagebox` as soon as it is an object, and a list whose entries are all
      // `false` means "no messages at all" — `subscribeMessage` never runs and the
      // Test-Connection button does nothing (that is what happened to govee-smart).
      // beszel escaped it by luck: its manifest carried `checkConnection: true` until
      // v0.11.x, and the merge keeps that entry, so the box stayed open. Leaving a
      // half-corrected object behind to rely on that is not a state worth keeping.
      // `null` is copied by the merge (`undefined` would be skipped), which puts the
      // instance back on the plain messagebox path.
      await this.extendForeignObjectAsync(id, { common: { supportedMessages: null } });
      return true;
    } catch (err: unknown) {
      // Objects DB unreachable — not worth failing the start over; the next start retries.
      this.log.debug(`Could not check the instance object ${id}: ${errText(err)}`);
      return false;
    }
  }

  /**
   * Re-apply the names and explanations of the manifest's `instanceObjects` to the
   * objects that already exist.
   *
   * js-controller creates `instanceObjects` only where they are MISSING, so a corrected
   * name or description in io-package.json reaches fresh installs only — an upgraded
   * installation keeps the old text while the manifest and every gate look green
   * (fleet rule, krobi 2026-09-03). Each object therefore gets an explicit
   * `extendObject` here. No `preserve`: these texts belong to the adapter.
   *
   * Only name and description are written — type, role and default stay whatever the
   * manifest created, so there is no second definition to drift apart from it.
   */
  private async ensureInstanceObjects(): Promise<void> {
    await this.extendObject("info", {
      type: "channel",
      common: { name: tName("channelInfo") },
      native: {},
    });
    await this.extendObject("info.connection", {
      type: "state",
      common: { name: tName("connectionStatus"), desc: tDesc("descConnection") },
      native: {},
    });
    await this.extendObject("info.systemsTotal", {
      type: "state",
      common: { name: tName("systemsTotal"), desc: tDesc("descSystemsTotal") },
      native: {},
    });
    await this.extendObject("info.systemsOnline", {
      type: "state",
      common: { name: tName("systemsOnline"), desc: tDesc("descSystemsOnline") },
      native: {},
    });
    await this.extendObject("info.systemsAllUp", {
      type: "state",
      common: { name: tName("systemsAllUp"), desc: tDesc("descSystemsAllUp") },
      native: {},
    });
    await this.extendObject("systems", {
      type: "folder",
      common: { name: tName("channelSystems") },
      native: {},
    });
  }

  /**
   * Run one startup step whose failure must not cost the adapter its poll timer.
   *
   * Everything between `I18n.init` and the first poll used to sit in one `try` around
   * the whole of `onReady`: a single rejected object call — a hiccup of the objects DB
   * while the adapter starts — logged one line and returned BEFORE `setInterval`. The
   * process then stayed alive, polled never again and js-controller does not restart a
   * daemon that is still running, so only a manual restart brought the instance back.
   * `clearStopInstanceFlag` already argued the right way about this ("not worth failing
   * the start over; the next start retries") — there just was no next start.
   *
   * @param label What was being set up, for the log line.
   * @param fn The step.
   */
  private async setupStep(label: string, fn: () => Promise<void>): Promise<void> {
    try {
      await fn();
    } catch (err: unknown) {
      this.log.error(`Startup step '${label}' failed — the adapter keeps going: ${errText(err)}`);
    }
  }

  private async onReady(): Promise<void> {
    try {
      // First: without this the whole shutdown path stays dead on an updated install.
      // A correction means the host is restarting us — no point setting anything up.
      if (await this.clearStopInstanceFlag()) {
        return;
      }
      // The one hard precondition of the whole adapter: without the translations every
      // object name would reach the tree as a raw key. A failure here is worth ending
      // the start for — every step after it is guarded instead.
      await I18n.init(join(this.adapterDir, "admin"), this);
      const config = this.config as unknown as AdapterConfig;

      this.log.debug(
        `onReady: starting (url='${urlForLog(config.url)}', pollInterval=${JSON.stringify(config.pollInterval)}s, requestTimeout=${JSON.stringify(config.requestTimeout)}s)`,
      );

      // Straight after the translations are loaded: an existing installation must pick
      // up corrected names/descriptions too, not just a fresh one.
      await this.setupStep("instance objects", () => this.ensureInstanceObjects());

      // L1: setStateChanged (not the deprecated setStateAsync) — no needless event.
      await this.setupStep("connection state", async () => {
        await this.setStateChangedAsync("info.connection", { val: false, ack: true });
      });

      // v0.11.0: snapshot the existing objects BEFORE any cleanup or poll — it is
      // the baseline for the "created / removed N datapoint(s)" line, so every
      // change from here on is attributable, and since v0.16.0 it is also what
      // answers every later "does this object exist" question.
      //
      // Nothing has been read yet, so no system may still claim to be online from
      // the previous run — least of all when the adapter cannot even start: the
      // early returns below (credentials to re-enter after an upgrade, an invalid
      // URL) used to leave every device green for good, with info.connection
      // already saying "disconnected" next to it. Runs off the snapshot, no extra
      // object view.
      this.stateManager = this.makeStateManager();
      await this.setupStep("object snapshot", () => this.stateManager!.snapshotExistingStates());
      await this.setupStep("offline markers", () => this.stateManager!.markAllOffline());

      // The two configuration stops below are NOT startup steps: with no credentials or
      // an unusable URL there is nothing to poll, so ending without a timer is the
      // correct answer, not a failure to recover from.
      if (!config.url || !config.username || !config.password) {
        this.log.error(
          "URL, e-mail and password are required. If you are upgrading from v0.4.x or earlier v0.5.x: open the Beszel adapter settings in ioBroker Admin and re-enter your e-mail and password once.",
        );
        return;
      }

      const urlError = validateHubUrl(config.url);
      if (urlError) {
        this.log.error(`Beszel Hub URL is invalid — ${urlError}. Adapter will not start.`);
        return;
      }
      const timeoutMs = coerceTimeoutMs(config.requestTimeout);
      this.log.debug(`timeoutMs: raw=${JSON.stringify(config.requestTimeout)} resolved=${timeoutMs}ms`);
      // The validated, normalised form — a pasted trailing space passed the check but
      // broke every request when the raw field went to the client.
      this.client = this.makeClient(normalizeHubUrl(config.url), config.username, config.password, timeoutMs);
      this.pollIntervalMs = coercePollInterval(config.pollInterval) * 1000;

      // F3: the system devices come from the startup snapshot, and both the retired-state
      // sweep and the metric cleanup reuse that one list.
      const existingNames = this.stateManager.getExistingSystemNames();
      await this.setupStep("retired states", () => this.stateManager!.removeRetiredStates(existingNames));
      await this.setupStep("metric cleanup", async () => {
        // Per system, like the poll's fan-out: one system whose cleanup fails must not
        // take the other systems — or the start — with it.
        await Promise.all(
          existingNames.map(async name => {
            try {
              await this.stateManager!.cleanupMetrics(name, config);
            } catch (err: unknown) {
              this.log.warn(`Metric cleanup for system '${name}' failed: ${errText(err)}`);
            }
          }),
        );
      });
      this.log.debug(`cleanupMetrics: ran for ${existingNames.length} existing system(s)`);

      await this.poll();
      if (this.unloaded) {
        // Stopped while the first poll was running: js-controller refuses timers during
        // shutdown (with a warning), and "started" would be a lie.
        return;
      }

      const pollSec = coercePollInterval(config.pollInterval);
      this.log.debug(`pollInterval: raw=${JSON.stringify(config.pollInterval)} resolved=${pollSec}s`);
      const intervalMs = pollSec * 1000;
      this.pollTimer = this.setInterval(() => {
        void this.poll();
      }, intervalMs);

      this.log.info(`Beszel adapter started — ${this.lastSystemCount} system(s), polling every ${pollSec}s`);
    } catch (err: unknown) {
      this.log.error(`onReady failed: ${errText(err)}`);
    }
  }

  private onUnload(callback: () => void): void {
    try {
      this.unloaded = true;
      // A system update still running in the parallel fan-out must not write
      // `info.online = true` after the offline markers below.
      this.stateManager?.stop();
      if (this.pollTimer) {
        this.clearInterval(this.pollTimer);
        this.pollTimer = undefined;
      }
      // v0.4.3 (X1+B8): cancel every in-flight HTTP request so a slow Hub
      // doesn't keep the adapter alive past js-controller's 4-second kill.
      this.client?.cancelAll();
      // v0.4.5: also abort any short-lived test-client whose checkConnection
      // is still inflight — without this an admin clicking "Test Connection"
      // right before adapter-stop could keep the process alive past the 4s
      // kill deadline.
      for (const tc of this.testClients) {
        tc.cancelAll();
      }
      this.testClients.clear();

      // A stopped adapter reads nothing, so no system may keep claiming to be online —
      // that state backs the device object's online indicator (statusStates.onlineId),
      // and info.connection alone would leave every device green.
      //
      // The callback goes LAST, after the writes: firing them off and reporting "done"
      // straight away loses them — the host tears the process down as soon as it is
      // told, measured 2026-08-27. No own timeout guard either: `this.setTimeout`
      // refuses during shutdown and a bare `setTimeout` is a repochecker finding; the
      // host's own deadline (`common.stopTimeout`) is the only one needed.
      const writes: Promise<unknown>[] = [this.setState("info.connection", { val: false, ack: true })];
      for (const sysId of this.stateManager?.knownSystemIds() ?? []) {
        writes.push(this.setState(`${sysId}.info.online`, { val: false, ack: true }));
        writes.push(this.setState(`${sysId}.info.status`, { val: SYSTEM_STATUS_UNKNOWN, ack: true }));
      }
      // The fleet rollup makes the same claim one level up — "3 of 5 online" while the
      // adapter is switched off. The three states are instance objects (exist from the
      // install on). systemsTotal stays: how many systems there are did not change just
      // because nobody is reading them.
      writes.push(this.setState("info.systemsOnline", { val: 0, ack: true }));
      writes.push(this.setState("info.systemsAllUp", { val: false, ack: true }));
      void Promise.all(writes)
        .catch((err: unknown) => {
          // States DB already going down — nothing left to report to.
          this.log.debug(`onUnload: final states rejected: ${errText(err)}`);
        })
        .finally(callback);
      return;
    } catch (err) {
      // v0.4.4 (I4): replace silent `// ignore` with a trace so shutdown
      // errors leave a debug breadcrumb. Broker-already-down errors here
      // are expected — debug-level keeps them out of the user log.
      this.log.debug(`onUnload error (ignored): ${errText(err)}`);
    }
    callback();
  }

  private async onMessage(obj: ioBroker.Message): Promise<void> {
    try {
      await dispatchMessage(obj, {
        log: {
          debug: (m: string) => this.log.debug(m),
          warn: (m: string) => this.log.warn(m),
        },
        sendTo: this.sendTo.bind(this),
        createTestClient: makeTestClientFactory(
          {
            debug: (m: string) => this.log.debug(m),
            warn: (m: string) => this.log.warn(m),
          },
          this.delay.bind(this),
        ),
        onTestClientCreated: client => {
          this.testClients.add(client);
        },
        onTestClientDone: client => {
          this.testClients.delete(client);
        },
      });
    } catch (err: unknown) {
      this.log.error(`onMessage failed: ${errText(err)}`);
    }
  }

  /**
   * Classify an error for deduplication and log-level decisions.
   *
   * @param err The error to classify
   */
  private classifyError(err: unknown): string {
    if (!(err instanceof Error)) {
      return "UNKNOWN";
    }
    const code = (err as NodeJS.ErrnoException).code;
    if (typeof code === "string" && TLS_ERROR_CODES.has(code)) {
      return "TLS_ERROR";
    }
    // v0.4.3 (B3): 429 surfaces if the in-client retry also got rate-limited.
    if (code === "RATE_LIMITED") {
      return "RATE_LIMITED";
    }
    if (
      code === "ENOTFOUND" ||
      code === "ECONNREFUSED" ||
      code === "ECONNRESET" ||
      code === "ENETUNREACH" ||
      code === "EHOSTUNREACH" ||
      code === "EAI_AGAIN"
    ) {
      return "NETWORK";
    }
    // N6: the client tags its own timeout with ETIMEDOUT (like the OS socket
    // timeout), so classification no longer sniffs the error message.
    if (code === "ETIMEDOUT") {
      return "TIMEOUT";
    }
    return code || "UNKNOWN";
  }

  /**
   * L3: fetch containers without letting a failure poison the whole poll. A 403
   * (the configured user lacks permission for the `containers` collection) or a
   * transient error used to reject the poll's `Promise.all` and freeze EVERY
   * system's states. Now it degrades gracefully, warning once then tracing.
   *
   * F1: returns `null` on a FETCH FAILURE (distinct from `[]` = fetched OK, zero
   * containers). The caller passes this distinction to `updateSystem` as
   * `containersAvailable`: a failure freezes the existing container tree (never
   * prunes it), while a genuine empty result prunes with the H2 debounce.
   * Conflating the two used to delete every container state after a mere 2 polls
   * of a persistent 403.
   *
   * @param config Adapter configuration (containers only fetched when enabled).
   */
  private async fetchContainersSafe(config: AdapterConfig): Promise<BeszelContainer[] | null> {
    // Toggle off or no client: no fetch attempted — this is "nothing to show",
    // not a failure, so return an empty (available) list rather than the null sentinel.
    if (!config.metrics_containers || !this.client) {
      return [];
    }
    try {
      const containers = await this.client.getContainers();
      if (this.containersUnavailable) {
        this.log.info("Container data is available again");
        this.containersUnavailable = false;
      }
      return containers;
    } catch (err) {
      if (this.unloaded) {
        // Aborted by onUnload's cancelAll() — not a Hub problem, nothing to warn about.
        return null;
      }
      const code = this.classifyError(err);
      const msg = `Container fetch failed (non-fatal, ${code}) — other metrics still update, container datapoints keep their last values`;
      if (this.containersUnavailable) {
        this.log.debug(msg);
      } else {
        this.log.warn(msg);
        this.containersUnavailable = true;
      }
      return null;
    }
  }

  /**
   * Drop every entry whose system id is no longer on the Hub. Shared by the three
   * per-system bookkeeping structures — they used to carry the same loop three times,
   * and a fourth structure would have added a fourth copy.
   *
   * @param book Set or Map keyed by system id.
   * @param activeIds System ids present in the current poll.
   */
  private static pruneByActiveIds(book: Set<string> | Map<string, unknown>, activeIds: ReadonlySet<string>): void {
    for (const id of [...book.keys()]) {
      if (!activeIds.has(id)) {
        book.delete(id);
      }
    }
  }

  /**
   * Write a state without letting a rejection escape.
   *
   * The error paths run inside the `catch` of an un-awaited interval poll, or while the
   * broker is going down: an unguarded `await` there would surface as an unhandled
   * rejection (crash-loop, no stack). Five call sites carried the identical
   * `void …catch(() => {})` before.
   *
   * @param id State id, namespace-relative.
   * @param val Value to write.
   */
  private setStateSafe(id: string, val: ioBroker.StateValue): void {
    void this.setStateChangedAsync(id, { val, ack: true }).catch(() => {
      /* broker shutting down / states unreachable */
    });
  }

  /**
   * DP4: write the fleet-level rollup states (total / online / all-up) so a
   * dashboard can show "N of M up" without enumerating every system. The three
   * states are static instance objects (io-package.json), so they exist from the
   * install on — a fresh install with the Hub unreachable shows 0 / 0 / false
   * instead of nothing, and the shutdown and error paths can always write them.
   *
   * @param total Number of systems in the current poll.
   * @param online Number of those reporting status "up".
   */
  private async writeRollup(total: number, online: number): Promise<void> {
    await this.setStateChangedAsync("info.systemsTotal", { val: total, ack: true });
    await this.setStateChangedAsync("info.systemsOnline", { val: online, ack: true });
    await this.setStateChangedAsync("info.systemsAllUp", { val: total > 0 && online === total, ack: true });
  }

  /**
   * v0.11.0: report how many datapoints this batch created or removed, then
   * reset the counters. Stays silent when nothing changed — the interesting
   * moments are a flipped metric toggle (the startup cleanup's removals and the
   * first poll's creations land in the SAME line), a system added or dropped on
   * the Hub, and hardware appearing/disappearing (fan, GPU, filesystem).
   */
  private logDatapointChanges(): void {
    const { created, removed } = this.stateManager!.takeChangeCounts();
    if (created === 0 && removed === 0) {
      return;
    }
    const parts: string[] = [];
    if (created > 0) {
      parts.push(`created ${created} datapoint(s)`);
    }
    if (removed > 0) {
      parts.push(`removed ${removed} datapoint(s)`);
    }
    this.log.info(`Object tree updated: ${parts.join(", ")}`);
  }

  private async poll(): Promise<void> {
    if (this.isPolling) {
      this.log.debug("Skipping poll — previous poll still running");
      return;
    }
    if (!this.client || !this.stateManager) {
      return;
    }

    // v0.4.4 (E1): poll-entry anchor with last-error-context + system count.
    this.log.debug(`poll: starting (lastErrorCode='${this.lastErrorCode}', lastSystemCount=${this.lastSystemCount})`);

    if (Date.now() < this.authRetryAt) {
      // The login keeps failing: wait for the back-off instead of sending the password
      // again. The offline markers were written when the failure happened.
      this.log.debug(`poll: login back-off, next attempt in ${this.authRetryAt - Date.now()}ms`);
      return;
    }

    this.isPolling = true;
    try {
      const config = this.config as unknown as AdapterConfig;

      let [systems, containersResult, statsMap] = await this.fetchCore(config);
      if (this.unloaded) {
        // The host stopped us while the requests were in flight: onUnload has
        // already written the final states and reported "done" — nothing from
        // this run may land on top of that.
        return;
      }
      if (
        systems.length === 0 &&
        !this.emptyListRetried &&
        (this.lastSystemCount > 0 || this.stateManager.knownSystemIds().length > 0)
      ) {
        // A dead token (password changed, account deleted, token secret reset, database
        // restored) reads as an empty list, not as a 401 — log in afresh once and ask again.
        this.emptyListRetried = true;
        this.log.debug("poll: the Hub returned no systems although some are known — logging in again once");
        this.client.invalidateToken();
        [systems, containersResult, statsMap] = await this.fetchCore(config);
        if (this.unloaded) {
          return;
        }
      }
      if (systems.length > 0) {
        this.emptyListRetried = false;
        this.emptyListNoticed = false;
      } else if (!this.emptyListNoticed) {
        // Logged in, and still nothing: the account is assigned to no system (and the Hub
        // does not share all systems). The tree stays as it is — an empty answer never
        // deletes devices (v0.13.0) — but the user learns why nothing updates.
        this.emptyListNoticed = true;
        this.log.info(
          "The Hub returns no systems for this account — is the user assigned to the systems on the Hub (or SHARE_ALL_SYSTEMS set)? Existing datapoints keep their last values.",
        );
      }

      // Update connection state (L1: setStateChanged → no event when unchanged).
      await this.setStateChangedAsync("info.connection", { val: true, ack: true });

      // F1: null = the container fetch failed (403 / timeout). The per-system
      // update freezes the existing container tree in that case instead of pruning it.
      const containersAvailable = containersResult !== null;
      // F5: group the flat container list by system id once (O(containers)) so each
      // updateSystem gets only its own containers, instead of re-filtering the whole
      // list per system (O(systems × containers)).
      const containersBySystem = new Map<string, BeszelContainer[]>();
      for (const container of containersResult ?? []) {
        const list = containersBySystem.get(container.system);
        if (list) {
          list.push(container);
        } else {
          containersBySystem.set(container.system, [container]);
        }
      }

      // v0.6.0 (F2): attach the hardware/OS details (F3/N5: the fetch is extracted to keep
      // the poll body readable; the attach stays here so the data flow is visible rather
      // than a side effect of the fetch). `null` = never read in this process: the
      // `info.*` states then freeze and the device icon is left as it is.
      const details = await this.fetchSystemDetails(systems);
      if (this.unloaded) {
        // cancelAll() aborted the details request; the next requests must not go out.
        return;
      }
      const detailsAvailable = details !== null;
      for (const system of systems) {
        const d = details?.get(system.id);
        if (d) {
          system.details = d;
        }
      }

      // v0.17.0: the three extra collections. `systemd_services` follows the containers
      // (the Hub rewrites it on every agent sample); the two detail collections run on a
      // slow cadence — reading them every 60s would ask the Hub for data it refreshes
      // roughly hourly. Each failure is non-fatal: the group is simply not passed on,
      // which freezes its datapoints instead of pruning them.
      const extrasBySystem = await this.fetchExtras(config, systems);
      if (this.unloaded) {
        // The detail requests above are what `cancelAll` aborted — each one is caught as
        // non-fatal, so without this check the fan-out below would still run and write
        // `info.online = true` on top of the offline states onUnload just wrote.
        return;
      }

      // v0.4.3 (SM5): pre-resolve safeNames deterministically so collisions
      // between two systems with the same sanitized name get suffixed
      // disambiguation BEFORE the parallel update fan-out.
      this.stateManager.prepareForPoll(systems);

      // v0.4.3 (M4): per-system updates run in parallel, each wrapped in
      // try/catch so one bad system doesn't poison the others.
      await Promise.all(
        systems.map(async system => {
          try {
            const stats = statsMap.get(system.id);
            // v0.4.4 (F1): per-system entry. ~6 systems × 1440 polls/day at
            // default 60s interval = ~8640 lines/day — acceptable at debug.
            // Line stays short (name + truncated id + hasStats only).
            this.log.debug(
              `updateSystem: '${sanitizeForLog(system.name)}' (id=${system.id.slice(0, 8)}, hasStats=${!!stats})`,
            );
            await this.stateManager!.updateSystem(
              system,
              stats,
              containersBySystem.get(system.id) ?? [],
              config,
              containersAvailable,
              extrasBySystem.get(system.id) ?? {},
              detailsAvailable,
            );
            this.failedSystems.delete(system.id);
          } catch (err) {
            const msg = `Failed to update system '${sanitizeForLog(system.name)}': ${errText(err)}`;
            if (this.unloaded) {
              // The databases close under a shutdown — that is not the system's fault.
              this.log.debug(msg);
              return;
            }
            if (this.failedSystems.has(system.id)) {
              this.log.debug(msg);
            } else {
              this.log.warn(msg);
              this.failedSystems.add(system.id);
            }
          }
        }),
      );

      if (this.unloaded) {
        return;
      }

      // Cleanup stale systems — but ONLY on a non-empty result. An empty list
      // (transient API issue, or a Hub momentarily reporting zero systems right
      // after a restart) must NEVER wipe the device trees. A genuinely empty
      // install has nothing to clean up anyway. (F1)
      if (systems.length > 0) {
        await this.stateManager.cleanupSystems(systems.map(s => s.name));
        // v0.7.2: prune the per-system bookkeeping along with the states —
        // otherwise the maps grow forever across add/remove cycles, and a
        // re-added system would inherit the old failure-dedup entry (its
        // first failure warn silently demoted to debug) and a stale
        // detailsAttempted marker.
        // L5: bookkeeping keyed by the STABLE system id — two systems that share
        // a sanitized name would otherwise clobber each other's failure-dedup marker.
        const activeIds = new Set(systems.map(s => s.id));
        BeszelAdapter.pruneByActiveIds(this.failedSystems, activeIds);
        BeszelAdapter.pruneByActiveIds(this.detailsAttempted, activeIds);
        BeszelAdapter.pruneByActiveIds(this.lastStatus, activeIds);
        if (this.systemDetails) {
          BeszelAdapter.pruneByActiveIds(this.systemDetails, activeIds);
        }

        // DP4: fleet rollup for dashboards (non-empty poll only, like the cleanup).
        await this.writeRollup(systems.length, systems.filter(s => s.status === "up").length);
      }

      // v0.11.0: one line per poll telling the user how the object tree changed.
      // Silent when nothing changed, so a plain restart stays quiet — it speaks
      // up exactly when a metric toggle was flipped or hardware appeared/vanished.
      this.logDatapointChanges();

      this.lastSystemCount = systems.length;
      this.authFailCount = 0;
      this.authRetryAt = 0;

      // Clear error state on success. A Hub that was merely unreachable is a state
      // (info.connection carries it), so its return is not news either.
      if (this.lastErrorCode) {
        if (this.lastErrorCode === "TRANSIENT") {
          this.log.debug("Connection restored");
        } else {
          this.log.info("Connection restored");
        }
        this.lastErrorCode = "";
      }
      this.log.debug(`Polled ${systems.length} systems successfully`);
    } catch (err) {
      this.handlePollError(err);
    } finally {
      this.isPolling = false;
    }
  }

  /**
   * The three reads every poll needs, in parallel. With B1's auth mutex they share one
   * login when the token is missing.
   *
   * @param config Adapter configuration.
   */
  private fetchCore(
    config: AdapterConfig,
  ): Promise<[BeszelSystem[], BeszelContainer[] | null, Map<string, SystemStats>]> {
    return Promise.all([this.client!.getSystems(), this.fetchContainersSafe(config), this.client!.getLatestStats()]);
  }

  /**
   * v0.17.0 — the three extra collections, grouped by system id.
   *
   * `systemd_services` is read on EVERY poll: the Hub rewrites that table on every agent
   * sample, so it is live data like the containers. `zfs_pools` and `smart_devices` are
   * read at most every {@link DETAIL_REFRESH_MS} — the Hub refreshes ZFS details roughly
   * hourly and SMART data even more rarely, so a 60s read would be load without new data.
   *
   * Each fetch is guarded on its own: a collection an older Hub does not have (404) or a
   * request that fails must not cost the other two, and must not look like "no records"
   * to the pruner — the group is then simply absent from the result. The other way round
   * matters just as much: after a SUCCESSFUL read, every polled system gets an explicit
   * (possibly empty) list, so the last SMART device / pool / unit of a system is pruned
   * like any other — seeding only the systems that still have a record would freeze it.
   *
   * @param config Adapter configuration.
   * @param systems The systems of this poll — every one of them is seeded per collection read.
   * @returns Extras by system id (empty map when every toggle is off).
   */
  private async fetchExtras(config: AdapterConfig, systems: BeszelSystem[]): Promise<Map<string, SystemExtras>> {
    const out = new Map<string, SystemExtras>();
    const entryOf = (systemId: string): SystemExtras => {
      const entry = out.get(systemId) ?? {};
      out.set(systemId, entry);
      return entry;
    };
    const put = <K extends keyof SystemExtras>(
      systemId: string,
      key: K,
      value: NonNullable<SystemExtras[K]>[0],
    ): void => {
      const entry = entryOf(systemId);
      const list = (entry[key] ?? []) as NonNullable<SystemExtras[K]>;
      (list as unknown[]).push(value);
      entry[key] = list;
    };
    const seed = <K extends keyof SystemExtras>(key: K): void => {
      for (const system of systems) {
        const entry = entryOf(system.id);
        entry[key] = entry[key] ?? [];
      }
    };

    const wantServices = config.metrics_services && config.metrics_servicesDetails;
    const wantZfs = config.metrics_zfs && config.metrics_zfsDetails;
    const wantSmart = config.metrics_smart;
    const wantMonitors = config.metrics_networkMonitors;
    if (!wantServices && !wantZfs && !wantSmart && !wantMonitors) {
      return out;
    }

    // Network monitors (Beszel 0.20.0): the Hub rewrites their measured columns on every
    // agent update, so they are read every poll. The newest probe minute per monitor is an
    // addition — its failure leaves the monitors without it, not without data.
    if (wantMonitors && !this.extrasUnsupported.has("monitors")) {
      try {
        const monitors = await this.client!.getNetworkMonitors();
        let probes = new Map<string, MonitorProbeStat>();
        try {
          probes = await this.client!.getLatestMonitorProbes();
        } catch (err) {
          this.log.debug(`network_monitor_stats fetch failed (non-fatal, ${this.classifyError(err)}): ${errText(err)}`);
        }
        for (const monitor of monitors) {
          put(monitor.system, "networkMonitors", { monitor, probe: probes.get(monitor.id) });
        }
        seed("networkMonitors");
      } catch (err) {
        this.noteExtrasFailure("monitors", "network_monitors", err);
      }
    }

    if (wantServices && !this.extrasUnsupported.has("services")) {
      try {
        for (const unit of await this.client!.getSystemdServices()) {
          put(unit.system, "systemdServices", unit);
        }
        seed("systemdServices");
      } catch (err) {
        this.noteExtrasFailure("services", "systemd_services", err);
      }
    }

    const dueForDetails = Date.now() - this.lastDetailFetch >= DETAIL_REFRESH_MS;
    if (!dueForDetails) {
      return out;
    }
    // Stamped per ATTEMPT, not per success: a Hub that is briefly unreachable gets the
    // next try after the usual 15 minutes, not sixty tries an hour.
    this.lastDetailFetch = Date.now();
    if (wantZfs && !this.extrasUnsupported.has("zfs")) {
      try {
        for (const pool of await this.client!.getZfsPoolDetails()) {
          put(pool.system, "zfsPools", pool);
        }
        seed("zfsPools");
      } catch (err) {
        this.noteExtrasFailure("zfs", "zfs_pools", err);
      }
    }
    if (wantSmart && !this.extrasUnsupported.has("smart")) {
      try {
        for (const dev of await this.client!.getSmartDevices()) {
          put(dev.system, "smartDevices", dev);
        }
        seed("smartDevices");
      } catch (err) {
        this.noteExtrasFailure("smart", "smart_devices", err);
      }
    }
    return out;
  }

  /**
   * A failed read of one of the extra collections. A collection the Hub does not serve
   * (404 — older release) or does not let this user read (403) is definitive: it is
   * recorded once at info level and not asked for again until the next restart.
   * Anything else (network, timeout, 5xx) is a transient and traced at debug level.
   *
   * @param key Which collection, as tracked in `extrasUnsupported`.
   * @param collection The Hub's collection name, for the log line.
   * @param err The rejection.
   */
  private noteExtrasFailure(key: "zfs" | "smart" | "services" | "monitors", collection: string, err: unknown): void {
    const code = this.classifyError(err);
    if (code === "TRUNCATED" && !this.truncatedWarned.has(key)) {
      this.truncatedWarned.add(key);
      this.log.warn(
        `The Hub holds more ${collection} records than the adapter reads in one go — those datapoints keep their last values`,
      );
      return;
    }
    if (isDefinitiveFailure(code)) {
      this.extrasUnsupported.add(key);
      this.log.info(
        `The Hub does not serve the ${collection} collection (${code}) — not asked again until the adapter restarts`,
      );
      return;
    }
    this.log.debug(`${collection} fetch failed (non-fatal, ${code}): ${errText(err)}`);
  }

  /**
   * F2/F3: fetch the `system_details` collection (hardware/OS) for the current systems.
   * Read for a system id never attempted before (first poll, new system) and again when
   * a system comes back `up`: the Hub re-reads the details from the agent on every
   * reconnect, so that is exactly when a kernel or hardware change shows. A failed
   * fetch is non-fatal; a transient NETWORK/TIMEOUT is retried next poll rather than
   * marked attempted.
   *
   * v0.18.0: read regardless of the "System info" toggle (that toggle gates the `info.*`
   * datapoints in the registry) — the OS icon on the device object needs the details
   * either way. Returns `null` until the first successful read of this process.
   *
   * v0.16.0: returns the map instead of writing `system.details` into the caller's array
   * behind its back. The attach still happens — the metric registry reads
   * `system.details` — but it is now one visible line in the poll.
   *
   * @param systems Systems from the current poll.
   * @returns Details by system id, or `null` while nothing has ever been fetched.
   */
  private async fetchSystemDetails(systems: BeszelSystem[]): Promise<Map<string, SystemDetails> | null> {
    for (const s of systems) {
      const was = this.lastStatus.get(s.id);
      if (s.status === "up" && was !== undefined && was !== "up") {
        // Back up (or up for the first time after `pending`): the Hub has fresh details.
        this.detailsAttempted.delete(s.id);
      }
      this.lastStatus.set(s.id, s.status);
    }
    const needFetch = shouldFetchSystemDetails(
      systems.map(s => s.id),
      this.detailsAttempted,
    );
    if (needFetch) {
      let markAttempted = true;
      try {
        this.systemDetails = await this.client!.getSystemDetails();
        this.log.debug(`system_details: fetched ${this.systemDetails.size} record(s)`);
      } catch (err) {
        // F3: only a DEFINITIVE failure (a 404 on an older Hub without the collection,
        // a 403) marks the systems attempted so we stop refetching — the same rule as
        // the extra collections. Anything else (network, timeout, a 502 from a proxy, an
        // unexpected body) is retried next poll.
        const code = this.classifyError(err);
        markAttempted = isDefinitiveFailure(code);
        this.log.debug(
          `system_details fetch failed (non-fatal, ${code}, willRetry=${!markAttempted}): ${errText(err)}`,
        );
      }
      if (markAttempted) {
        for (const s of systems) {
          this.detailsAttempted.add(s.id);
        }
      }
    }
    return this.systemDetails;
  }

  /**
   * The login failure in the user's terms — the likely cause, in one clause.
   *
   * @param code The classified error.
   */
  private static loginHint(code: string): string {
    switch (code) {
      case "AUTH_FAILED":
        return "wrong e-mail or password? (Beszel logs in with the e-mail address)";
      case "MFA_REQUIRED":
        return "the account needs a one-time password (MFA); use an account without it";
      case "PASSWORD_AUTH_DISABLED":
        return "password login is switched off on the Hub";
      case "AUTH_FORBIDDEN":
        return "the Hub refused this account (not verified?)";
      default:
        return "the Hub rejected the login";
    }
  }

  /**
   * N5: classify a failed poll and log it at the right level (dedup repeats to
   * debug, hint FORBIDDEN/RATE_LIMITED, escalate then suppress repeated auth
   * failures) and mark the connection state offline. Extracted from `poll` so
   * the happy path reads top-to-bottom.
   *
   * @param err The error thrown by the poll body.
   */
  private handlePollError(err: unknown): void {
    if (this.unloaded) {
      // cancelAll() in onUnload aborted this poll's requests. That is the shutdown,
      // not a Hub failure: no error line (Sentry would report it), no state writes
      // on top of the final ones onUnload already made.
      this.log.debug(`Poll ended by shutdown: ${errText(err)}`);
      return;
    }
    const errMsg = errText(err);
    const errorCode = this.classifyError(err);
    // An unreachable Hub is a STATE (info.connection carries it): NETWORK and TIMEOUT share
    // one dedup key and stay at debug level, first time and every time.
    const transient = errorCode === "NETWORK" || errorCode === "TIMEOUT";
    const dedupKey = transient ? "TRANSIENT" : errorCode;
    const isRepeat = dedupKey === this.lastErrorCode;
    this.lastErrorCode = dedupKey;

    if (AUTH_ERROR_CODES.has(errorCode)) {
      this.client?.invalidateToken();
      this.authFailCount++;
      if (this.authFailCount <= 3) {
        this.log.error(`Login to the Beszel Hub failed — ${BeszelAdapter.loginHint(errorCode)}`);
        this.log.debug(`Login failed: ${errMsg}`);
      } else if (this.authFailCount === 4) {
        this.log.error("Login keeps failing — suppressing further login errors and trying less often");
      } else {
        this.log.debug(`Login still failing (attempt ${this.authFailCount}): ${errMsg}`);
      }
      if (this.authFailCount >= 3) {
        const waitMs = Math.min(this.pollIntervalMs * 2 ** (this.authFailCount - 3), AUTH_BACKOFF_MAX_MS);
        this.authRetryAt = Date.now() + waitMs;
      }
    } else if (transient) {
      this.log.debug(`Beszel Hub not reachable (${errorCode}): ${errMsg}`);
    } else if (isRepeat) {
      this.log.debug(`Poll failed (ongoing): ${errMsg}`);
    } else if (errorCode === "FORBIDDEN") {
      this.log.warn("The Beszel Hub refused a data request (403)");
      this.log.debug(`Poll failed: ${errMsg}`);
    } else if (errorCode === "RATE_LIMITED") {
      this.log.warn("Beszel Hub rate-limited the request — slowing down. Consider increasing the poll interval.");
    } else if (errorCode === "TLS_ERROR") {
      this.log.warn("Cannot connect to the Beszel Hub over HTTPS — its certificate is not trusted (self-signed?)");
      this.log.debug(`Poll failed: ${errMsg}`);
    } else if (errorCode === "INVALID_RESPONSE") {
      this.log.warn("The answer is not the Beszel Hub API — does the URL point at the Hub?");
      this.log.debug(`Poll failed: ${errMsg}`);
    } else if (errorCode === "NOT_FOUND") {
      this.log.warn(
        "The Beszel Hub API was not found at this URL (404) — does it point at the Hub, including a reverse-proxy path?",
      );
      this.log.debug(`Poll failed: ${errMsg}`);
    } else if (errorCode === "TRUNCATED") {
      this.log.warn("The Hub holds more records than the adapter reads in one go — no update this time");
      this.log.debug(`Poll failed: ${errMsg}`);
    } else {
      // SEC-1: the dynamic message can carry a Hub response snippet / URL —
      // keep it at debug; the error-level line carries only the error class.
      this.log.error(`Poll failed (${errorCode})`);
      this.log.debug(`Poll failed: ${errMsg}`);
    }

    // L1: fire-and-forget via setStateSafe — this runs in the catch of the un-awaited
    // interval poll; an unguarded await here would escape as an unhandled
    // rejection if the states DB is also down (crash-loop, no stack). Mirrors onUnload.
    this.setStateSafe("info.connection", false);

    // The poll failed as a whole (Hub unreachable, auth rejected, …), so this run
    // learned nothing about any system. Leaving `info.online` on its last value
    // keeps every device green in the object tree while `info.connection` next to
    // it already says the Hub is gone — the same contradiction on one screen.
    // Immediate, not debounced, for exactly that reason.
    //
    // `info.status` says "unknown" rather than one of the Hub's four values: the
    // adapter did not observe the system going down, it just cannot ask any more.
    for (const sysId of this.stateManager?.knownSystemIds() ?? []) {
      this.setStateSafe(`${sysId}.info.online`, false);
      this.setStateSafe(`${sysId}.info.status`, SYSTEM_STATUS_UNKNOWN);
    }
    // Same claim one level up — the rollup states are instance objects, so they
    // exist even before the first successful poll.
    this.setStateSafe("info.systemsOnline", 0);
    this.setStateSafe("info.systemsAllUp", false);
  }
}

if (require.main !== module) {
  // Export the constructor in compact mode
  module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new BeszelAdapter(options);
} else {
  (() => new BeszelAdapter())();
}
