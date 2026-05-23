"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
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
  pollTimer = void 0;
  isPolling = false;
  lastSystemCount = 0;
  lastErrorCode = "";
  authFailCount = 0;
  failedSystems = /* @__PURE__ */ new Set();
  /**
   * v0.4.5: short-lived test-clients spawned from `checkConnection` admin
   * messages. The prod-`this.client` is what `onUnload` cancels, so these
   * need their own registry to be reachable at shutdown. Entries are added
   * by `message-router`'s `onTestClientCreated` hook and removed once
   * `checkConnection` settles.
   */
  testClients = /* @__PURE__ */ new Set();
  unhandledRejectionHandler = null;
  uncaughtExceptionHandler = null;
  constructor(options = {}) {
    super({
      ...options,
      name: "beszel"
    });
    this.on("ready", this.onReady.bind(this));
    this.on("unload", this.onUnload.bind(this));
    this.on("message", this.onMessage.bind(this));
    this.unhandledRejectionHandler = (reason) => {
      var _a;
      this.log.error(`Unhandled rejection: ${(0, import_coerce.errText)(reason)}`);
      (_a = this.terminate) == null ? void 0 : _a.call(this, 11);
    };
    this.uncaughtExceptionHandler = (err) => {
      var _a;
      this.log.error(`Uncaught exception: ${(0, import_coerce.errText)(err)}`);
      (_a = this.terminate) == null ? void 0 : _a.call(this, 11);
    };
    process.on("unhandledRejection", this.unhandledRejectionHandler);
    process.on("uncaughtException", this.uncaughtExceptionHandler);
  }
  async onReady() {
    try {
      await import_adapter_core.I18n.init((0, import_node_path.join)(this.adapterDir, "admin"), this);
      const config = this.config;
      this.log.debug(
        `onReady: starting (url='${config.url}', pollInterval=${JSON.stringify(config.pollInterval)}s, requestTimeout=${JSON.stringify(config.requestTimeout)}s)`
      );
      await this.setStateAsync("info.connection", { val: false, ack: true });
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
      const timeoutMs = (0, import_coerce.coerceTimeoutMs)(config.requestTimeout);
      this.log.debug(`timeoutMs: raw=${JSON.stringify(config.requestTimeout)} resolved=${timeoutMs}ms`);
      this.client = new import_beszel_client.BeszelClient(config.url, config.username, config.password, timeoutMs, {
        debug: (m) => this.log.debug(m),
        warn: (m) => this.log.warn(m)
      });
      this.stateManager = new import_state_manager.StateManager(this);
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
      if (this.unhandledRejectionHandler) {
        process.off("unhandledRejection", this.unhandledRejectionHandler);
        this.unhandledRejectionHandler = null;
      }
      if (this.uncaughtExceptionHandler) {
        process.off("uncaughtException", this.uncaughtExceptionHandler);
        this.uncaughtExceptionHandler = null;
      }
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
        createTestClient: (0, import_message_router.makeTestClientFactory)({
          debug: (m) => this.log.debug(m),
          warn: (m) => this.log.warn(m)
        }),
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
    if (code === "ETIMEDOUT" || err.message.includes("timed out")) {
      return "TIMEOUT";
    }
    return code || "UNKNOWN";
  }
  async poll() {
    var _a;
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
        config.metrics_containers ? this.client.getContainers() : Promise.resolve([]),
        this.client.getLatestStats()
      ]);
      await this.setStateAsync("info.connection", { val: true, ack: true });
      this.stateManager.prepareForPoll(systems);
      await Promise.all(
        systems.map(async (system) => {
          try {
            const stats = statsMap.get(system.id);
            this.log.debug(`updateSystem: '${system.name}' (id=${system.id.slice(0, 8)}, hasStats=${!!stats})`);
            await this.stateManager.updateSystem(system, stats, containers, config);
            this.failedSystems.delete(system.name);
          } catch (err) {
            const msg = `Failed to update system '${system.name}': ${(0, import_coerce.errText)(err)}`;
            if (this.failedSystems.has(system.name)) {
              this.log.debug(msg);
            } else {
              this.log.warn(msg);
              this.failedSystems.add(system.name);
            }
          }
        })
      );
      if (systems.length > 0 || this.lastSystemCount === 0) {
        await this.stateManager.cleanupSystems(systems.map((s) => s.name));
      }
      this.lastSystemCount = systems.length;
      this.authFailCount = 0;
      if (this.lastErrorCode) {
        this.log.info("Connection restored");
        this.lastErrorCode = "";
      }
      this.log.debug(`Polled ${systems.length} systems successfully`);
    } catch (err) {
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
        this.log.error(`Poll failed: ${errMsg}`);
      }
      await this.setStateAsync("info.connection", { val: false, ack: true });
    } finally {
      this.isPolling = false;
    }
  }
}
if (require.main !== module) {
  module.exports = (options) => new BeszelAdapter(options);
} else {
  (() => new BeszelAdapter())();
}
//# sourceMappingURL=main.js.map
