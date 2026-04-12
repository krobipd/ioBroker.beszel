"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
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
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var state_manager_exports = {};
__export(state_manager_exports, {
  StateManager: () => StateManager
});
module.exports = __toCommonJS(state_manager_exports);
class StateManager {
  adapter;
  /**
   * @param adapter The ioBroker adapter instance
   */
  constructor(adapter) {
    this.adapter = adapter;
  }
  /**
   * Sanitize a name to a valid ioBroker state ID segment (see adapter.FORBIDDEN_CHARS).
   * Lowercase, replace non-alphanumeric with _, max 50 chars, trim underscores.
   *
   * @param name Raw name to sanitize
   */
  sanitize(name) {
    return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 50);
  }
  /**
   * Return sanitized names of all existing system devices.
   */
  async getExistingSystemNames() {
    const objects = await this.adapter.getObjectViewAsync("system", "device", {
      startkey: `${this.adapter.namespace}.systems.`,
      endkey: `${this.adapter.namespace}.systems.\u9999`
    });
    if (!(objects == null ? void 0 : objects.rows)) {
      return [];
    }
    const names = [];
    for (const row of objects.rows) {
      const id = row.id.startsWith(`${this.adapter.namespace}.`) ? row.id.slice(this.adapter.namespace.length + 1) : row.id;
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
  async updateSystem(system, stats, containers, config) {
    var _a, _b, _c, _d;
    const sysId = `systems.${this.sanitize(system.name)}`;
    await this.adapter.extendObjectAsync(sysId, {
      type: "device",
      common: {
        name: system.name,
        statusStates: {
          onlineId: `${this.adapter.namespace}.${sysId}.info.online`
        }
      },
      native: { id: system.id, host: system.host }
    });
    await this.ensureChannel(`${sysId}.info`, "Info");
    await this.createAndSetState(
      `${sysId}.info.online`,
      this.boolCommon("Online", "indicator.reachable"),
      system.status === "up"
    );
    await this.createAndSetState(
      `${sysId}.info.status`,
      this.textCommon("Status"),
      system.status
    );
    if (config.metrics_uptime) {
      const uptime = (_a = system.info.u) != null ? _a : null;
      await this.createAndSetState(
        `${sysId}.info.uptime`,
        this.numCommon("Uptime", "s"),
        uptime
      );
      await this.createAndSetState(
        `${sysId}.info.uptime_text`,
        this.textCommon("Uptime (formatted)"),
        uptime !== null ? this.formatUptime(uptime) : null
      );
    }
    if (config.metrics_agentVersion) {
      await this.createAndSetState(
        `${sysId}.info.agent_version`,
        this.textCommon("Agent Version"),
        (_b = system.info.v) != null ? _b : null
      );
    }
    if (config.metrics_services) {
      const sv = system.info.sv;
      await this.createAndSetState(
        `${sysId}.info.services_total`,
        this.numCommon("Services Total"),
        (_c = sv == null ? void 0 : sv[0]) != null ? _c : null
      );
      await this.createAndSetState(
        `${sysId}.info.services_failed`,
        this.numCommon("Services Failed"),
        (_d = sv == null ? void 0 : sv[1]) != null ? _d : null
      );
    }
    if (stats) {
      await this.updateStatsStates(sysId, system, stats, config);
    }
    if (config.metrics_loadAvg && !stats) {
      await this.ensureChannel(`${sysId}.cpu`, "CPU");
      await this.createLoadAvgStates(sysId, system.info.la);
    }
    if (config.metrics_containers) {
      await this.updateContainers(sysId, system.id, containers);
    }
  }
  /**
   * Remove device objects for systems that are no longer in Beszel.
   *
   * @param activeSystemNames Sanitized names of currently active systems
   */
  async cleanupSystems(activeSystemNames) {
    const activeSet = new Set(activeSystemNames.map((n) => this.sanitize(n)));
    const existing = await this.getExistingSystemNames();
    for (const name of existing) {
      if (!activeSet.has(name)) {
        this.adapter.log.debug(`Removing stale system: systems.${name}`);
        await this.adapter.delObjectAsync(`systems.${name}`, {
          recursive: true
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
  async cleanupMetrics(systemId, config) {
    const sysId = `systems.${systemId}`;
    const toDelete = [];
    if (!config.metrics_uptime) {
      toDelete.push(`${sysId}.info.uptime`, `${sysId}.info.uptime_text`);
    }
    if (!config.metrics_agentVersion) {
      toDelete.push(`${sysId}.info.agent_version`);
    }
    if (!config.metrics_services) {
      toDelete.push(
        `${sysId}.info.services_total`,
        `${sysId}.info.services_failed`
      );
    }
    if (!config.metrics_cpu) {
      toDelete.push(`${sysId}.cpu.usage`);
    }
    if (!config.metrics_loadAvg) {
      toDelete.push(
        `${sysId}.cpu.load_1m`,
        `${sysId}.cpu.load_5m`,
        `${sysId}.cpu.load_15m`
      );
    }
    if (!config.metrics_cpuBreakdown) {
      toDelete.push(
        `${sysId}.cpu.user`,
        `${sysId}.cpu.system`,
        `${sysId}.cpu.iowait`,
        `${sysId}.cpu.steal`,
        `${sysId}.cpu.idle`
      );
    }
    if (!config.metrics_memory) {
      toDelete.push(
        `${sysId}.memory.percent`,
        `${sysId}.memory.used`,
        `${sysId}.memory.total`
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
        `${sysId}.disk.total`
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
  async migrateLegacyStates() {
    const existingNames = await this.getExistingSystemNames();
    if (existingNames.length === 0) {
      return;
    }
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
      "battery_charging"
    ];
    let migrated = 0;
    for (const name of existingNames) {
      const sysId = `systems.${name}`;
      for (const stateId of legacyStates) {
        const fullId = `${sysId}.${stateId}`;
        const obj = await this.adapter.getObjectAsync(fullId);
        if (obj && obj.type === "state") {
          await this.adapter.delObjectAsync(fullId);
          migrated++;
        }
      }
      await this.deleteChannelIfExists(`${sysId}.temperatures`);
    }
    if (migrated > 0) {
      this.adapter.log.info(
        `Migration: removed ${migrated} legacy state(s) from flat structure`
      );
    }
  }
  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------
  async updateStatsStates(sysId, system, stats, config) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m, _n, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y, _z, _A;
    if (config.metrics_cpu || config.metrics_loadAvg || config.metrics_cpuBreakdown) {
      await this.ensureChannel(`${sysId}.cpu`, "CPU");
    }
    if (config.metrics_memory || config.metrics_memoryDetails || config.metrics_swap) {
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
    if (config.metrics_cpu) {
      await this.createAndSetState(
        `${sysId}.cpu.usage`,
        this.percentCommon("CPU Usage"),
        (_a = stats.cpu) != null ? _a : null
      );
    }
    if (config.metrics_loadAvg) {
      await this.createLoadAvgStates(sysId, (_b = stats.la) != null ? _b : system.info.la);
    }
    if (config.metrics_cpuBreakdown && stats.cpub && stats.cpub.length >= 5) {
      const [user, sys, iowait, steal, idle] = stats.cpub;
      await this.createAndSetState(
        `${sysId}.cpu.user`,
        this.percentCommon("CPU User %"),
        user
      );
      await this.createAndSetState(
        `${sysId}.cpu.system`,
        this.percentCommon("CPU System %"),
        sys
      );
      await this.createAndSetState(
        `${sysId}.cpu.iowait`,
        this.percentCommon("CPU IOWait %"),
        iowait
      );
      await this.createAndSetState(
        `${sysId}.cpu.steal`,
        this.percentCommon("CPU Steal %"),
        steal
      );
      await this.createAndSetState(
        `${sysId}.cpu.idle`,
        this.percentCommon("CPU Idle %"),
        idle
      );
    }
    if (config.metrics_memory) {
      await this.createAndSetState(
        `${sysId}.memory.percent`,
        this.percentCommon("Memory %"),
        (_c = stats.mp) != null ? _c : null
      );
      await this.createAndSetState(
        `${sysId}.memory.used`,
        this.numCommon("Memory Used", "GB"),
        (_d = stats.mu) != null ? _d : null
      );
      await this.createAndSetState(
        `${sysId}.memory.total`,
        this.numCommon("Memory Total", "GB"),
        (_e = stats.m) != null ? _e : null
      );
    }
    if (config.metrics_memoryDetails) {
      await this.createAndSetState(
        `${sysId}.memory.buffers`,
        this.numCommon("Memory Buffers+Cache", "GB"),
        (_f = stats.mb) != null ? _f : null
      );
      await this.createAndSetState(
        `${sysId}.memory.zfs_arc`,
        this.numCommon("Memory ZFS ARC", "GB"),
        (_g = stats.mz) != null ? _g : null
      );
    }
    if (config.metrics_swap) {
      await this.createAndSetState(
        `${sysId}.memory.swap_used`,
        this.numCommon("Swap Used", "GB"),
        (_h = stats.su) != null ? _h : null
      );
      await this.createAndSetState(
        `${sysId}.memory.swap_total`,
        this.numCommon("Swap Total", "GB"),
        (_i = stats.s) != null ? _i : null
      );
    }
    if (config.metrics_disk) {
      await this.createAndSetState(
        `${sysId}.disk.percent`,
        this.percentCommon("Disk %"),
        (_j = stats.dp) != null ? _j : null
      );
      await this.createAndSetState(
        `${sysId}.disk.used`,
        this.numCommon("Disk Used", "GB"),
        (_k = stats.du) != null ? _k : null
      );
      await this.createAndSetState(
        `${sysId}.disk.total`,
        this.numCommon("Disk Total", "GB"),
        (_l = stats.d) != null ? _l : null
      );
    }
    if (config.metrics_diskSpeed) {
      await this.createAndSetState(
        `${sysId}.disk.read`,
        this.numCommon("Disk Read", "MB/s"),
        (_m = stats.dr) != null ? _m : null
      );
      await this.createAndSetState(
        `${sysId}.disk.write`,
        this.numCommon("Disk Write", "MB/s"),
        (_n = stats.dw) != null ? _n : null
      );
    }
    if (config.metrics_network) {
      await this.createAndSetState(
        `${sysId}.network.sent`,
        this.numCommon("Network Sent", "MB/s"),
        (_o = stats.ns) != null ? _o : null
      );
      await this.createAndSetState(
        `${sysId}.network.recv`,
        this.numCommon("Network Received", "MB/s"),
        (_p = stats.nr) != null ? _p : null
      );
    }
    if (config.metrics_temperature) {
      await this.createAndSetState(
        `${sysId}.temperature.average`,
        this.numCommon("Temperature (avg top 3)", "\xB0C", "value.temperature"),
        this.computeTopAvgTemp(stats.t)
      );
    }
    if (config.metrics_temperatureDetails && stats.t) {
      await this.ensureChannel(`${sysId}.temperature.sensors`, "Sensors");
      for (const [sensor, temp] of Object.entries(stats.t)) {
        await this.createAndSetState(
          `${sysId}.temperature.sensors.${this.sanitize(sensor)}`,
          this.numCommon(sensor, "\xB0C", "value.temperature"),
          temp
        );
      }
    }
    if (config.metrics_battery) {
      const bat = (_q = stats.bat) != null ? _q : system.info.bat;
      await this.createAndSetState(
        `${sysId}.battery.percent`,
        this.percentCommon("Battery %"),
        (_r = bat == null ? void 0 : bat[0]) != null ? _r : null
      );
      await this.createAndSetState(
        `${sysId}.battery.charging`,
        this.boolCommon("Battery Charging"),
        bat ? bat[1] > 0 : null
      );
    }
    if (config.metrics_gpu && stats.g && Object.keys(stats.g).length > 0) {
      await this.ensureChannel(`${sysId}.gpu`, "GPU");
      for (const [gpuId, gpuData] of Object.entries(stats.g)) {
        const safeId = this.sanitize(gpuId);
        await this.ensureChannel(`${sysId}.gpu.${safeId}`, (_s = gpuData.n) != null ? _s : gpuId);
        await this.createAndSetState(
          `${sysId}.gpu.${safeId}.usage`,
          this.percentCommon("GPU Usage"),
          (_t = gpuData.u) != null ? _t : null
        );
        await this.createAndSetState(
          `${sysId}.gpu.${safeId}.memory_used`,
          this.numCommon("GPU Memory Used", "GB"),
          (_u = gpuData.mu) != null ? _u : null
        );
        await this.createAndSetState(
          `${sysId}.gpu.${safeId}.memory_total`,
          this.numCommon("GPU Memory Total", "GB"),
          (_v = gpuData.mt) != null ? _v : null
        );
        await this.createAndSetState(
          `${sysId}.gpu.${safeId}.power`,
          this.numCommon("GPU Power", "W"),
          (_w = gpuData.p) != null ? _w : null
        );
      }
    }
    if (config.metrics_extraFs && stats.efs && Object.keys(stats.efs).length > 0) {
      await this.ensureChannel(`${sysId}.filesystems`, "Filesystems");
      for (const [fsName, fsData] of Object.entries(stats.efs)) {
        const safeId = this.sanitize(fsName);
        await this.ensureChannel(`${sysId}.filesystems.${safeId}`, fsName);
        const total = (_x = fsData.d) != null ? _x : null;
        const used = (_y = fsData.du) != null ? _y : null;
        const percent = total !== null && used !== null && total > 0 ? Math.round(used / total * 100) : null;
        await this.createAndSetState(
          `${sysId}.filesystems.${safeId}.disk_percent`,
          this.percentCommon("Disk %"),
          percent
        );
        await this.createAndSetState(
          `${sysId}.filesystems.${safeId}.disk_used`,
          this.numCommon("Disk Used", "GB"),
          used
        );
        await this.createAndSetState(
          `${sysId}.filesystems.${safeId}.disk_total`,
          this.numCommon("Disk Total", "GB"),
          total
        );
        await this.createAndSetState(
          `${sysId}.filesystems.${safeId}.read_speed`,
          this.numCommon("Read Speed", "MB/s"),
          (_z = fsData.r) != null ? _z : null
        );
        await this.createAndSetState(
          `${sysId}.filesystems.${safeId}.write_speed`,
          this.numCommon("Write Speed", "MB/s"),
          (_A = fsData.w) != null ? _A : null
        );
      }
    }
  }
  async updateContainers(sysId, systemId, allContainers) {
    var _a;
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
        container.status
      );
      await this.createAndSetState(
        `${sysId}.containers.${cId}.health`,
        this.textCommon("Health"),
        (_a = healthLabels[container.health]) != null ? _a : "unknown"
      );
      await this.createAndSetState(
        `${sysId}.containers.${cId}.cpu`,
        this.percentCommon("CPU Usage"),
        container.cpu
      );
      await this.createAndSetState(
        `${sysId}.containers.${cId}.memory`,
        this.numCommon("Memory", "MB"),
        container.memory
      );
      await this.createAndSetState(
        `${sysId}.containers.${cId}.image`,
        this.textCommon("Image"),
        container.image
      );
    }
  }
  async ensureChannel(id, name) {
    await this.adapter.setObjectNotExistsAsync(id, {
      type: "channel",
      common: { name },
      native: {}
    });
  }
  async deleteChannelIfExists(id) {
    try {
      const obj = await this.adapter.getObjectAsync(id);
      if (obj) {
        await this.adapter.delObjectAsync(id, { recursive: true });
      }
    } catch {
    }
  }
  /**
   * Create or update the three load average states.
   *
   * @param sysId State ID prefix (e.g. "systems.my_server")
   * @param la Load average tuple [1m, 5m, 15m], or undefined
   */
  async createLoadAvgStates(sysId, la) {
    var _a, _b, _c;
    await this.createAndSetState(
      `${sysId}.cpu.load_1m`,
      this.numCommon("Load Average 1m"),
      (_a = la == null ? void 0 : la[0]) != null ? _a : null
    );
    await this.createAndSetState(
      `${sysId}.cpu.load_5m`,
      this.numCommon("Load Average 5m"),
      (_b = la == null ? void 0 : la[1]) != null ? _b : null
    );
    await this.createAndSetState(
      `${sysId}.cpu.load_15m`,
      this.numCommon("Load Average 15m"),
      (_c = la == null ? void 0 : la[2]) != null ? _c : null
    );
  }
  async createAndSetState(id, common, value) {
    await this.adapter.setObjectNotExistsAsync(id, {
      type: "state",
      common,
      native: {}
    });
    await this.adapter.setStateAsync(id, { val: value, ack: true });
  }
  // -------------------------------------------------------------------------
  // State common factories
  // -------------------------------------------------------------------------
  percentCommon(name) {
    return {
      name,
      type: "number",
      role: "value",
      unit: "%",
      min: 0,
      max: 100,
      read: true,
      write: false
    };
  }
  numCommon(name, unit, role = "value") {
    return {
      name,
      type: "number",
      role,
      unit,
      read: true,
      write: false
    };
  }
  textCommon(name) {
    return {
      name,
      type: "string",
      role: "text",
      read: true,
      write: false
    };
  }
  boolCommon(name, role = "indicator") {
    return {
      name,
      type: "boolean",
      role,
      read: true,
      write: false
    };
  }
  // -------------------------------------------------------------------------
  // Computation helpers
  // -------------------------------------------------------------------------
  computeTopAvgTemp(temps) {
    if (!temps) {
      return null;
    }
    const values = Object.values(temps).filter(
      (v) => typeof v === "number" && isFinite(v)
    );
    if (values.length === 0) {
      return null;
    }
    values.sort((a, b) => b - a);
    const top3 = values.slice(0, 3);
    const avg = top3.reduce((sum, v) => sum + v, 0) / top3.length;
    return Math.round(avg * 10) / 10;
  }
  formatUptime(seconds) {
    const d = Math.floor(seconds / 86400);
    const h = Math.floor(seconds % 86400 / 3600);
    const m = Math.floor(seconds % 3600 / 60);
    const parts = [];
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
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  StateManager
});
//# sourceMappingURL=state-manager.js.map
