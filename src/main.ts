import * as utils from "@iobroker/adapter-core";
import { I18n } from "@iobroker/adapter-core";
import { join } from "node:path";
import { BeszelClient } from "./lib/beszel-client";
import { coercePollInterval, coerceTimeoutMs, errText, shouldFetchSystemDetails, validateHubUrl } from "./lib/coerce";
import { dispatchMessage, makeTestClientFactory } from "./lib/message-router";
import { StateManager } from "./lib/state-manager";
import type { AdapterConfig, SystemDetails } from "./lib/types";

class BeszelAdapter extends utils.Adapter {
  private client: BeszelClient | null = null;
  private stateManager: StateManager | null = null;
  private pollTimer: ioBroker.Interval | undefined = undefined;
  private isPolling = false;
  private lastSystemCount = 0;
  private lastErrorCode = "";
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

  public constructor(options: Partial<utils.AdapterOptions> = {}) {
    super({
      ...options,
      name: "beszel",
    });
    this.on("ready", this.onReady.bind(this));
    this.on("unload", this.onUnload.bind(this));
    this.on("message", this.onMessage.bind(this));
  }

  private async onReady(): Promise<void> {
    try {
      await I18n.init(join(this.adapterDir, "admin"), this);
      const config = this.config as unknown as AdapterConfig;

      this.log.debug(
        `onReady: starting (url='${config.url}', pollInterval=${JSON.stringify(config.pollInterval)}s, requestTimeout=${JSON.stringify(config.requestTimeout)}s)`,
      );

      await this.setStateAsync("info.connection", { val: false, ack: true });

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

      const timeoutMs = coerceTimeoutMs(config.requestTimeout);
      this.log.debug(`timeoutMs: raw=${JSON.stringify(config.requestTimeout)} resolved=${timeoutMs}ms`);
      this.client = new BeszelClient(
        config.url,
        config.username,
        config.password,
        timeoutMs,
        {
          debug: (m: string) => this.log.debug(m),
          warn: (m: string) => this.log.warn(m),
        },
        this.delay.bind(this),
      );
      this.stateManager = new StateManager(this);

      await this.stateManager.migrateLegacyStates();

      const existingNames = await this.stateManager.getExistingSystemNames();
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
      // v0.4.3 (X2): explicit catch — broker-already-down should not leak
      // as an unhandled rejection.
      void this.setState("info.connection", { val: false, ack: true }).catch(() => {
        /* broker is shutting down */
      });
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
    if (code === "ETIMEDOUT" || err.message.includes("timed out")) {
      return "TIMEOUT";
    }
    return code || "UNKNOWN";
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
      const [systems, containers, statsMap] = await Promise.all([
        this.client.getSystems(),
        config.metrics_containers ? this.client.getContainers() : Promise.resolve([]),
        this.client.getLatestStats(),
      ]);

      // Update connection state
      await this.setStateAsync("info.connection", { val: true, ack: true });

      // v0.6.0 (F2): static hardware/OS details. Only when "System info" is
      // enabled, and only fetched when we don't already have details for every
      // current system (first poll, or a newly-added system) — the data is
      // static so re-fetching each poll would be waste. A failed fetch (e.g.
      // older Hub without the collection) is non-fatal: details stay absent →
      // no hardware states are created.
      if (config.metrics_agentVersion) {
        // Refetch only when a system id we've never attempted appears. Marking
        // every current id as attempted afterwards (even on failure) stops a
        // details-less system or an older Hub's 404 from refetching each poll.
        // Edge: a system that is `pending` at this moment gets marked attempted,
        // so its hardware info appears only after the next adapter restart — an
        // accepted trait of the "static data, restart-to-refresh" model.
        const needFetch = shouldFetchSystemDetails(
          systems.map(s => s.id),
          this.detailsAttempted,
        );
        if (needFetch) {
          try {
            this.systemDetails = await this.client.getSystemDetails();
            this.log.debug(`system_details: fetched ${this.systemDetails.size} record(s)`);
          } catch (err) {
            this.log.debug(`system_details fetch failed (non-fatal): ${errText(err)}`);
          }
          for (const s of systems) {
            this.detailsAttempted.add(s.id);
          }
        }
        for (const system of systems) {
          const d = this.systemDetails.get(system.id);
          if (d) {
            system.details = d;
          }
        }
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
            this.log.debug(`updateSystem: '${system.name}' (id=${system.id.slice(0, 8)}, hasStats=${!!stats})`);
            await this.stateManager!.updateSystem(system, stats, containers, config);
            this.failedSystems.delete(system.name);
          } catch (err) {
            const msg = `Failed to update system '${system.name}': ${errText(err)}`;
            if (this.failedSystems.has(system.name)) {
              this.log.debug(msg);
            } else {
              this.log.warn(msg);
              this.failedSystems.add(system.name);
            }
          }
        }),
      );

      // Cleanup stale systems — but only if we actually got results.
      // An empty list during a transient API issue must NOT wipe all devices.
      if (systems.length > 0 || this.lastSystemCount === 0) {
        await this.stateManager.cleanupSystems(systems.map(s => s.name));
      }

      this.lastSystemCount = systems.length;
      this.authFailCount = 0;

      // Clear error state on success
      if (this.lastErrorCode) {
        this.log.info("Connection restored");
        this.lastErrorCode = "";
      }
      this.log.debug(`Polled ${systems.length} systems successfully`);
    } catch (err) {
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
        this.log.error(`Poll failed: ${errMsg}`);
      }

      await this.setStateAsync("info.connection", { val: false, ack: true });
    } finally {
      this.isPolling = false;
    }
  }
}

if (require.main !== module) {
  // Export the constructor in compact mode
  module.exports = (options: Partial<utils.AdapterOptions> | undefined) => new BeszelAdapter(options);
} else {
  (() => new BeszelAdapter())();
}
