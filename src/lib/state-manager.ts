import type * as utils from "@iobroker/adapter-core";
import { errText } from "./coerce";
import { tName } from "./i18n-states";
import type { AdapterConfig, BeszelContainer, BeszelSystem, SystemStats } from "./types";

/**
 * Cast helper: ioBroker's `common.name` accepts string or translation object,
 * but the bundled `@types/iobroker` declarations vary by version, so we cast
 * once here and use `LocalizedName` everywhere.
 */
type LocalizedName = ioBroker.StringOrTranslated;

/**
 * Manages creation, update and cleanup of ioBroker objects and states for Beszel systems.
 */
export class StateManager {
  private readonly adapter: utils.AdapterInstance;
  /**
   * Tracks IDs we already created via `setObjectNotExistsAsync`. Skipping the
   * call on subsequent polls avoids a redundant js-controller round-trip per
   * state per system per minute.
   */
  private readonly createdIds = new Set<string>();

  /**
   * v0.4.3 (SM5): per-poll resolved safeName per system.id. Built once via
   * `prepareForPoll(systems)` before per-system updates run in parallel.
   */
  private readonly resolvedSafeNames = new Map<string, string>();

  /**
   * @param adapter The ioBroker adapter instance
   */
  constructor(adapter: utils.AdapterInstance) {
    this.adapter = adapter;
  }

