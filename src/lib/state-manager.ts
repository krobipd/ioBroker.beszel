import type * as utils from "@iobroker/adapter-core";
import type {
  AdapterConfig,
  BeszelContainer,
  BeszelSystem,
  SystemStats,
} from "./types.js";

/**
 * Manages creation, update and cleanup of ioBroker objects and states for Beszel systems.
 */
export class StateManager {
  private readonly adapter: utils.AdapterInstance;

  /**
   * @param adapter The ioBroker adapter instance
   */
  constructor(adapter: utils.AdapterInstance) {
    this.adapter = adapter;
  }

  /**
   * Sanitize a name to a valid ioBroker state ID segment (see adapter.FORBIDDEN_CHARS).
   * Lowercase, replace non-alphanumeric with _, max 50 chars, trim underscores.
   *
   * @param name Raw name to sanitize
   */
  public sanitize(name: string): string {
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 50);
  }

  /**
   * Return sanitized names of all existing system devices.
   */
  public async getExistingSystemNames(): Promise<string[]> {
    const objects = await this.adapter.getObjectViewAsync("system", "device", {
      startkey: `${this.adapter.namespace}.systems.`,
      endkey: `${this.adapter.namespace}.systems.\u9999`,
    });
    if (!objects?.rows) {
      return [];
    }
    const names: string[] = [];
    for (const row of objects.rows) {
      const id = row.id.startsWith(`${this.adapter.namespace}.`)
        ? row.id.slice(this.adapter.namespace.length + 1)
        : row.id;
      const parts = id.split(".");
      if (parts.length === 2 && parts[0] === "systems") {
        names.push(parts[1]);
      }
    }
    return names;
  }

  /**
   * Update all states for a single system.
   *
   * @param system Beszel system record
   * @param stats Latest stats for this system, or undefined if unavailable
   * @param containers Container records belonging to this system
   * @param config Current adapter configuration
   */
  public async updateSystem(
    system: BeszelSystem,
    stats: SystemStats | undefined,
    containers: BeszelContainer[],
    config: AdapterConfig,
  ): Promise<void> {
    const sysId = `systems.${this.sanitize(system.name)}`;

    // Create/update device object with online indicator
    await this.adapter.extendObjectAsync(sysId, {
      type: "device",
      common: {
        name: system.name,
        statusStates: {
          onlineId: `${this.adapter.namespace}.${sysId}.info.online`,
        },
      } as ioBroker.DeviceCommon,
      native: { id: system.id, host: system.host },
    });

    // Info channel (always created)
    await this.ensureChannel(`${sysId}.info`, "Info");

    // Always: online + status
    await this.createAndSetState(
      `${sysId}.info.online`,
      this.boolCommon("Online", "indicator.reachable"),
      system.status === "up",
    );
    await this.createAndSetState(
      `${sysId}.info.status`,
      this.textCommon("Status"),
      system.status,
    );

    // Uptime
    if (config.metrics_uptime) {
      const uptime = system.info.u ?? null;
      await this.createAndSetState(
        `${sysId}.info.uptime`,
        this.numCommon("Uptime", "s"),
        uptime,
      );
      await this.createAndSetState(
        `${sysId}.info.uptime_text`,
        this.textCommon("Uptime (formatted)"),
        uptime !== null ? this.formatUptime(uptime) : null,
      );
    }

    // Agent version
    if (config.metrics_agentVersion) {
      await this.createAndSetState(
        `${sysId}.info.agent_version`,
        this.textCommon("Agent Version"),
        system.info.v ?? null,
      );
    }

    // Systemd services
    if (config.metrics_services) {
      const sv = system.info.sv;
      await this.createAndSetState(
        `${sysId}.info.services_total`,
        this.numCommon("Services Total"),
        sv?.[0] ?? null,
      );
      await this.createAndSetState(
        `${sysId}.info.services_failed`,
        this.numCommon("Services Failed"),
        sv?.[1] ?? null,
      );
    }

    // Stats-based metrics (only if stats available)
    if (stats) {
      await this.updateStatsStates(sysId, system, stats, config);
    }

    // Load avg fallback to system.info.la if no stats
    if (config.metrics_loadAvg && !stats) {
      await this.ensureChannel(`${sysId}.cpu`, "CPU");
      await this.createLoadAvgStates(sysId, system.info.la);
    }

    // Containers
    if (config.metrics_containers) {
      await this.updateContainers(sysId, system.id, containers);
    }
  }

  /**
   * Remove device objects for systems that are no longer in Beszel.
   *
   * @param activeSystemNames Sanitized names of currently active systems
   */
  public async cleanupSystems(activeSystemNames: string[]): Promise<void> {
    const activeSet = new Set(activeSystemNames.map((n) => this.sanitize(n)));
    const existing = await this.getExistingSystemNames();

    for (const name of existing) {
      if (!activeSet.has(name)) {
        this.adapter.log.debug(`Removing stale system: systems.${name}`);
        await this.adapter.delObjectAsync(`systems.${name}`, {
          recursive: true,
        });
      }
    }
  }

  /**
   * Delete states for metrics that have been disabled in the config.
   * Called on startup to clean up previously-enabled states.
   *
   * @param systemId Sanitized system name (the part after "systems.")
   * @param config Current adapter configuration
   */
  public async cleanupMetrics(
    systemId: string,
    config: AdapterConfig,
  ): Promise<void> {
    const sysId = `systems.${systemId}`;
    const toDelete: string[] = [];

    if (!config.metrics_uptime) {
      toDelete.push(`${sysId}.info.uptime`, `${sysId}.info.uptime_text`);
    }
    if (!config.metrics_agentVersion) {
      toDelete.push(`${sysId}.info.agent_version`);
    }
    if (!config.metrics_services) {
      toDelete.push(
        `${sysId}.info.services_total`,
        `${sysId}.info.services_failed`,
      );
    }
    if (!config.metrics_cpu) {
      toDelete.push(`${sysId}.cpu.usage`);
    }
    if (!config.metrics_loadAvg) {
      toDelete.push(
        `${sysId}.cpu.load_1m`,
        `${sysId}.cpu.load_5m`,
        `${sysId}.cpu.load_15m`,
      );
    }
    if (!config.metrics_cpuBreakdown) {
      toDelete.push(
        `${sysId}.cpu.user`,
        `${sysId}.cpu.system`,
        `${sysId}.cpu.iowait`,
        `${sysId}.cpu.steal`,
        `${sysId}.cpu.idle`,
      );
    }
    if (!config.metrics_memory) {
      toDelete.push(
        `${sysId}.memory.percent`,
        `${sysId}.memory.used`,
        `${sysId}.memory.total`,
      );
    }
    if (!config.metrics_memoryDetails) {
      toDelete.push(`${sysId}.memory.buffers`, `${sysId}.memory.zfs_arc`);
    }
    if (!config.metrics_swap) {
      toDelete.push(`${sysId}.memory.swap_used`, `${sysId}.memory.swap_total`);
    }
    if (!config.metrics_disk) {
      toDelete.push(
        `${sysId}.disk.percent`,
        `${sysId}.disk.used`,
        `${sysId}.disk.total`,
      );
    }
    if (!config.metrics_diskSpeed) {
      toDelete.push(`${sysId}.disk.read`, `${sysId}.disk.write`);
    }
    if (!config.metrics_network) {
      toDelete.push(`${sysId}.network.sent`, `${sysId}.network.recv`);
    }
    if (!config.metrics_temperature) {
      toDelete.push(`${sysId}.temperature.average`);
    }
    if (!config.metrics_battery) {
      toDelete.push(`${sysId}.battery.percent`, `${sysId}.battery.charging`);
    }

    for (const id of toDelete) {
      const obj = await this.adapter.getObjectAsync(id);
      if (obj) {
        await this.adapter.delObjectAsync(id);
      }
    }

    // Delete empty channels when all metrics in a group are disabled
    const noCpu =
      !config.metrics_cpu &&
      !config.metrics_loadAvg &&
      !config.metrics_cpuBreakdown;
    if (noCpu) {
      await this.deleteChannelIfExists(`${sysId}.cpu`);
    }

    const noMemory =
      !config.metrics_memory &&
      !config.metrics_memoryDetails &&
      !config.metrics_swap;
    if (noMemory) {
      await this.deleteChannelIfExists(`${sysId}.memory`);
    }

    const noDisk = !config.metrics_disk && !config.metrics_diskSpeed;
    if (noDisk) {
      await this.deleteChannelIfExists(`${sysId}.disk`);
    }

    if (!config.metrics_network) {
      await this.deleteChannelIfExists(`${sysId}.network`);
    }

    const noTemp =
      !config.metrics_temperature && !config.metrics_temperatureDetails;
    if (noTemp) {
      await this.deleteChannelIfExists(`${sysId}.temperature`);
    }

    if (!config.metrics_battery) {
      await this.deleteChannelIfExists(`${sysId}.battery`);
    }

    // Sub-channels
    if (!config.metrics_temperatureDetails) {
      await this.deleteChannelIfExists(`${sysId}.temperature.sensors`);
    }
    if (!config.metrics_gpu) {
      await this.deleteChannelIfExists(`${sysId}.gpu`);
    }
    if (!config.metrics_extraFs) {
      await this.deleteChannelIfExists(`${sysId}.filesystems`);
    }
    if (!config.metrics_containers) {
      await this.deleteChannelIfExists(`${sysId}.containers`);
    }
  }

  /**
   * Remove legacy flat state paths from pre-0.3.0 installations.
   * Must be called once during onReady before the first poll.
   */
  public async migrateLegacyStates(): Promise<void> {
    const existingNames = await this.getExistingSystemNames();
    if (existingNames.length === 0) {
      return;
    }

    // Old flat state IDs that moved into channels
    const legacyStates = [
      "online",
      "status",
      "uptime",
      "uptime_text",
      "agent_version",
      "services_total",
      "services_failed",
      "cpu_usage",
      "load_avg_1m",
      "load_avg_5m",
      "load_avg_15m",
      "cpu_user",
      "cpu_system",
      "cpu_iowait",
      "cpu_steal",
      "cpu_idle",
      "memory_percent",
      "memory_used",
      "memory_total",
      "buffers",
      "zfs_arc",
      "swap_used",
      "swap_total",
      "disk_percent",
      "disk_used",
      "disk_total",
      "disk_read",
      "disk_write",
      "network_sent",
      "network_recv",
      "temperature",
      "battery_percent",
      "battery_charging",
    ];

    let migrated = 0;

    for (const name of existingNames) {
      const sysId = `systems.${name}`;

      // Delete flat states (only if they are actual states, not new channels)
      for (const stateId of legacyStates) {
        const fullId = `${sysId}.${stateId}`;
        const obj = await this.adapter.getObjectAsync(fullId);
        if (obj && obj.type === "state") {
          await this.adapter.delObjectAsync(fullId);
          migrated++;
        }
      }

      // Old "temperatures" channel → now "temperature.sensors"
      await this.deleteChannelIfExists(`${sysId}.temperatures`);
    }

    if (migrated > 0) {
      this.adapter.log.info(
        `Migration: removed ${migrated} legacy state(s) from flat structure`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async updateStatsStates(
    sysId: string,
    system: BeszelSystem,
    stats: SystemStats,
    config: AdapterConfig,
  ): Promise<void> {
    // Ensure channels for enabled metric groups
    if (
      config.metrics_cpu ||
      config.metrics_loadAvg ||
      config.metrics_cpuBreakdown
    ) {
      await this.ensureChannel(`${sysId}.cpu`, "CPU");
    }
    if (
      config.metrics_memory ||
      config.metrics_memoryDetails ||
      config.metrics_swap
    ) {
      await this.ensureChannel(`${sysId}.memory`, "Memory");
    }
    if (config.metrics_disk || config.metrics_diskSpeed) {
      await this.ensureChannel(`${sysId}.disk`, "Disk");
    }
    if (config.metrics_network) {
      await this.ensureChannel(`${sysId}.network`, "Network");
    }
    if (config.metrics_temperature || config.metrics_temperatureDetails) {
      await this.ensureChannel(`${sysId}.temperature`, "Temperature");
    }
    if (config.metrics_battery) {
      await this.ensureChannel(`${sysId}.battery`, "Battery");
    }

    // CPU
    if (config.metrics_cpu) {
      await this.createAndSetState(
        `${sysId}.cpu.usage`,
        this.percentCommon("CPU Usage"),
        stats.cpu ?? null,
      );
    }

    // Load avg — prefer stats.la, fallback to system.info.la
    if (config.metrics_loadAvg) {
      await this.createLoadAvgStates(sysId, stats.la ?? system.info.la);
    }

    // CPU breakdown
    if (config.metrics_cpuBreakdown && stats.cpub && stats.cpub.length >= 5) {
      const [user, sys, iowait, steal, idle] = stats.cpub;
      await this.createAndSetState(
        `${sysId}.cpu.user`,
        this.percentCommon("CPU User %"),
        user,
      );
      await this.createAndSetState(
        `${sysId}.cpu.system`,
        this.percentCommon("CPU System %"),
        sys,
      );
      await this.createAndSetState(
        `${sysId}.cpu.iowait`,
        this.percentCommon("CPU IOWait %"),
        iowait,
      );
      await this.createAndSetState(
        `${sysId}.cpu.steal`,
        this.percentCommon("CPU Steal %"),
        steal,
      );
      await this.createAndSetState(
        `${sysId}.cpu.idle`,
        this.percentCommon("CPU Idle %"),
        idle,
      );
    }

    // Memory
    if (config.metrics_memory) {
      await this.createAndSetState(
        `${sysId}.memory.percent`,
        this.percentCommon("Memory %"),
        stats.mp ?? null,
      );
      await this.createAndSetState(
        `${sysId}.memory.used`,
        this.numCommon("Memory Used", "GB"),
        stats.mu ?? null,
      );
      await this.createAndSetState(
        `${sysId}.memory.total`,
        this.numCommon("Memory Total", "GB"),
        stats.m ?? null,
      );
    }

    // Memory details
    if (config.metrics_memoryDetails) {
      await this.createAndSetState(
        `${sysId}.memory.buffers`,
        this.numCommon("Memory Buffers+Cache", "GB"),
        stats.mb ?? null,
      );
      await this.createAndSetState(
        `${sysId}.memory.zfs_arc`,
        this.numCommon("Memory ZFS ARC", "GB"),
        stats.mz ?? null,
      );
    }

    // Swap
    if (config.metrics_swap) {
      await this.createAndSetState(
        `${sysId}.memory.swap_used`,
        this.numCommon("Swap Used", "GB"),
        stats.su ?? null,
      );
      await this.createAndSetState(
        `${sysId}.memory.swap_total`,
        this.numCommon("Swap Total", "GB"),
        stats.s ?? null,
      );
    }

    // Disk
    if (config.metrics_disk) {
      await this.createAndSetState(
        `${sysId}.disk.percent`,
        this.percentCommon("Disk %"),
        stats.dp ?? null,
      );
      await this.createAndSetState(
        `${sysId}.disk.used`,
        this.numCommon("Disk Used", "GB"),
        stats.du ?? null,
      );
      await this.createAndSetState(
        `${sysId}.disk.total`,
        this.numCommon("Disk Total", "GB"),
        stats.d ?? null,
      );
    }

    // Disk speed
    if (config.metrics_diskSpeed) {
      await this.createAndSetState(
        `${sysId}.disk.read`,
        this.numCommon("Disk Read", "MB/s"),
        stats.dr ?? null,
      );
      await this.createAndSetState(
        `${sysId}.disk.write`,
        this.numCommon("Disk Write", "MB/s"),
        stats.dw ?? null,
      );
    }

    // Network
    if (config.metrics_network) {
      await this.createAndSetState(
        `${sysId}.network.sent`,
        this.numCommon("Network Sent", "MB/s"),
        stats.ns ?? null,
      );
      await this.createAndSetState(
        `${sysId}.network.recv`,
        this.numCommon("Network Received", "MB/s"),
        stats.nr ?? null,
      );
    }

    // Temperature (average of top 3)
    if (config.metrics_temperature) {
      await this.createAndSetState(
        `${sysId}.temperature.average`,
        this.numCommon("Temperature (avg top 3)", "°C", "value.temperature"),
        this.computeTopAvgTemp(stats.t),
      );
    }

    // Temperature details
    if (config.metrics_temperatureDetails && stats.t) {
      await this.ensureChannel(`${sysId}.temperature.sensors`, "Sensors");
      for (const [sensor, temp] of Object.entries(stats.t)) {
        await this.createAndSetState(
          `${sysId}.temperature.sensors.${this.sanitize(sensor)}`,
          this.numCommon(sensor, "°C", "value.temperature"),
          temp,
        );
      }
    }

    // Battery
    if (config.metrics_battery) {
      const bat = stats.bat ?? system.info.bat;
      await this.createAndSetState(
        `${sysId}.battery.percent`,
        this.percentCommon("Battery %"),
        bat?.[0] ?? null,
      );
      await this.createAndSetState(
        `${sysId}.battery.charging`,
        this.boolCommon("Battery Charging"),
        bat ? bat[1] > 0 : null,
      );
    }

    // GPU
    if (config.metrics_gpu && stats.g && Object.keys(stats.g).length > 0) {
      await this.ensureChannel(`${sysId}.gpu`, "GPU");
      for (const [gpuId, gpuData] of Object.entries(stats.g)) {
        const safeId = this.sanitize(gpuId);
        await this.ensureChannel(`${sysId}.gpu.${safeId}`, gpuData.n ?? gpuId);
        await this.createAndSetState(
          `${sysId}.gpu.${safeId}.usage`,
          this.percentCommon("GPU Usage"),
          gpuData.u ?? null,
        );
        await this.createAndSetState(
          `${sysId}.gpu.${safeId}.memory_used`,
          this.numCommon("GPU Memory Used", "GB"),
          gpuData.mu ?? null,
        );
        await this.createAndSetState(
          `${sysId}.gpu.${safeId}.memory_total`,
          this.numCommon("GPU Memory Total", "GB"),
          gpuData.mt ?? null,
        );
        await this.createAndSetState(
          `${sysId}.gpu.${safeId}.power`,
          this.numCommon("GPU Power", "W"),
          gpuData.p ?? null,
        );
      }
    }

    // Extra filesystems
    if (
      config.metrics_extraFs &&
      stats.efs &&
      Object.keys(stats.efs).length > 0
    ) {
      await this.ensureChannel(`${sysId}.filesystems`, "Filesystems");
      for (const [fsName, fsData] of Object.entries(stats.efs)) {
        const safeId = this.sanitize(fsName);
        await this.ensureChannel(`${sysId}.filesystems.${safeId}`, fsName);

        const total = fsData.d ?? null;
        const used = fsData.du ?? null;
        const percent =
          total !== null && used !== null && total > 0
            ? Math.round((used / total) * 100)
            : null;

        await this.createAndSetState(
          `${sysId}.filesystems.${safeId}.disk_percent`,
          this.percentCommon("Disk %"),
          percent,
        );
        await this.createAndSetState(
          `${sysId}.filesystems.${safeId}.disk_used`,
          this.numCommon("Disk Used", "GB"),
          used,
        );
        await this.createAndSetState(
          `${sysId}.filesystems.${safeId}.disk_total`,
          this.numCommon("Disk Total", "GB"),
          total,
        );
        await this.createAndSetState(
          `${sysId}.filesystems.${safeId}.read_speed`,
          this.numCommon("Read Speed", "MB/s"),
          fsData.r ?? null,
        );
        await this.createAndSetState(
          `${sysId}.filesystems.${safeId}.write_speed`,
          this.numCommon("Write Speed", "MB/s"),
          fsData.w ?? null,
        );
      }
    }
  }

  private async updateContainers(
    sysId: string,
    systemId: string,
    allContainers: BeszelContainer[],
  ): Promise<void> {
    const sysContainers = allContainers.filter((c) => c.system === systemId);
    if (sysContainers.length === 0) {
      return;
    }

    await this.ensureChannel(`${sysId}.containers`, "Containers");

    const healthLabels = ["none", "starting", "healthy", "unhealthy"];

    for (const container of sysContainers) {
      const cId = this.sanitize(container.name);
      await this.ensureChannel(`${sysId}.containers.${cId}`, container.name);
      await this.createAndSetState(
        `${sysId}.containers.${cId}.status`,
        this.textCommon("Status"),
        container.status,
      );
      await this.createAndSetState(
        `${sysId}.containers.${cId}.health`,
        this.textCommon("Health"),
        healthLabels[container.health] ?? "unknown",
      );
      await this.createAndSetState(
        `${sysId}.containers.${cId}.cpu`,
        this.percentCommon("CPU Usage"),
        container.cpu,
      );
      await this.createAndSetState(
        `${sysId}.containers.${cId}.memory`,
        this.numCommon("Memory", "MB"),
        container.memory,
      );
      await this.createAndSetState(
        `${sysId}.containers.${cId}.image`,
        this.textCommon("Image"),
        container.image,
      );
    }
  }

  private async ensureChannel(id: string, name: string): Promise<void> {
    await this.adapter.setObjectNotExistsAsync(id, {
      type: "channel",
      common: { name } as ioBroker.ObjectCommon,
      native: {},
    });
  }

  private async deleteChannelIfExists(id: string): Promise<void> {
    try {
      const obj = await this.adapter.getObjectAsync(id);
      if (obj) {
        await this.adapter.delObjectAsync(id, { recursive: true });
      }
    } catch {
      // ignore
    }
  }

  /**
   * Create or update the three load average states.
   *
   * @param sysId State ID prefix (e.g. "systems.my_server")
   * @param la Load average tuple [1m, 5m, 15m], or undefined
   */
  private async createLoadAvgStates(
    sysId: string,
    la: [number, number, number] | undefined,
  ): Promise<void> {
    await this.createAndSetState(
      `${sysId}.cpu.load_1m`,
      this.numCommon("Load Average 1m"),
      la?.[0] ?? null,
    );
    await this.createAndSetState(
      `${sysId}.cpu.load_5m`,
      this.numCommon("Load Average 5m"),
      la?.[1] ?? null,
    );
    await this.createAndSetState(
      `${sysId}.cpu.load_15m`,
      this.numCommon("Load Average 15m"),
      la?.[2] ?? null,
    );
  }

  private async createAndSetState(
    id: string,
    common: ioBroker.StateCommon,
    value: ioBroker.StateValue,
  ): Promise<void> {
    await this.adapter.setObjectNotExistsAsync(id, {
      type: "state",
      common,
      native: {},
    });
    await this.adapter.setStateAsync(id, { val: value, ack: true });
  }

  // -------------------------------------------------------------------------
  // State common factories
  // -------------------------------------------------------------------------

  private percentCommon(name: string): ioBroker.StateCommon {
    return {
      name,
      type: "number",
      role: "value",
      unit: "%",
      min: 0,
      max: 100,
      read: true,
      write: false,
    } as ioBroker.StateCommon;
  }

  private numCommon(
    name: string,
    unit?: string,
    role = "value",
  ): ioBroker.StateCommon {
    return {
      name,
      type: "number",
      role,
      unit,
      read: true,
      write: false,
    } as ioBroker.StateCommon;
  }

  private textCommon(name: string): ioBroker.StateCommon {
    return {
      name,
      type: "string",
      role: "text",
      read: true,
      write: false,
    } as ioBroker.StateCommon;
  }

  private boolCommon(name: string, role = "indicator"): ioBroker.StateCommon {
    return {
      name,
      type: "boolean",
      role,
      read: true,
      write: false,
    } as ioBroker.StateCommon;
  }

  // -------------------------------------------------------------------------
  // Computation helpers
  // -------------------------------------------------------------------------

  private computeTopAvgTemp(
    temps: Record<string, number> | undefined,
  ): number | null {
    if (!temps) {
      return null;
    }
    const values = Object.values(temps).filter(
      (v) => typeof v === "number" && isFinite(v),
    );
    if (values.length === 0) {
      return null;
    }
    values.sort((a, b) => b - a);
    const top3 = values.slice(0, 3);
    const avg = top3.reduce((sum, v) => sum + v, 0) / top3.length;
    return Math.round(avg * 10) / 10;
  }

  private formatUptime(seconds: number): string {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor((seconds % 86400) / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const parts: string[] = [];
    if (d > 0) {
      parts.push(`${d}d`);
    }
    if (h > 0) {
      parts.push(`${h}h`);
    }
    if (m > 0 || parts.length === 0) {
      parts.push(`${m}m`);
    }
    return parts.join(" ");
  }
}
