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
          onlineId: `${this.adapter.namespace}.${sysId}.online`
        }
      },
      native: { id: system.id, host: system.host }
    });
    const isUp = system.status === "up";
    await this.createAndSetState(
      `${sysId}.online`,
      {
        name: "Online",
        type: "boolean",
        role: "indicator.reachable",
        read: true,
        write: false
      },
      isUp
    );
    await this.createAndSetState(
      `${sysId}.status`,
      {
        name: "Status",
        type: "string",
        role: "text",
        read: true,
        write: false
      },
      system.status
    );
    if (config.metrics_uptime) {
      const uptime = (_a = system.info.u) != null ? _a : null;
      await this.createAndSetState(
        `${sysId}.uptime`,
        {
          name: "Uptime",
          type: "number",
          role: "value",
          unit: "s",
          read: true,
          write: false
        },
        uptime
      );
      await this.createAndSetState(
        `${sysId}.uptime_text`,
        {
          name: "Uptime (formatted)",
          type: "string",
          role: "text",
          read: true,
          write: false
        },
        uptime !== null ? this.formatUptime(uptime) : null
      );
    }
    if (config.metrics_agentVersion) {
      await this.createAndSetState(
        `${sysId}.agent_version`,
        {
          name: "Agent Version",
          type: "string",
          role: "text",
          read: true,
          write: false
        },
        (_b = system.info.v) != null ? _b : null
      );
    }
    if (config.metrics_services) {
      const sv = system.info.sv;
      await this.createAndSetState(
        `${sysId}.services_total`,
        {
          name: "Services Total",
          type: "number",
          role: "value",
          read: true,
          write: false
        },
        (_c = sv == null ? void 0 : sv[0]) != null ? _c : null
      );
      await this.createAndSetState(
        `${sysId}.services_failed`,
        {
          name: "Services Failed",
          type: "number",
          role: "value.warning",
          read: true,
          write: false
        },
        (_d = sv == null ? void 0 : sv[1]) != null ? _d : null
      );
    }
    if (stats) {
      await this.updateStatsStates(sysId, system, stats, config);
    }
    if (config.metrics_loadAvg && !stats) {
      await this.createLoadAvgStates(sysId, system.info.la);
    }
    if (config.metrics_containers) {
      await this.updateContainers(sysId, system.id, containers);
    } else {
      await this.deleteChannelIfExists(`${sysId}.containers`);
    }
  }
  /**
   * Remove device objects for systems that are no longer in Beszel.
   *
   * @param activeSystemNames Sanitized names of currently active systems
   */
  async cleanupSystems(activeSystemNames) {
    const activeIds = new Set(
      activeSystemNames.map((n) => `systems.${this.sanitize(n)}`)
    );
    const objects = await this.adapter.getObjectViewAsync("system", "device", {
      startkey: `${this.adapter.namespace}.systems.`,
      endkey: `${this.adapter.namespace}.systems.\u9999`
    });
    if (!(objects == null ? void 0 : objects.rows)) {
      return;
    }
    for (const row of objects.rows) {
      const id = row.id;
      const relativeId = id.startsWith(`${this.adapter.namespace}.`) ? id.slice(this.adapter.namespace.length + 1) : id;
      const parts = relativeId.split(".");
      if (parts.length === 2 && parts[0] === "systems" && !activeIds.has(relativeId)) {
        this.adapter.log.debug(`Removing stale system: ${relativeId}`);
        await this.adapter.delObjectAsync(relativeId, { recursive: true });
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
      toDelete.push(`${sysId}.uptime`, `${sysId}.uptime_text`);
    }
    if (!config.metrics_agentVersion) {
      toDelete.push(`${sysId}.agent_version`);
    }
    if (!config.metrics_services) {
      toDelete.push(`${sysId}.services_total`, `${sysId}.services_failed`);
    }
    if (!config.metrics_cpu) {
      toDelete.push(`${sysId}.cpu_usage`);
    }
    if (!config.metrics_loadAvg) {
      toDelete.push(
        `${sysId}.load_avg_1m`,
        `${sysId}.load_avg_5m`,
        `${sysId}.load_avg_15m`
      );
    }
    if (!config.metrics_cpuBreakdown) {
      toDelete.push(
        `${sysId}.cpu_user`,
        `${sysId}.cpu_system`,
        `${sysId}.cpu_iowait`,
        `${sysId}.cpu_steal`,
        `${sysId}.cpu_idle`
      );
    }
    if (!config.metrics_memory) {
      toDelete.push(
        `${sysId}.memory_percent`,
        `${sysId}.memory_used`,
        `${sysId}.memory_total`
      );
    }
    if (!config.metrics_memoryDetails) {
      toDelete.push(`${sysId}.memory_buffers`, `${sysId}.memory_zfs_arc`);
    }
    if (!config.metrics_swap) {
      toDelete.push(`${sysId}.swap_used`, `${sysId}.swap_total`);
    }
    if (!config.metrics_disk) {
      toDelete.push(
        `${sysId}.disk_percent`,
        `${sysId}.disk_used`,
        `${sysId}.disk_total`
      );
    }
    if (!config.metrics_diskSpeed) {
      toDelete.push(`${sysId}.disk_read`, `${sysId}.disk_write`);
    }
    if (!config.metrics_network) {
      toDelete.push(`${sysId}.network_sent`, `${sysId}.network_recv`);
    }
    if (!config.metrics_temperature) {
      toDelete.push(`${sysId}.temperature`);
    }
    if (!config.metrics_battery) {
      toDelete.push(`${sysId}.battery_percent`, `${sysId}.battery_charging`);
    }
    for (const id of toDelete) {
      const obj = await this.adapter.getObjectAsync(id);
      if (obj) {
        await this.adapter.delObjectAsync(id);
      }
    }
    if (!config.metrics_temperatureDetails) {
      await this.deleteChannelIfExists(`${sysId}.temperatures`);
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
  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------
  async updateStatsStates(sysId, system, stats, config) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m, _n, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y, _z, _A;
    if (config.metrics_cpu) {
      await this.createAndSetState(
        `${sysId}.cpu_usage`,
        {
          name: "CPU Usage",
          type: "number",
          role: "level",
          unit: "%",
          min: 0,
          max: 100,
          read: true,
          write: false
        },
        (_a = stats.cpu) != null ? _a : null
      );
    }
    if (config.metrics_loadAvg) {
      await this.createLoadAvgStates(sysId, (_b = stats.la) != null ? _b : system.info.la);
    }
    if (config.metrics_cpuBreakdown && stats.cpub && stats.cpub.length >= 5) {
      const [user, sys, iowait, steal, idle] = stats.cpub;
      await this.createAndSetState(
        `${sysId}.cpu_user`,
        {
          name: "CPU User %",
          type: "number",
          role: "level",
          unit: "%",
          min: 0,
          max: 100,
          read: true,
          write: false
        },
        user
      );
      await this.createAndSetState(
        `${sysId}.cpu_system`,
        {
          name: "CPU System %",
          type: "number",
          role: "level",
          unit: "%",
          min: 0,
          max: 100,
          read: true,
          write: false
        },
        sys
      );
      await this.createAndSetState(
        `${sysId}.cpu_iowait`,
        {
          name: "CPU IOWait %",
          type: "number",
          role: "level",
          unit: "%",
          min: 0,
          max: 100,
          read: true,
          write: false
        },
        iowait
      );
      await this.createAndSetState(
        `${sysId}.cpu_steal`,
        {
          name: "CPU Steal %",
          type: "number",
          role: "level",
          unit: "%",
          min: 0,
          max: 100,
          read: true,
          write: false
        },
        steal
      );
      await this.createAndSetState(
        `${sysId}.cpu_idle`,
        {
          name: "CPU Idle %",
          type: "number",
          role: "level",
          unit: "%",
          min: 0,
          max: 100,
          read: true,
          write: false
        },
        idle
      );
    }
    if (config.metrics_memory) {
      await this.createAndSetState(
        `${sysId}.memory_percent`,
        {
          name: "Memory %",
          type: "number",
          role: "level",
          unit: "%",
          min: 0,
          max: 100,
          read: true,
          write: false
        },
        (_c = stats.mp) != null ? _c : null
      );
      await this.createAndSetState(
        `${sysId}.memory_used`,
        {
          name: "Memory Used",
          type: "number",
          role: "value",
          unit: "GB",
          read: true,
          write: false
        },
        (_d = stats.mu) != null ? _d : null
      );
      await this.createAndSetState(
        `${sysId}.memory_total`,
        {
          name: "Memory Total",
          type: "number",
          role: "value",
          unit: "GB",
          read: true,
          write: false
        },
        (_e = stats.m) != null ? _e : null
      );
    }
    if (config.metrics_memoryDetails) {
      await this.createAndSetState(
        `${sysId}.memory_buffers`,
        {
          name: "Memory Buffers+Cache",
          type: "number",
          role: "value",
          unit: "GB",
          read: true,
          write: false
        },
        (_f = stats.mb) != null ? _f : null
      );
      await this.createAndSetState(
        `${sysId}.memory_zfs_arc`,
        {
          name: "Memory ZFS ARC",
          type: "number",
          role: "value",
          unit: "GB",
          read: true,
          write: false
        },
        (_g = stats.mz) != null ? _g : null
      );
    }
    if (config.metrics_swap) {
      await this.createAndSetState(
        `${sysId}.swap_used`,
        {
          name: "Swap Used",
          type: "number",
          role: "value",
          unit: "GB",
          read: true,
          write: false
        },
        (_h = stats.su) != null ? _h : null
      );
      await this.createAndSetState(
        `${sysId}.swap_total`,
        {
          name: "Swap Total",
          type: "number",
          role: "value",
          unit: "GB",
          read: true,
          write: false
        },
        (_i = stats.s) != null ? _i : null
      );
    }
    if (config.metrics_disk) {
      await this.createAndSetState(
        `${sysId}.disk_percent`,
        {
          name: "Disk %",
          type: "number",
          role: "level",
          unit: "%",
          min: 0,
          max: 100,
          read: true,
          write: false
        },
        (_j = stats.dp) != null ? _j : null
      );
      await this.createAndSetState(
        `${sysId}.disk_used`,
        {
          name: "Disk Used",
          type: "number",
          role: "value",
          unit: "GB",
          read: true,
          write: false
        },
        (_k = stats.du) != null ? _k : null
      );
      await this.createAndSetState(
        `${sysId}.disk_total`,
        {
          name: "Disk Total",
          type: "number",
          role: "value",
          unit: "GB",
          read: true,
          write: false
        },
        (_l = stats.d) != null ? _l : null
      );
    }
    if (config.metrics_diskSpeed) {
      await this.createAndSetState(
        `${sysId}.disk_read`,
        {
          name: "Disk Read",
          type: "number",
          role: "value",
          unit: "MB/s",
          read: true,
          write: false
        },
        (_m = stats.dr) != null ? _m : null
      );
      await this.createAndSetState(
        `${sysId}.disk_write`,
        {
          name: "Disk Write",
          type: "number",
          role: "value",
          unit: "MB/s",
          read: true,
          write: false
        },
        (_n = stats.dw) != null ? _n : null
      );
    }
    if (config.metrics_network) {
      await this.createAndSetState(
        `${sysId}.network_sent`,
        {
          name: "Network Sent",
          type: "number",
          role: "value",
          unit: "MB/s",
          read: true,
          write: false
        },
        (_o = stats.ns) != null ? _o : null
      );
      await this.createAndSetState(
        `${sysId}.network_recv`,
        {
          name: "Network Received",
          type: "number",
          role: "value",
          unit: "MB/s",
          read: true,
          write: false
        },
        (_p = stats.nr) != null ? _p : null
      );
    }
    if (config.metrics_temperature) {
      const avgTemp = this.computeTopAvgTemp(stats.t);
      await this.createAndSetState(
        `${sysId}.temperature`,
        {
          name: "Temperature (avg top 3)",
          type: "number",
          role: "value.temperature",
          unit: "\xB0C",
          read: true,
          write: false
        },
        avgTemp
      );
    }
    if (config.metrics_temperatureDetails && stats.t) {
      await this.ensureChannel(`${sysId}.temperatures`, "Temperatures");
      for (const [sensor, temp] of Object.entries(stats.t)) {
        const sensorId = this.sanitize(sensor);
        await this.createAndSetState(
          `${sysId}.temperatures.${sensorId}`,
          {
            name: sensor,
            type: "number",
            role: "value.temperature",
            unit: "\xB0C",
            read: true,
            write: false
          },
          temp
        );
      }
    } else if (!config.metrics_temperatureDetails) {
      await this.deleteChannelIfExists(`${sysId}.temperatures`);
    }
    if (config.metrics_battery) {
      const bat = (_q = stats.bat) != null ? _q : system.info.bat;
      await this.createAndSetState(
        `${sysId}.battery_percent`,
        {
          name: "Battery %",
          type: "number",
          role: "value",
          unit: "%",
          min: 0,
          max: 100,
          read: true,
          write: false
        },
        (_r = bat == null ? void 0 : bat[0]) != null ? _r : null
      );
      await this.createAndSetState(
        `${sysId}.battery_charging`,
        {
          name: "Battery Charging",
          type: "boolean",
          role: "indicator",
          read: true,
          write: false
        },
        bat ? bat[1] > 0 : null
      );
    }
    if (config.metrics_gpu && stats.g && Object.keys(stats.g).length > 0) {
      await this.ensureChannel(`${sysId}.gpu`, "GPU");
      for (const [gpuId, gpuData] of Object.entries(stats.g)) {
        const safeId = this.sanitize(gpuId);
        const gpuLabel = (_s = gpuData.n) != null ? _s : gpuId;
        await this.ensureChannel(`${sysId}.gpu.${safeId}`, gpuLabel);
        await this.createAndSetState(
          `${sysId}.gpu.${safeId}.usage`,
          {
            name: "GPU Usage",
            type: "number",
            role: "level",
            unit: "%",
            min: 0,
            max: 100,
            read: true,
            write: false
          },
          (_t = gpuData.u) != null ? _t : null
        );
        await this.createAndSetState(
          `${sysId}.gpu.${safeId}.memory_used`,
          {
            name: "GPU Memory Used",
            type: "number",
            role: "value",
            unit: "GB",
            read: true,
            write: false
          },
          (_u = gpuData.mu) != null ? _u : null
        );
        await this.createAndSetState(
          `${sysId}.gpu.${safeId}.memory_total`,
          {
            name: "GPU Memory Total",
            type: "number",
            role: "value",
            unit: "GB",
            read: true,
            write: false
          },
          (_v = gpuData.mt) != null ? _v : null
        );
        await this.createAndSetState(
          `${sysId}.gpu.${safeId}.power`,
          {
            name: "GPU Power",
            type: "number",
            role: "value",
            unit: "W",
            read: true,
            write: false
          },
          (_w = gpuData.p) != null ? _w : null
        );
      }
    } else if (!config.metrics_gpu) {
      await this.deleteChannelIfExists(`${sysId}.gpu`);
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
          {
            name: "Disk %",
            type: "number",
            role: "level",
            unit: "%",
            min: 0,
            max: 100,
            read: true,
            write: false
          },
          percent
        );
        await this.createAndSetState(
          `${sysId}.filesystems.${safeId}.disk_used`,
          {
            name: "Disk Used",
            type: "number",
            role: "value",
            unit: "GB",
            read: true,
            write: false
          },
          used
        );
        await this.createAndSetState(
          `${sysId}.filesystems.${safeId}.disk_total`,
          {
            name: "Disk Total",
            type: "number",
            role: "value",
            unit: "GB",
            read: true,
            write: false
          },
          total
        );
        await this.createAndSetState(
          `${sysId}.filesystems.${safeId}.read_speed`,
          {
            name: "Read Speed",
            type: "number",
            role: "value",
            unit: "MB/s",
            read: true,
            write: false
          },
          (_z = fsData.r) != null ? _z : null
        );
        await this.createAndSetState(
          `${sysId}.filesystems.${safeId}.write_speed`,
          {
            name: "Write Speed",
            type: "number",
            role: "value",
            unit: "MB/s",
            read: true,
            write: false
          },
          (_A = fsData.w) != null ? _A : null
        );
      }
    } else if (!config.metrics_extraFs) {
      await this.deleteChannelIfExists(`${sysId}.filesystems`);
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
        {
          name: "Status",
          type: "string",
          role: "text",
          read: true,
          write: false
        },
        container.status
      );
      await this.createAndSetState(
        `${sysId}.containers.${cId}.health`,
        {
          name: "Health",
          type: "string",
          role: "text",
          read: true,
          write: false
        },
        (_a = healthLabels[container.health]) != null ? _a : "unknown"
      );
      await this.createAndSetState(
        `${sysId}.containers.${cId}.cpu`,
        {
          name: "CPU Usage",
          type: "number",
          role: "level",
          unit: "%",
          min: 0,
          max: 100,
          read: true,
          write: false
        },
        container.cpu
      );
      await this.createAndSetState(
        `${sysId}.containers.${cId}.memory`,
        {
          name: "Memory",
          type: "number",
          role: "value",
          unit: "MB",
          read: true,
          write: false
        },
        container.memory
      );
      await this.createAndSetState(
        `${sysId}.containers.${cId}.image`,
        {
          name: "Image",
          type: "string",
          role: "text",
          read: true,
          write: false
        },
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
   * @param sysId - State ID prefix (e.g. "systems.my_server")
   * @param la - Load average tuple [1m, 5m, 15m], or undefined
   */
  async createLoadAvgStates(sysId, la) {
    var _a, _b, _c;
    await this.createAndSetState(
      `${sysId}.load_avg_1m`,
      {
        name: "Load Average 1m",
        type: "number",
        role: "value",
        read: true,
        write: false
      },
      (_a = la == null ? void 0 : la[0]) != null ? _a : null
    );
    await this.createAndSetState(
      `${sysId}.load_avg_5m`,
      {
        name: "Load Average 5m",
        type: "number",
        role: "value",
        read: true,
        write: false
      },
      (_b = la == null ? void 0 : la[1]) != null ? _b : null
    );
    await this.createAndSetState(
      `${sysId}.load_avg_15m`,
      {
        name: "Load Average 15m",
        type: "number",
        role: "value",
        read: true,
        write: false
      },
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
