import * as utils from "@iobroker/adapter-core";
import { BeszelClient } from "./lib/beszel-client.js";
import { StateManager } from "./lib/state-manager.js";
import type { AdapterConfig } from "./lib/types.js";

class BeszelAdapter extends utils.Adapter {
  private client: BeszelClient | null = null;
  private stateManager: StateManager | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private isPolling = false;
  private lastSystemCount = 0;

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
        "Beszel adapter: URL, username, and password are required. Please configure the adapter.",
      );
      return;
    }

    this.client = new BeszelClient(
      config.url,
      config.username,
      config.password,
    );
    this.stateManager = new StateManager(this);

    // Cleanup disabled metric states for existing systems (config may have changed)
    const existingObjects = await this.getObjectViewAsync("system", "device", {
      startkey: `${this.namespace}.systems.`,
      endkey: `${this.namespace}.systems.\u9999`,
    });
    if (existingObjects?.rows) {
      for (const row of existingObjects.rows) {
        const relId = row.id.startsWith(`${this.namespace}.`)
          ? row.id.slice(this.namespace.length + 1)
          : row.id;
        const parts = relId.split(".");
        if (parts.length === 2 && parts[0] === "systems") {
          await this.stateManager.cleanupMetrics(parts[1], config);
        }
      }
    }

    // Initial poll
    await this.poll();

    // Set up recurring poll
    const intervalMs = Math.max(10, config.pollInterval ?? 60) * 1000;
    this.pollTimer = setInterval(() => {
      void this.poll();
    }, intervalMs);

    this.log.info(
      `Beszel adapter started — ${this.lastSystemCount} system(s), polling every ${config.pollInterval ?? 60}s`,
    );
  }

  private async onUnload(callback: () => void): Promise<void> {
    try {
      if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = null;
      }
      await this.setStateAsync("info.connection", { val: false, ack: true });
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

      // Cleanup stale systems
      await this.stateManager.cleanupSystems(systems.map((s) => s.name));

      this.lastSystemCount = systems.length;
      this.log.debug(`Polled ${systems.length} systems successfully`);
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.log.error(`Poll failed: ${errMsg}`);

      // On 401, invalidate token so next poll re-authenticates
      if (
        err instanceof Error &&
        (err as NodeJS.ErrnoException).code === "UNAUTHORIZED"
      ) {
        this.client?.invalidateToken();
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
