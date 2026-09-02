import * as utils from "@iobroker/adapter-core";
import { I18n } from "@iobroker/adapter-core";
import { join } from "node:path";
import { BeszelClient } from "./lib/beszel-client";
import {
  coercePollInterval,
  coerceTimeoutMs,
  errText,
  isPlaintextRemoteUrl,
  sanitizeForLog,
  shouldFetchSystemDetails,
  validateHubUrl,
} from "./lib/coerce";
import { dispatchMessage, makeTestClientFactory } from "./lib/message-router";
import { SYSTEM_STATUS_UNKNOWN } from "./lib/metric-registry";
import { StateManager } from "./lib/state-manager";
import type { AdapterConfig, BeszelContainer, BeszelSystem, SystemDetails } from "./lib/types";

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
   * problem and must neither log an error (which Sentry would report) nor write
   * states after the final shutdown writes.
   */
  private unloaded = false;
  private lastSystemCount = 0;
  private lastErrorCode = "";
  /** L3: warn once when the container fetch starts failing (403 / transient), trace thereafter. */
  private containersUnavailable = false;
  /** DP4: whether the fleet-rollup state objects have been created this run. */
  private rollupCreated = false;
  private authFailCount = 0;
  private failedSystems = new Set<string>();
  /**
   * v0.6.0 (F2): cache of static system_details (hardware/OS) keyed by system
   * id, plus the set of system ids we've already *attempted* to fetch. Fetched
   * only when "System info" is enabled and only when a never-seen system id
   * appears — the data is static, so re-fetching every 60 s would be waste.
   *
   * The trigger keys on *attempted* ids (added after each attempt, success or
   * failure), NOT on which ids ended up in `systemDetails`: a `pending` system
   * with no details row, or an older Hub that 404s, must not retrigger a fetch
   * every single poll. A config toggle change restarts the instance, resetting
   * both back to empty.
   */
  private systemDetails: Map<string, SystemDetails> = new Map();
  private detailsAttempted = new Set<string>();
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
      const supported = obj?.common?.supportedMessages as { stopInstance?: unknown } | undefined;
      if (!supported?.stopInstance) {
        return false;
      }
      this.log.info("Correcting a leftover setting from an earlier version — this instance restarts once");
      await this.extendForeignObjectAsync(id, { common: { supportedMessages: { stopInstance: false } } });
      return true;
    } catch (err: unknown) {
      // Objects DB unreachable — not worth failing the start over; the next start retries.
      this.log.debug(`Could not check the instance object ${id}: ${errText(err)}`);
      return false;
    }
  }

  private async onReady(): Promise<void> {
    try {
      // First: without this the whole shutdown path stays dead on an updated install.
      // A correction means the host is restarting us — no point setting anything up.
      if (await this.clearStopInstanceFlag()) {
        return;
      }
      await I18n.init(join(this.adapterDir, "admin"), this);
      const config = this.config as unknown as AdapterConfig;

      this.log.debug(
        `onReady: starting (url='${config.url}', pollInterval=${JSON.stringify(config.pollInterval)}s, requestTimeout=${JSON.stringify(config.requestTimeout)}s)`,
      );

      // L1: setStateChanged (not the deprecated setStateAsync) — no needless event.
      await this.setStateChangedAsync("info.connection", { val: false, ack: true });

      // v0.11.0: snapshot the existing states BEFORE any cleanup or poll — it is
      // the baseline for the "created / removed N datapoint(s)" line, so every
      // change from here on is attributable.
      //
      // Nothing has been read yet, so no system may still claim to be online from
      // the previous run — least of all when the adapter cannot even start: the
      // early returns below (credentials to re-enter after an upgrade, an invalid
      // URL) used to leave every device green for good, with info.connection
      // already saying "disconnected" next to it. Runs off the snapshot, no extra
      // object view.
      this.stateManager = this.makeStateManager();
      await this.stateManager.snapshotExistingStates();
      await this.stateManager.markAllOffline();

      if (!config.url || !config.username || !config.password) {
        this.log.error(
          "URL, username, and password are required. If you are upgrading from v0.4.x or earlier v0.5.x: open the Beszel adapter settings in ioBroker Admin and re-enter your username and password once.",
        );
        return;
      }

      const urlError = validateHubUrl(config.url);
      if (urlError) {
        this.log.error(`Beszel Hub URL is invalid — ${urlError}. Adapter will not start.`);
        return;
      }
      // SEC-3b: warn (do not block) when the Hub is reached over plain http on a
      // remote host — login + token then cross the network in cleartext.
      if (isPlaintextRemoteUrl(config.url)) {
        this.log.warn(
          "Beszel Hub URL uses plain http to a remote host — credentials and token travel the network in cleartext. Use https if the Hub is reachable beyond this machine.",
        );
      }

      const timeoutMs = coerceTimeoutMs(config.requestTimeout);
      this.log.debug(`timeoutMs: raw=${JSON.stringify(config.requestTimeout)} resolved=${timeoutMs}ms`);
      this.client = this.makeClient(config.url, config.username, config.password, timeoutMs);

      // F3: enumerate the existing system devices once and reuse the list for both
      // the legacy migration and the metric cleanup, instead of two object views.
      const existingNames = await this.stateManager.getExistingSystemNames();
      await this.stateManager.migrateLegacyStates(existingNames);
      await Promise.all(existingNames.map(name => this.stateManager!.cleanupMetrics(name, config)));
      this.log.debug(`cleanupMetrics: ran for ${existingNames.length} existing system(s)`);

      await this.poll();

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
      // adapter is switched off. Only once the states exist (they are created lazily on
      // the first successful poll). systemsTotal stays: how many systems there are did
      // not change just because nobody is reading them.
      if (this.rollupCreated) {
        writes.push(this.setState("info.systemsOnline", { val: 0, ack: true }));
        writes.push(this.setState("info.systemsAllUp", { val: false, ack: true }));
      }
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
    if (code === "UNAUTHORIZED") {
      return "UNAUTHORIZED";
    }
    // v0.4.3 (B4'): 403 is a permissions issue — distinct from auth so the
    // poll-handler can give a useful "check user role" hint.
    if (code === "FORBIDDEN") {
      return "FORBIDDEN";
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
      const msg = `Container fetch failed (non-fatal, ${code}) — other metrics still update, existing container states are kept. Check the configured user's permission for the containers collection.`;
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
   * DP4: write the fleet-level rollup states (total / online / all-up) so a
   * dashboard can show "N of M up" without enumerating every system. Creates the
   * objects lazily on the first write.
   *
   * @param total Number of systems in the current poll.
   * @param online Number of those reporting status "up".
   */
  private async writeRollup(total: number, online: number): Promise<void> {
    if (!this.rollupCreated) {
      await this.setObjectNotExistsAsync("info.systemsTotal", {
        type: "state",
        common: {
          name: I18n.getTranslatedObject("systemsTotal"),
          type: "number",
          role: "value",
          read: true,
          write: false,
        },
        native: {},
      });
      await this.setObjectNotExistsAsync("info.systemsOnline", {
        type: "state",
        common: {
          name: I18n.getTranslatedObject("systemsOnline"),
          type: "number",
          role: "value",
          read: true,
          write: false,
        },
        native: {},
      });
      await this.setObjectNotExistsAsync("info.systemsAllUp", {
        type: "state",
        common: {
          name: I18n.getTranslatedObject("systemsAllUp"),
          type: "boolean",
          role: "indicator",
          read: true,
          write: false,
        },
        native: {},
      });
      // v0.11.0: these three are created outside createAndSetState, so the
      // datapoint counter has to be told about them explicitly. Ids that
      // already exist are ignored, so a restart adds nothing.
      this.stateManager?.noteStatesCreated(["info.systemsTotal", "info.systemsOnline", "info.systemsAllUp"]);
      this.rollupCreated = true;
    }
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

    this.isPolling = true;
    try {
      const config = this.config as unknown as AdapterConfig;

      // v0.4.3 (M3): all three API calls in parallel. With B1's auth-mutex
      // they share a single auth round-trip if the token is missing.
      // Earlier `getLatestStats` waited for `getSystems` to finish even
      // though the API endpoint doesn't actually need the system IDs.
      const [systems, containersResult, statsMap] = await Promise.all([
        this.client.getSystems(),
        this.fetchContainersSafe(config),
        this.client.getLatestStats(),
      ]);
      if (this.unloaded) {
        // The host stopped us while the requests were in flight: onUnload has
        // already written the final states and reported "done" — nothing from
        // this run may land on top of that.
        return;
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

      // v0.6.0 (F2): attach static hardware/OS details when "System info" is on
      // (F3/N5: extracted to keep the poll body readable).
      await this.fetchAndAttachDetails(systems, config);

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
            );
            this.failedSystems.delete(system.id);
          } catch (err) {
            const msg = `Failed to update system '${sanitizeForLog(system.name)}': ${errText(err)}`;
            if (this.failedSystems.has(system.id)) {
              this.log.debug(msg);
            } else {
              this.log.warn(msg);
              this.failedSystems.add(system.id);
            }
          }
        }),
      );

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
        for (const id of [...this.failedSystems]) {
          if (!activeIds.has(id)) {
            this.failedSystems.delete(id);
          }
        }
        for (const id of [...this.detailsAttempted]) {
          if (!activeIds.has(id)) {
            this.detailsAttempted.delete(id);
          }
        }
        for (const id of [...this.systemDetails.keys()]) {
          if (!activeIds.has(id)) {
            this.systemDetails.delete(id);
          }
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

      // Clear error state on success
      if (this.lastErrorCode) {
        this.log.info("Connection restored");
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
   * F2/F3: fetch the static `system_details` collection (hardware/OS) and attach
   * it to the current systems. No-op unless "System info" is enabled. Only
   * fetched when a system id we've never attempted appears (first poll or a new
   * system) — the data is static, so re-fetching each poll would be waste. A
   * failed fetch is non-fatal (details stay absent → no hardware states); a
   * transient NETWORK/TIMEOUT is retried next poll rather than marked attempted.
   *
   * @param systems Systems from the current poll (mutated: `.details` attached).
   * @param config Adapter configuration.
   */
  private async fetchAndAttachDetails(systems: BeszelSystem[], config: AdapterConfig): Promise<void> {
    if (!config.metrics_agentVersion) {
      return;
    }
    // Edge: a system that is `pending` right now gets marked attempted, so its
    // hardware info appears only after the next adapter restart — an accepted
    // trait of the "static data, restart-to-refresh" model.
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
        // F3: only a DEFINITIVE failure (e.g. a 404 on an older Hub without the
        // collection) marks the systems attempted so we stop refetching. A
        // transient NETWORK/TIMEOUT failure must be retried next poll instead.
        const code = this.classifyError(err);
        markAttempted = code !== "NETWORK" && code !== "TIMEOUT";
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
    for (const system of systems) {
      const d = this.systemDetails.get(system.id);
      if (d) {
        system.details = d;
      }
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
    const isRepeat = errorCode === this.lastErrorCode;
    this.lastErrorCode = errorCode;

    if (errorCode === "UNAUTHORIZED") {
      this.client?.invalidateToken();
      this.authFailCount++;
      if (this.authFailCount <= 3) {
        this.log.error("Authentication failed — check username and password");
      } else if (this.authFailCount === 4) {
        this.log.error("Authentication keeps failing — suppressing further auth errors");
      } else {
        this.log.debug(`Auth still failing (attempt ${this.authFailCount})`);
      }
    } else if (isRepeat) {
      this.log.debug(`Poll failed (ongoing): ${errMsg}`);
    } else if (errorCode === "FORBIDDEN") {
      // v0.4.3 (B4'): permission issue — reauth wouldn't help. Hint the user.
      this.log.error(
        `Beszel Hub returned 403 Forbidden — the configured user has no permission for these collections. Check the user role on the Hub admin UI.`,
      );
    } else if (errorCode === "RATE_LIMITED") {
      this.log.warn("Beszel Hub rate-limited the request — slowing down. Consider increasing the poll interval.");
    } else if (errorCode === "NETWORK") {
      this.log.warn("Cannot reach Beszel Hub — will keep retrying");
    } else {
      // SEC-1: the dynamic message can carry a Hub response snippet / URL —
      // keep it at debug; the error-level line (captured by opt-in Sentry)
      // carries only the error class, no Hub-supplied content.
      this.log.error(`Poll failed (${errorCode})`);
      this.log.debug(`Poll failed: ${errMsg}`);
    }

    // L1: fire-and-forget with .catch — this runs in the catch of the un-awaited
    // interval poll; an unguarded await here would escape as an unhandled
    // rejection if the states DB is also down (crash-loop, no stack). Mirrors onUnload.
    void this.setStateChangedAsync("info.connection", { val: false, ack: true }).catch(() => {
      /* broker shutting down / states unreachable */
    });

    // The poll failed as a whole (Hub unreachable, auth rejected, …), so this run
    // learned nothing about any system. Leaving `info.online` on its last value
    // keeps every device green in the object tree while `info.connection` next to
    // it already says the Hub is gone — the same contradiction on one screen.
    // Immediate, not debounced, for exactly that reason.
    //
    // `info.status` says "unknown" rather than one of the Hub's four values: the
    // adapter did not observe the system going down, it just cannot ask any more.
    for (const sysId of this.stateManager?.knownSystemIds() ?? []) {
      void this.setStateChangedAsync(`${sysId}.info.online`, { val: false, ack: true }).catch(() => {
        /* broker shutting down / states unreachable */
      });
      void this.setStateChangedAsync(`${sysId}.info.status`, { val: SYSTEM_STATUS_UNKNOWN, ack: true }).catch(() => {
        /* broker shutting down / states unreachable */
      });
    }
    // Same claim one level up. Only once the rollup states actually exist —
    // before the first successful poll they have no object behind them.
    if (this.rollupCreated) {
      void this.setStateChangedAsync("info.systemsOnline", { val: 0, ack: true }).catch(() => {
        /* broker shutting down / states unreachable */
      });
      void this.setStateChangedAsync("info.systemsAllUp", { val: false, ack: true }).catch(() => {
        /* broker shutting down / states unreachable */
      });
    }
  }
}

if (require.main !== module) {
  // Export the constructor in compact mode
  module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new BeszelAdapter(options);
} else {
  (() => new BeszelAdapter())();
}