  /**
   * Sanitize a name to a valid ioBroker state ID segment (see adapter.FORBIDDEN_CHARS).
   * Lowercase, replace non-alphanumeric with _, max 50 chars, trim underscores.
   * Non-string input is rejected with an empty string so one bad record
   * cannot crash a poll.
   *
   * @param name Raw name to sanitize
   */
  public sanitize(name: unknown): string {
    if (typeof name !== "string") {
      return "";
    }
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 50);
  }

  /**
   * v0.4.3 (SM5): Sanitize + suffix with a stable hash of `uniqueKey` so two
   * records with the same post-sanitize name don't overwrite each other.
   *
   * @param name Raw display name to sanitize.
   * @param uniqueKey Stable identifier (e.g. PocketBase record id) used to
   *   derive the suffix.
   */
  public sanitizeWithSuffix(name: unknown, uniqueKey: string): string {
    const base = this.sanitize(name);
    if (!base) {
      return "";
    }
    return `${base}__${StateManager.shortHash(uniqueKey)}`;
  }

  /**
   * FNV-1a 32-bit short hash → 6 hex chars.
   *
   * @param s Input string to hash.
   */
  private static shortHash(s: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, "0").slice(0, 6);
  }

  /**
   * v0.4.3 (SM5): pre-compute the safeName for every system in this poll,
   * disambiguating collisions. Sorted by id for determinism. The first
   * occurrence keeps the bare safeName (back-compat); later collisions get
   * the `__<hash>` suffix.
   *
   * @param systems Systems to be processed in this poll cycle.
   */
  public prepareForPoll(systems: BeszelSystem[]): void {
    this.resolvedSafeNames.clear();
    const sorted = [...systems].sort((a, b) => a.id.localeCompare(b.id));
    const seen = new Set<string>();
    const collisions = new Map<string, BeszelSystem[]>();
    for (const sys of sorted) {
      const safe = this.sanitize(sys.name);
      if (!safe) {
        this.resolvedSafeNames.set(sys.id, "");
        continue;
      }
      if (seen.has(safe)) {
        const arr = collisions.get(safe) ?? [];
        arr.push(sys);
        collisions.set(safe, arr);
        this.resolvedSafeNames.set(sys.id, this.sanitizeWithSuffix(sys.name, sys.id));
      } else {
        seen.add(safe);
        this.resolvedSafeNames.set(sys.id, safe);
      }
    }
    for (const [safe, dupes] of collisions) {
      const names = dupes.map(s => `${s.name}(${s.id.slice(0, 8)})`).join(", ");
      this.adapter.log.warn(
        `Multiple systems sanitize to '${safe}' (${names}) — adding hash suffix to disambiguate. Consider renaming on the Hub.`,
      );
    }
  }

  /**
   * Resolved safeName from `prepareForPoll`, or fresh `sanitize(name)` fallback.
   *
   * @param system The Beszel system whose ID-segment we want.
   */
  private resolvedSafeName(system: BeszelSystem): string {
    const cached = this.resolvedSafeNames.get(system.id);
    return cached !== undefined ? cached : this.sanitize(system.name);
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
    const safeName = this.resolvedSafeName(system);
    if (safeName.length === 0) {
      this.adapter.log.warn(
        `Skipping system with unusable name: ${typeof system.name === "string" ? system.name : JSON.stringify(system.name)}`,
      );
      return;
    }
    const sysId = `systems.${safeName}`;
    // v0.4.4 (G1): trace the state-tree entry (after safeName resolution but
    // before any extendObjectAsync). Shows the name → safeName mapping —
    // useful when collisions cause SM5 suffix-disambiguation.
    this.adapter.log.debug(`updateSystem state-tree: '${system.name}' → safeName='${safeName}'`);

    // Create/update device object with online indicator
    await this.adapter.extendObjectAsync(
      sysId,
      {
        type: "device",
        common: {
          name: system.name,
          statusStates: {
            onlineId: `${this.adapter.namespace}.${sysId}.info.online`,
          },
        },
        native: { id: system.id, host: system.host },
      },
      { preserve: { common: ["name"] } },
    );

    // Info channel (always created)
    await this.ensureChannel(`${sysId}.info`, tName("channelInfo"));

    // Always: online + status
    await this.createAndSetState(
      `${sysId}.info.online`,
      this.boolCommon(tName("online"), "indicator.reachable"),
      system.status === "up",
    );
    await this.createAndSetState(`${sysId}.info.status`, this.textCommon(tName("status")), system.status);

    // Uptime
    if (config.metrics_uptime) {
      const uptime = system.info.u ?? null;
      await this.createAndSetState(`${sysId}.info.uptime`, this.numCommon(tName("uptime"), "s"), uptime);
      await this.createAndSetState(
        `${sysId}.info.uptime_text`,
        this.textCommon(tName("uptimeFormatted")),
        uptime !== null ? this.formatUptime(uptime) : null,
      );
    }

    // Agent version
    if (config.metrics_agentVersion) {
      await this.createAndSetState(
        `${sysId}.info.agent_version`,
        this.textCommon(tName("agentVersion")),
        system.info.v ?? null,
      );
    }

    // Systemd services
    if (config.metrics_services) {
      const sv = system.info.sv;
      await this.createAndSetState(
        `${sysId}.info.services_total`,
        this.numCommon(tName("servicesTotal")),
        sv?.[0] ?? null,
      );
      await this.createAndSetState(
        `${sysId}.info.services_failed`,
        this.numCommon(tName("servicesFailed")),
        sv?.[1] ?? null,
      );
    }

    // Stats-based metrics (only if stats available)
    if (stats) {
      await this.updateStatsStates(sysId, system, stats, config);
    }

    // Load avg fallback to system.info.la if no stats
    if (config.metrics_loadAvg && !stats) {
      await this.ensureChannel(`${sysId}.cpu`, tName("channelCpu"));
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
    const activeSet = new Set(activeSystemNames.map(n => this.sanitize(n)));
    // v0.4.3 (SM5): preserve disambiguated suffixed names so SM5-collision
    // entries don't get treated as stale.
    for (const safe of this.resolvedSafeNames.values()) {
      if (safe) {
        activeSet.add(safe);
      }
    }
    const existing = await this.getExistingSystemNames();
    const stale = existing.filter(name => !activeSet.has(name));
    // v0.4.3 (SM1): stale-system removals in parallel.
    await Promise.all(
      stale.map(async name => {
        this.adapter.log.debug(`Removing stale system: systems.${name}`);
        await this.adapter.delObjectAsync(`systems.${name}`, { recursive: true });
        this.dropCacheUnder(`systems.${name}`);
      }),
    );
  }

  /**
   * Drop every cached ID at or under the given prefix. Call after recursive
   * delObject so subsequent polls re-create the object instead of skipping it.
   *
   * @param prefix State ID prefix (e.g. `systems.my_server`)
   */
  private dropCacheUnder(prefix: string): void {
    const exact = prefix;
    const dot = `${prefix}.`;
    // v0.4.3 (SM4): snapshot to array first — defensive against any future
    // engine that diverges from spec on Set.delete during for-of iteration.
    for (const id of [...this.createdIds]) {
      if (id === exact || id.startsWith(dot)) {
        this.createdIds.delete(id);
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
  public async cleanupMetrics(systemId: string, config: AdapterConfig): Promise<void> {
    const sysId = `systems.${systemId}`;
    const toDelete: string[] = [];

    if (!config.metrics_uptime) {
      toDelete.push(`${sysId}.info.uptime`, `${sysId}.info.uptime_text`);
    }
    if (!config.metrics_agentVersion) {
      toDelete.push(`${sysId}.info.agent_version`);
    }
    if (!config.metrics_services) {
      toDelete.push(`${sysId}.info.services_total`, `${sysId}.info.services_failed`);
    }
    if (!config.metrics_cpu) {
      toDelete.push(`${sysId}.cpu.usage`);
    }
    if (!config.metrics_loadAvg) {
      toDelete.push(`${sysId}.cpu.load_1m`, `${sysId}.cpu.load_5m`, `${sysId}.cpu.load_15m`);
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
      toDelete.push(`${sysId}.memory.percent`, `${sysId}.memory.used`, `${sysId}.memory.total`);
    }
    if (!config.metrics_memoryDetails) {
      toDelete.push(`${sysId}.memory.buffers`, `${sysId}.memory.zfs_arc`);
    }
    if (!config.metrics_swap) {
      toDelete.push(`${sysId}.memory.swap_used`, `${sysId}.memory.swap_total`);
    }
    if (!config.metrics_disk) {
      toDelete.push(`${sysId}.disk.percent`, `${sysId}.disk.used`, `${sysId}.disk.total`);
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

    // v0.4.3 (SM2): toDelete check + delete in parallel.
    await Promise.all(
      toDelete.map(async id => {
        const obj = await this.adapter.getObjectAsync(id);
        if (obj) {
          await this.adapter.delObjectAsync(id);
          this.createdIds.delete(id);
        }
      }),
    );

    // Delete empty channels when all metrics in a group are disabled
    const noCpu = !config.metrics_cpu && !config.metrics_loadAvg && !config.metrics_cpuBreakdown;
    if (noCpu) {
      await this.deleteChannelIfExists(`${sysId}.cpu`);
    }

    const noMemory = !config.metrics_memory && !config.metrics_memoryDetails && !config.metrics_swap;
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

    const noTemp = !config.metrics_temperature && !config.metrics_temperatureDetails;
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
    // v0.4.4 (G4): trace the scan-start so the migration-summary at the end
    // is anchored. If no states need migration, only this debug line fires;
    // the existing info-summary stays silent.
    this.adapter.log.debug(
      `migrateLegacyStates: scanning ${existingNames.length} existing system(s) for legacy flat states`,
    );

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

    // v0.4.3 (SM3): per-system migration in parallel; per-state checks
    // within a system stay sequential (the mocha+ts-node ESM loader trips
    // on doubly-nested Promise.all here — see Memory `feedback_mocha_esm_loader_bug`).
    // Outer parallel still cuts total time by N where N = system count.
    const counts = await Promise.all(
      existingNames.map(async name => {
        const sysId = `systems.${name}`;
        let local = 0;
        for (const stateId of legacyStates) {
          const fullId = `${sysId}.${stateId}`;
          const obj = await this.adapter.getObjectAsync(fullId);
          if (obj && obj.type === "state") {
            await this.adapter.delObjectAsync(fullId);
            this.createdIds.delete(fullId);
            local++;
          }
        }
        await this.deleteChannelIfExists(`${sysId}.temperatures`);
        return local;
      }),
    );
    const migrated = counts.reduce((a, b) => a + b, 0);

    if (migrated > 0) {
      this.adapter.log.info(`Migration: removed ${migrated} legacy state(s) from flat structure`);
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
    if (config.metrics_cpu || config.metrics_loadAvg || config.metrics_cpuBreakdown) {
      await this.ensureChannel(`${sysId}.cpu`, tName("channelCpu"));
    }
    if (config.metrics_memory || config.metrics_memoryDetails || config.metrics_swap) {
      await this.ensureChannel(`${sysId}.memory`, tName("channelMemory"));
    }
    if (config.metrics_disk || config.metrics_diskSpeed) {
      await this.ensureChannel(`${sysId}.disk`, tName("channelDisk"));
    }
    if (config.metrics_network) {
      await this.ensureChannel(`${sysId}.network`, tName("channelNetwork"));
    }
    if (config.metrics_temperature || config.metrics_temperatureDetails) {
      await this.ensureChannel(`${sysId}.temperature`, tName("channelTemperature"));
    }
    if (config.metrics_battery) {
      await this.ensureChannel(`${sysId}.battery`, tName("channelBattery"));
    }

    // CPU
    if (config.metrics_cpu) {
      await this.createAndSetState(`${sysId}.cpu.usage`, this.percentCommon(tName("cpuUsage")), stats.cpu ?? null);
    }

    // Load avg — prefer stats.la, fallback to system.info.la
    if (config.metrics_loadAvg) {
      await this.createLoadAvgStates(sysId, stats.la ?? system.info.la);
    }

    // CPU breakdown
    if (config.metrics_cpuBreakdown && stats.cpub && stats.cpub.length >= 5) {
      const [user, sys, iowait, steal, idle] = stats.cpub;
      await this.createAndSetState(`${sysId}.cpu.user`, this.percentCommon(tName("cpuUser")), user);
      await this.createAndSetState(`${sysId}.cpu.system`, this.percentCommon(tName("cpuSystem")), sys);
      await this.createAndSetState(`${sysId}.cpu.iowait`, this.percentCommon(tName("cpuIowait")), iowait);
      await this.createAndSetState(`${sysId}.cpu.steal`, this.percentCommon(tName("cpuSteal")), steal);
      await this.createAndSetState(`${sysId}.cpu.idle`, this.percentCommon(tName("cpuIdle")), idle);
    }

    // Memory
    if (config.metrics_memory) {
      await this.createAndSetState(
        `${sysId}.memory.percent`,
        this.percentCommon(tName("memoryPercent")),
        stats.mp ?? null,
      );
      await this.createAndSetState(`${sysId}.memory.used`, this.numCommon(tName("memoryUsed"), "GB"), stats.mu ?? null);
      await this.createAndSetState(
        `${sysId}.memory.total`,
        this.numCommon(tName("memoryTotal"), "GB"),
        stats.m ?? null,
      );
    }

    // Memory details
    if (config.metrics_memoryDetails) {
      await this.createAndSetState(
        `${sysId}.memory.buffers`,
        this.numCommon(tName("memoryBuffers"), "GB"),
        stats.mb ?? null,
      );
      await this.createAndSetState(
        `${sysId}.memory.zfs_arc`,
        this.numCommon(tName("memoryZfsArc"), "GB"),
        stats.mz ?? null,
      );
    }

    // Swap
    if (config.metrics_swap) {
      await this.createAndSetState(
        `${sysId}.memory.swap_used`,
        this.numCommon(tName("swapUsed"), "GB"),
        stats.su ?? null,
      );
      await this.createAndSetState(
        `${sysId}.memory.swap_total`,
        this.numCommon(tName("swapTotal"), "GB"),
        stats.s ?? null,
      );
    }

    // Disk
    if (config.metrics_disk) {
      await this.createAndSetState(`${sysId}.disk.percent`, this.percentCommon(tName("diskPercent")), stats.dp ?? null);
      await this.createAndSetState(`${sysId}.disk.used`, this.numCommon(tName("diskUsed"), "GB"), stats.du ?? null);
      await this.createAndSetState(`${sysId}.disk.total`, this.numCommon(tName("diskTotal"), "GB"), stats.d ?? null);
    }

    // Disk speed
    if (config.metrics_diskSpeed) {
      await this.createAndSetState(`${sysId}.disk.read`, this.numCommon(tName("diskRead"), "MB/s"), stats.dr ?? null);
      await this.createAndSetState(`${sysId}.disk.write`, this.numCommon(tName("diskWrite"), "MB/s"), stats.dw ?? null);
    }

    // Network
    if (config.metrics_network) {
      await this.createAndSetState(
        `${sysId}.network.sent`,
        this.numCommon(tName("networkSent"), "MB/s"),
        stats.ns ?? null,
      );
      await this.createAndSetState(
        `${sysId}.network.recv`,
        this.numCommon(tName("networkReceived"), "MB/s"),
        stats.nr ?? null,
      );
    }

    // Temperature (average of top 3)
    if (config.metrics_temperature) {
      await this.createAndSetState(
        `${sysId}.temperature.average`,
        this.numCommon(tName("temperatureAvg"), "°C", "value.temperature"),
        this.computeTopAvgTemp(stats.t),
      );
    }

    // Temperature details — sensor names come from the agent (e.g. "coretemp_package0")
    // and have no fixed translation — we display them as-is.
    if (config.metrics_temperatureDetails && stats.t) {
      await this.ensureChannel(`${sysId}.temperature.sensors`, tName("channelSensors"));
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
        this.percentCommon(tName("batteryPercent")),
        bat?.[0] ?? null,
      );
      await this.createAndSetState(
        `${sysId}.battery.charging`,
        this.boolCommon(tName("batteryCharging")),
        bat ? bat[1] > 0 : null,
      );
    }

    // GPU — gpuData.n is the raw vendor name; we keep it as a plain string.
    if (config.metrics_gpu && stats.g && Object.keys(stats.g).length > 0) {
      await this.ensureChannel(`${sysId}.gpu`, tName("channelGpu"));
      for (const [gpuId, gpuData] of Object.entries(stats.g)) {
        const safeId = this.sanitize(gpuId);
        await this.ensureChannel(`${sysId}.gpu.${safeId}`, gpuData.n ?? gpuId);
        await this.createAndSetState(
          `${sysId}.gpu.${safeId}.usage`,
          this.percentCommon(tName("gpuUsage")),
          gpuData.u ?? null,
        );
        await this.createAndSetState(
          `${sysId}.gpu.${safeId}.memory_used`,
          this.numCommon(tName("gpuMemoryUsed"), "GB"),
          gpuData.mu ?? null,
        );
        await this.createAndSetState(
          `${sysId}.gpu.${safeId}.memory_total`,
          this.numCommon(tName("gpuMemoryTotal"), "GB"),
          gpuData.mt ?? null,
        );
        await this.createAndSetState(
          `${sysId}.gpu.${safeId}.power`,
          this.numCommon(tName("gpuPower"), "W"),
          gpuData.p ?? null,
        );
      }
    }

    // Extra filesystems — fsName is the raw mount path, kept as plain string.
    if (config.metrics_extraFs && stats.efs && Object.keys(stats.efs).length > 0) {
      await this.ensureChannel(`${sysId}.filesystems`, tName("channelFilesystems"));
      for (const [fsName, fsData] of Object.entries(stats.efs)) {
        const safeId = this.sanitize(fsName);
        await this.ensureChannel(`${sysId}.filesystems.${safeId}`, fsName);

        const total = fsData.d ?? null;
        const used = fsData.du ?? null;
        // v0.4.3 (SM8): clamp to [0, 100] — transient `used > total`
        // (data drift between separate metric polls) shouldn't push > 100%
        // into the state.
        const percent =
          total !== null && used !== null && total > 0
            ? Math.min(100, Math.max(0, Math.round((used / total) * 100)))
            : null;

        await this.createAndSetState(
          `${sysId}.filesystems.${safeId}.disk_percent`,
          this.percentCommon(tName("diskPercent")),
          percent,
        );
        await this.createAndSetState(
          `${sysId}.filesystems.${safeId}.disk_used`,
          this.numCommon(tName("diskUsed"), "GB"),
          used,
        );
        await this.createAndSetState(
          `${sysId}.filesystems.${safeId}.disk_total`,
          this.numCommon(tName("diskTotal"), "GB"),
          total,
        );
        await this.createAndSetState(
          `${sysId}.filesystems.${safeId}.read_speed`,
          this.numCommon(tName("readSpeed"), "MB/s"),
          fsData.r ?? null,
        );
        await this.createAndSetState(
          `${sysId}.filesystems.${safeId}.write_speed`,
          this.numCommon(tName("writeSpeed"), "MB/s"),
          fsData.w ?? null,
        );
      }
    }
  }

  private async updateContainers(sysId: string, systemId: string, allContainers: BeszelContainer[]): Promise<void> {
    const sysContainers = allContainers.filter(c => c.system === systemId);
    if (sysContainers.length === 0) {
      return;
    }

    await this.ensureChannel(`${sysId}.containers`, tName("channelContainers"));

    const healthLabels = ["none", "starting", "healthy", "unhealthy"];

    for (const container of sysContainers) {
      const cId = this.sanitize(container.name);
      if (cId.length === 0) {
        continue;
      }
      // container.name is user-defined (Docker container name) → keep as-is.
      await this.ensureChannel(`${sysId}.containers.${cId}`, container.name);
      await this.createAndSetState(
        `${sysId}.containers.${cId}.status`,
        this.textCommon(tName("status")),
        container.status,
      );
      // v0.4.3 (SM7): floor the health index — API drift could send a
      // float (e.g. 2.5) which `healthLabels[2.5]` resolves to undefined.
      const healthIdx = Math.floor(container.health);
      await this.createAndSetState(
        `${sysId}.containers.${cId}.health`,
        this.textCommon(tName("containerHealth")),
        healthLabels[healthIdx] ?? "unknown",
      );
      await this.createAndSetState(
        `${sysId}.containers.${cId}.cpu`,
        this.percentCommon(tName("cpuUsage")),
        container.cpu,
      );
      await this.createAndSetState(
        `${sysId}.containers.${cId}.memory`,
        this.numCommon(tName("containerMemory"), "MB"),
        container.memory,
      );
      await this.createAndSetState(
        `${sysId}.containers.${cId}.image`,
        this.textCommon(tName("containerImage")),
        container.image,
      );
    }
  }

  private async ensureChannel(id: string, name: LocalizedName): Promise<void> {
    if (this.createdIds.has(id)) {
      return;
    }
    await this.adapter.setObjectNotExistsAsync(id, {
      type: "channel",
      common: { name },
      native: {},
    });
    this.createdIds.add(id);
  }

  private async deleteChannelIfExists(id: string): Promise<void> {
    try {
      const obj = await this.adapter.getObjectAsync(id);
      if (obj) {
        await this.adapter.delObjectAsync(id, { recursive: true });
        this.dropCacheUnder(id);
      }
    } catch (err) {
      // v0.5.0 (S2): silent-catch ersetzt durch debug-Trace. Broker-already-down
      // or "object does not exist" are expected here — keep them out of the
      // user log but leave a breadcrumb for diagnostics.
      this.adapter.log.debug(`deleteChannelIfExists(${id}) ignored: ${errText(err)}`);
    }
  }

  /**
   * Create or update the three load average states.
   *
   * @param sysId State ID prefix (e.g. "systems.my_server")
   * @param la Load average tuple [1m, 5m, 15m], or undefined
   */
  private async createLoadAvgStates(sysId: string, la: [number, number, number] | undefined): Promise<void> {
    await this.createAndSetState(`${sysId}.cpu.load_1m`, this.numCommon(tName("load1m")), la?.[0] ?? null);
    await this.createAndSetState(`${sysId}.cpu.load_5m`, this.numCommon(tName("load5m")), la?.[1] ?? null);
    await this.createAndSetState(`${sysId}.cpu.load_15m`, this.numCommon(tName("load15m")), la?.[2] ?? null);
  }

  private async createAndSetState(id: string, common: ioBroker.StateCommon, value: ioBroker.StateValue): Promise<void> {
    if (!this.createdIds.has(id)) {
      await this.adapter.setObjectNotExistsAsync(id, {
        type: "state",
        common,
        native: {},
      });
      this.createdIds.add(id);
    }
    await this.adapter.setStateAsync(id, { val: value, ack: true });
  }

  // -------------------------------------------------------------------------
  // State common factories
  // -------------------------------------------------------------------------

  private percentCommon(name: LocalizedName): ioBroker.StateCommon {
    return {
      name,
      type: "number",
      role: "value",
      unit: "%",
      min: 0,
      max: 100,
      read: true,
      write: false,
    };
  }

  private numCommon(name: LocalizedName, unit?: string, role = "value"): ioBroker.StateCommon {
    return {
      name,
      type: "number",
      role,
      unit,
      read: true,
      write: false,
    };
  }

  private textCommon(name: LocalizedName): ioBroker.StateCommon {
    return {
      name,
      type: "string",
      role: "text",
      read: true,
      write: false,
    };
  }

  private boolCommon(name: LocalizedName, role = "indicator"): ioBroker.StateCommon {
    return {
      name,
      type: "boolean",
      role,
      read: true,
      write: false,
    };
  }

  // -------------------------------------------------------------------------
  // Computation helpers
  // -------------------------------------------------------------------------

  private computeTopAvgTemp(temps: Record<string, number> | undefined): number | null {
    if (!temps) {
      return null;
    }
    const values = Object.values(temps).filter(v => typeof v === "number" && isFinite(v));
    if (values.length === 0) {
      return null;
    }
    values.sort((a, b) => b - a);
    const top3 = values.slice(0, 3);
    const avg = top3.reduce((sum, v) => sum + v, 0) / top3.length;
    return Math.round(avg * 10) / 10;
  }

  private formatUptime(seconds: number): string {
    // v0.4.3 (SM10): clamp >= 0 — clock-skew or agent bug could send a
    // negative value, which used to produce strings like "-1d -2h -3m".
    const s = Math.max(0, seconds);
    const d = Math.floor(s / 86400);
    const h = Math.floor((s % 86400) / 3600);
    const m = Math.floor((s % 3600) / 60);
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
