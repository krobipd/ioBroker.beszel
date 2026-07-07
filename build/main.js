"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var main_exports = {};
__export(main_exports, {
  BeszelAdapter: () => BeszelAdapter
});
module.exports = __toCommonJS(main_exports);
var utils = __toESM(require("@iobroker/adapter-core"));
var import_adapter_core = require("@iobroker/adapter-core");
var import_node_path = require("node:path");
var import_beszel_client = require("./lib/beszel-client");
var import_coerce = require("./lib/coerce");
var import_message_router = require("./lib/message-router");
var import_state_manager = require("./lib/state-manager");
class BeszelAdapter extends utils.Adapter {
  client = null;
  stateManager = null;
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
  makeClient = (url, username, password, timeoutMs) => new import_beszel_client.BeszelClient(
    url,
    username,
    password,
    timeoutMs,
    {
      debug: (m) => this.log.debug(m),
      warn: (m) => this.log.warn(m)
    },
    this.delay.bind(this)
  );
  makeStateManager = () => new import_state_manager.StateManager(this);
  pollTimer = void 0;
  isPolling = false;
  lastSystemCount = 0;
  lastErrorCode = "";
  /** L3: warn once when the container fetch starts failing (403 / transient), trace thereafter. */
  containersUnavailable = false;
  /** DP4: whether the fleet-rollup state objects have been created this run. */
  rollupCreated = false;
  authFailCount = 0;
  failedSystems = /* @__PURE__ */ new Set();
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
  systemDetails = /* @__PURE__ */ new Map();
  detailsAttempted = /* @__PURE__ */ new Set();
  /**
   * v0.4.5: short-lived test-clients spawned from `checkConnection` admin
   * messages. The prod-`this.client` is what `onUnload` cancels, so these
   * need their own registry to be reachable at shutdown. Entries are added
   * by `message-router`'s `onTestClientCreated` hook and removed once
   * `checkConnection` settles.
   */
  testClients = /* @__PURE__ */ new Set();
  /** @param options Adapter options */
  constructor(options = {}) {
    super({
      ...options,
      name: "beszel"
    });
    this.on("ready", this.onReady.bind(this));
    this.on("unload", this.onUnload.bind(this));
    this.on("message", this.onMessage.bind(this));
  }
  async onReady() {
    try {
      await import_adapter_core.I18n.init((0, import_node_path.join)(this.adapterDir, "admin"), this);
      const config = this.config;
      this.log.debug(
        `onReady: starting (url='${config.url}', pollInterval=${JSON.stringify(config.pollInterval)}s, requestTimeout=${JSON.stringify(config.requestTimeout)}s)`
      );
      await this.setStateChangedAsync("info.connection", { val: false, ack: true });
      if (!config.url || !config.username || !config.password) {
        this.log.error(
          "URL, username, and password are required. If you are upgrading from v0.4.x or earlier v0.5.x: open the Beszel adapter settings in ioBroker Admin and re-enter your username and password once."
        );
        return;
      }
      const urlError = (0, import_coerce.validateHubUrl)(config.url);
      if (urlError) {
        this.log.error(`Beszel Hub URL is invalid \u2014 ${urlError}. Adapter will not start.`);
        return;
      }
      if ((0, import_coerce.isPlaintextRemoteUrl)(config.url)) {
        this.log.warn(
          "Beszel Hub URL uses plain http to a remote host \u2014 credentials and token travel the network in cleartext. Use https if the Hub is reachable beyond this machine."
        );
      }
      const timeoutMs = (0, import_coerce.coerceTimeoutMs)(config.requestTimeout);
      this.log.debug(`timeoutMs: raw=${JSON.stringify(config.requestTimeout)} resolved=${timeoutMs}ms`);
      this.client = this.makeClient(config.url, config.username, config.password, timeoutMs);
      this.stateManager = this.makeStateManager();
      await this.stateManager.migrateLegacyStates();
      const existingNames = await this.stateManager.getExistingSystemNames();
      await Promise.all(existingNames.map((name) => this.stateManager.cleanupMetrics(name, config)));
      this.log.debug(`cleanupMetrics: ran for ${existingNames.length} existing system(s)`);
      await this.poll();
      const pollSec = (0, import_coerce.coercePollInterval)(config.pollInterval);
      this.log.debug(`pollInterval: raw=${JSON.stringify(config.pollInterval)} resolved=${pollSec}s`);
      const intervalMs = pollSec * 1e3;
      this.pollTimer = this.setInterval(() => {
        void this.poll();
      }, intervalMs);
      this.log.info(`Beszel adapter started \u2014 ${this.lastSystemCount} system(s), polling every ${pollSec}s`);
    } catch (err) {
      this.log.error(`onReady failed: ${(0, import_coerce.errText)(err)}`);
    }
  }
  onUnload(callback) {
    var _a;
    try {
      if (this.pollTimer) {
        this.clearInterval(this.pollTimer);
        this.pollTimer = void 0;
      }
      (_a = this.client) == null ? void 0 : _a.cancelAll();
      for (const tc of this.testClients) {
        tc.cancelAll();
      }
      this.testClients.clear();
      void this.setState("info.connection", { val: false, ack: true }).catch(() => {
      });
    } catch (err) {
      this.log.debug(`onUnload error (ignored): ${(0, import_coerce.errText)(err)}`);
    }
    callback();
  }
  async onMessage(obj) {
    try {
      await (0, import_message_router.dispatchMessage)(obj, {
        log: {
          debug: (m) => this.log.debug(m),
          warn: (m) => this.log.warn(m)
        },
        sendTo: this.sendTo.bind(this),
        createTestClient: (0, import_message_router.makeTestClientFactory)(
          {
            debug: (m) => this.log.debug(m),
            warn: (m) => this.log.warn(m)
          },
          this.delay.bind(this)
        ),
        onTestClientCreated: (client) => {
          this.testClients.add(client);
        },
        onTestClientDone: (client) => {
          this.testClients.delete(client);
        }
      });
    } catch (err) {
      this.log.error(`onMessage failed: ${(0, import_coerce.errText)(err)}`);
    }
  }
  /**
   * Classify an error for deduplication and log-level decisions.
   *
   * @param err The error to classify
   */
  classifyError(err) {
    if (!(err instanceof Error)) {
      return "UNKNOWN";
    }
    const code = err.code;
    if (code === "UNAUTHORIZED") {
      return "UNAUTHORIZED";
    }
    if (code === "FORBIDDEN") {
      return "FORBIDDEN";
    }
    if (code === "RATE_LIMITED") {
      return "RATE_LIMITED";
    }
    if (code === "ENOTFOUND" || code === "ECONNREFUSED" || code === "ECONNRESET" || code === "ENETUNREACH" || code === "EHOSTUNREACH" || code === "EAI_AGAIN") {
      return "NETWORK";
    }
    if (code === "ETIMEDOUT") {
      return "TIMEOUT";
    }
    return code || "UNKNOWN";
  }
  /**
   * L3: fetch containers without letting a failure poison the whole poll. A 403
   * (the configured user lacks permission for the `containers` collection) or a
   * transient error used to reject the poll's `Promise.all` and freeze EVERY
   * system's states. Now it degrades to an empty list (like the non-fatal
   * system_details fetch), warning once then tracing.
   *
   * @param config Adapter configuration (containers only fetched when enabled).
   */
  async fetchContainersSafe(config) {
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
      const code = this.classifyError(err);
      const msg = `Container fetch failed (non-fatal, ${code}) \u2014 other metrics still update. Check the configured user's permission for the containers collection.`;
      if (this.containersUnavailable) {
        this.log.debug(msg);
      } else {
        this.log.warn(msg);
        this.containersUnavailable = true;
      }
      return [];
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
  async writeRollup(total, online) {
    if (!this.rollupCreated) {
      await this.setObjectNotExistsAsync("info.systemsTotal", {
        type: "state",
        common: {
          name: import_adapter_core.I18n.getTranslatedObject("systemsTotal"),
          type: "number",
          role: "value",
          read: true,
          write: false
        },
        native: {}
      });
      await this.setObjectNotExistsAsync("info.systemsOnline", {
        type: "state",
        common: {
          name: import_adapter_core.I18n.getTranslatedObject("systemsOnline"),
          type: "number",
          role: "value",
          read: true,
          write: false
        },
        native: {}
      });
      await this.setObjectNotExistsAsync("info.systemsAllUp", {
        type: "state",
        common: {
          name: import_adapter_core.I18n.getTranslatedObject("systemsAllUp"),
          type: "boolean",
          role: "indicator",
          read: true,
          write: false
        },
        native: {}
      });
      this.rollupCreated = true;
    }
    await this.setStateChangedAsync("info.systemsTotal", { val: total, ack: true });
    await this.setStateChangedAsync("info.systemsOnline", { val: online, ack: true });
    await this.setStateChangedAsync("info.systemsAllUp", { val: total > 0 && online === total, ack: true });
  }
  async poll() {
    if (this.isPolling) {
      this.log.debug("Skipping poll \u2014 previous poll still running");
      return;
    }
    if (!this.client || !this.stateManager) {
      return;
    }
    this.log.debug(`poll: starting (lastErrorCode='${this.lastErrorCode}', lastSystemCount=${this.lastSystemCount})`);
    this.isPolling = true;
    try {
      const config = this.config;
      const [systems, containers, statsMap] = await Promise.all([
        this.client.getSystems(),
        this.fetchContainersSafe(config),
        this.client.getLatestStats()
      ]);
      await this.setStateChangedAsync("info.connection", { val: true, ack: true });
      await this.fetchAndAttachDetails(systems, config);
      this.stateManager.prepareForPoll(systems);
      await Promise.all(
        systems.map(async (system) => {
          try {
            const stats = statsMap.get(system.id);
            this.log.debug(
              `updateSystem: '${(0, import_coerce.sanitizeForLog)(system.name)}' (id=${system.id.slice(0, 8)}, hasStats=${!!stats})`
            );
            await this.stateManager.updateSystem(system, stats, containers, config);
            this.failedSystems.delete(system.id);
          } catch (err) {
            const msg = `Failed to update system '${(0, import_coerce.sanitizeForLog)(system.name)}': ${(0, import_coerce.errText)(err)}`;
            if (this.failedSystems.has(system.id)) {
              this.log.debug(msg);
            } else {
              this.log.warn(msg);
              this.failedSystems.add(system.id);
            }
          }
        })
      );
      if (systems.length > 0) {
        await this.stateManager.cleanupSystems(systems.map((s) => s.name));
        const activeIds = new Set(systems.map((s) => s.id));
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
        await this.writeRollup(systems.length, systems.filter((s) => s.status === "up").length);
      }
      this.lastSystemCount = systems.length;
      this.authFailCount = 0;
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
  async fetchAndAttachDetails(systems, config) {
    if (!config.metrics_agentVersion) {
      return;
    }
    const needFetch = (0, import_coerce.shouldFetchSystemDetails)(
      systems.map((s) => s.id),
      this.detailsAttempted
    );
    if (needFetch) {
      let markAttempted = true;
      try {
        this.systemDetails = await this.client.getSystemDetails();
        this.log.debug(`system_details: fetched ${this.systemDetails.size} record(s)`);
      } catch (err) {
        const code = this.classifyError(err);
        markAttempted = code !== "NETWORK" && code !== "TIMEOUT";
        this.log.debug(
          `system_details fetch failed (non-fatal, ${code}, willRetry=${!markAttempted}): ${(0, import_coerce.errText)(err)}`
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
  handlePollError(err) {
    var _a;
    const errMsg = (0, import_coerce.errText)(err);
    const errorCode = this.classifyError(err);
    const isRepeat = errorCode === this.lastErrorCode;
    this.lastErrorCode = errorCode;
    if (errorCode === "UNAUTHORIZED") {
      (_a = this.client) == null ? void 0 : _a.invalidateToken();
      this.authFailCount++;
      if (this.authFailCount <= 3) {
        this.log.error("Authentication failed \u2014 check username and password");
      } else if (this.authFailCount === 4) {
        this.log.error("Authentication keeps failing \u2014 suppressing further auth errors");
      } else {
        this.log.debug(`Auth still failing (attempt ${this.authFailCount})`);
      }
    } else if (isRepeat) {
      this.log.debug(`Poll failed (ongoing): ${errMsg}`);
    } else if (errorCode === "FORBIDDEN") {
      this.log.error(
        `Beszel Hub returned 403 Forbidden \u2014 the configured user has no permission for these collections. Check the user role on the Hub admin UI.`
      );
    } else if (errorCode === "RATE_LIMITED") {
      this.log.warn("Beszel Hub rate-limited the request \u2014 slowing down. Consider increasing the poll interval.");
    } else if (errorCode === "NETWORK") {
      this.log.warn("Cannot reach Beszel Hub \u2014 will keep retrying");
    } else {
      this.log.error(`Poll failed (${errorCode})`);
      this.log.debug(`Poll failed: ${errMsg}`);
    }
    void this.setStateChangedAsync("info.connection", { val: false, ack: true }).catch(() => {
    });
  }
}
if (require.main !== module) {
  module.exports = (options) => new BeszelAdapter(options);
} else {
  (() => new BeszelAdapter())();
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  BeszelAdapter
});
//# sourceMappingURL=main.js.map
