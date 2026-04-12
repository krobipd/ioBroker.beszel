import * as utils from "@iobroker/adapter-core";
import { BeszelClient } from "./lib/beszel-client.js";
import { StateManager } from "./lib/state-manager.js";
import type { AdapterConfig } from "./lib/types.js";

class BeszelAdapter extends utils.Adapter {
  private client: BeszelClient | null = null;
  private stateManager: StateManager | null = null;
  private pollTimer: ioBroker.Interval | undefined = undefined;
  private isPolling = false;
  private lastSystemCount = 0;
  private lastErrorCode = "";
  private authFailCount = 0;

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
    const config = this.config as unknown as AdapterConfig;

    // Ensure info objects exist before any setState calls
    await this.setObjectNotExistsAsync("info", {
      type: "channel",
      common: { name: "Information" },
      native: {},
    });
    await this.setObjectNotExistsAsync("info.connection", {
      type: "state",
      common: {
        name: "Connection status",
        type: "boolean",
        role: "indicator.connected",
        read: true,
        write: false,
        def: false,
      },
      native: {},
    });
    await this.setStateAsync("info.connection", { val: false, ack: true });

    // Validate required config
    if (!config.url || !config.username || !config.password) {
      this.log.error(
        "URL, username, and password are required — please configure the adapter settings",
      );
      return;
    }

    this.client = new BeszelClient(
      config.url,
      config.username,
      config.password,
    );
    this.stateManager = new StateManager(this);

    // Migrate legacy flat state paths from pre-0.3.0
    await this.stateManager.migrateLegacyStates();

    // Cleanup disabled metric states for existing systems (config may have changed)
    for (const name of await this.stateManager.getExistingSystemNames()) {
      await this.stateManager.cleanupMetrics(name, config);
    }

    // Initial poll
    await this.poll();

    // Set up recurring poll
    const intervalMs = Math.max(10, config.pollInterval ?? 60) * 1000;
    this.pollTimer = this.setInterval(() => {
      void this.poll();
    }, intervalMs);

    this.log.info(
      `Beszel adapter started — ${this.lastSystemCount} system(s), polling every ${config.pollInterval ?? 60}s`,
    );
  }

  private onUnload(callback: () => void): void {
    try {
      if (this.pollTimer) {
        this.clearInterval(this.pollTimer);
        this.pollTimer = undefined;
      }
      void this.setState("info.connection", { val: false, ack: true });
    } catch {
      // ignore
    }
    callback();
  }

  private async onMessage(obj: ioBroker.Message): Promise<void> {
    if (obj.command === "checkConnection") {
      const config = obj.message as Partial<AdapterConfig>;
      const url = config.url ?? "";
      const username = config.username ?? "";
      const password = config.password ?? "";

      if (!url || !username || !password) {
        this.sendTo(
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

      const testClient = new BeszelClient(url, username, password);
      const result = await testClient.checkConnection();
      this.sendTo(obj.from, obj.command, result, obj.callback);
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
    if (
      code === "ENOTFOUND" ||
      code === "ECONNREFUSED" ||
      code === "ECONNRESET" ||
      code === "ENETUNREACH" ||
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

    this.isPolling = true;
    try {
      const config = this.config as unknown as AdapterConfig;

      // Fetch all data
      const [systems, containers] = await Promise.all([
        this.client.getSystems(),
        config.metrics_containers
          ? this.client.getContainers()
          : Promise.resolve([]),
      ]);

      const systemIds = systems.map((s) => s.id);
      const statsMap = await this.client.getLatestStats(systemIds);

      // Update connection state
      await this.setStateAsync("info.connection", { val: true, ack: true });

      // Update each system
      for (const system of systems) {
        const stats = statsMap.get(system.id);
        await this.stateManager.updateSystem(system, stats, containers, config);
      }

      // Cleanup stale systems — but only if we actually got results.
      // An empty list during a transient API issue must NOT wipe all devices.
      if (systems.length > 0 || this.lastSystemCount === 0) {
        await this.stateManager.cleanupSystems(systems.map((s) => s.name));
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
      const errMsg = err instanceof Error ? err.message : String(err);
      const errorCode = this.classifyError(err);
      const isRepeat = errorCode === this.lastErrorCode;
      this.lastErrorCode = errorCode;

      if (errorCode === "UNAUTHORIZED") {
        this.client?.invalidateToken();
        this.authFailCount++;
        if (this.authFailCount <= 3) {
          this.log.error("Authentication failed — check username and password");
        } else if (this.authFailCount === 4) {
          this.log.error(
            "Authentication keeps failing — suppressing further auth errors",
          );
        } else {
          this.log.debug(`Auth still failing (attempt ${this.authFailCount})`);
        }
      } else if (isRepeat) {
        this.log.debug(`Poll failed (ongoing): ${errMsg}`);
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
  module.exports = (options: Partial<utils.AdapterOptions> | undefined) =>
    new BeszelAdapter(options);
} else {
  (() => new BeszelAdapter())();
}
