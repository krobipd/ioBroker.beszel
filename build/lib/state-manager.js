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
var import_coerce = require("./coerce");
var import_i18n_states = require("./i18n-states");
class StateManager {
  adapter;
  /**
   * Tracks IDs we already created via `setObjectNotExistsAsync`. Skipping the
   * call on subsequent polls avoids a redundant js-controller round-trip per
   * state per system per minute.
   */
  createdIds = /* @__PURE__ */ new Set();
  /**
   * v0.4.3 (SM5): per-poll resolved safeName per system.id. Built once via
   * `prepareForPoll(systems)` before per-system updates run in parallel.
   */
  resolvedSafeNames = /* @__PURE__ */ new Map();
  /**
   * @param adapter The ioBroker adapter instance
   */
  constructor(adapter) {
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
  sanitize(name) {
    if (typeof name !== "string") {
      return "";
    }
    return name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 50);
  }
  /**
   * v0.4.3 (SM5): Sanitize + suffix with a stable hash of `uniqueKey` so two
   * records with the same post-sanitize name don't overwrite each other.
   *
   * @param name Raw display name to sanitize.
   * @param uniqueKey Stable identifier (e.g. PocketBase record id) used to
   *   derive the suffix.
   */
  sanitizeWithSuffix(name, uniqueKey) {
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
  static shortHash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 16777619);
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
  prepareForPoll(systems) {
    var _a;
    this.resolvedSafeNames.clear();
    const sorted = [...systems].sort((a, b) => a.id.localeCompare(b.id));
    const seen = /* @__PURE__ */ new Set();
    const collisions = /* @__PURE__ */ new Map();
    for (const sys of sorted) {
      const safe = this.sanitize(sys.name);
      if (!safe) {
        this.resolvedSafeNames.set(sys.id, "");
        continue;
      }
      if (seen.has(safe)) {
        const arr = (_a = collisions.get(safe)) != null ? _a : [];
        arr.push(sys);
        collisions.set(safe, arr);
        this.resolvedSafeNames.set(sys.id, this.sanitizeWithSuffix(sys.name, sys.id));
      } else {
        seen.add(safe);
        this.resolvedSafeNames.set(sys.id, safe);
      }
    }
    for (const [safe, dupes] of collisions) {
      const names = dupes.map((s) => `${s.name}(${s.id.slice(0, 8)})`).join(", ");
      this.adapter.log.warn(
        `Multiple systems sanitize to '${safe}' (${names}) \u2014 adding hash suffix to disambiguate. Consider renaming on the Hub.`
      );
    }
  }
  /**
   * Resolved safeName from `prepareForPoll`, or fresh `sanitize(name)` fallback.
   *
   * @param system The Beszel system whose ID-segment we want.
   */
  resolvedSafeName(system) {
    const cached = this.resolvedSafeNames.get(system.id);
    return cached !== void 0 ? cached : this.sanitize(system.name);
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
    const safeName = this.resolvedSafeName(system);
    if (safeName.length === 0) {
      this.adapter.log.warn(
        `Skipping system with unusable name: ${typeof system.name === "string" ? system.name : JSON.stringify(system.name)}`
      );
      return;
    }
    const sysId = `systems.${safeName}`;
    this.adapter.log.debug(`updateSystem state-tree: '${system.name}' \u2192 safeName='${safeName}'`);
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
    await this.ensureChannel(`${sysId}.info`, (0, import_i18n_states.tName)("channelInfo"));
    await this.createAndSetState(
      `${sysId}.info.online`,
      this.boolCommon((0, import_i18n_states.tName)("online"), "indicator.reachable"),
      system.status === "up"
    );
    await this.createAndSetState(`${sysId}.info.status`, this.textCommon((0, import_i18n_states.tName)("status")), system.status);
    if (config.metrics_uptime) {
      const uptime = (_a = system.info.u) != null ? _a : null;
      await this.createAndSetState(`${sysId}.info.uptime`, this.numCommon((0, import_i18n_states.tName)("uptime"), "s"), uptime);
      await this.createAndSetState(
        `${sysId}.info.uptime_text`,
        this.textCommon((0, import_i18n_states.tName)("uptimeFormatted")),
        uptime !== null ? this.formatUptime(uptime) : null
      );
    }
    if (config.metrics_agentVersion) {
      await this.createAndSetState(
        `${sysId}.info.agent_version`,
        this.textCommon((0, import_i18n_states.tName)("agentVersion")),
        (_b = system.info.v) != null ? _b : null
      );
    }
    if (config.metrics_services) {
      const sv = system.info.sv;
      await this.createAndSetState(
        `${sysId}.info.services_total`,
        this.numCommon((0, import_i18n_states.tName)("servicesTotal")),
        (_c = sv == null ? void 0 : sv[0]) != null ? _c : null
      );
      await this.createAndSetState(
        `${sysId}.info.services_failed`,
        this.numCommon((0, import_i18n_states.tName)("servicesFailed")),
        (_d = sv == null ? void 0 : sv[1]) != null ? _d : null
      );
    }
    if (stats) {
      await this.updateStatsStates(sysId, system, stats, config);
    }
    if (config.metrics_loadAvg && !stats) {
      await this.ensureChannel(`${sysId}.cpu`, (0, import_i18n_states.tName)("channelCpu"));
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
    for (const safe of this.resolvedSafeNames.values()) {
      if (safe) {
        activeSet.add(safe);
      }
    }
    const existing = await this.getExistingSystemNames();
    const stale = existing.filter((name) => !activeSet.has(name));
    await Promise.all(
      stale.map(async (name) => {
        this.adapter.log.debug(`Removing stale system: systems.${name}`);
        await this.adapter.delObjectAsync(`systems.${name}`, { recursive: true });
        this.dropCacheUnder(`systems.${name}`);
      })
    );
  }
  /**
   * Drop every cached ID at or under the given prefix. Call after recursive
   * delObject so subsequent polls re-create the object instead of skipping it.
   *
   * @param prefix State ID prefix (e.g. `systems.my_server`)
   */
  dropCacheUnder(prefix) {
    const exact = prefix;
    const dot = `${prefix}.`;
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
        `${sysId}.cpu.idle`
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
    await Promise.all(
      toDelete.map(async (id) => {
        const obj = await this.adapter.getObjectAsync(id);
        if (obj) {
          await this.adapter.delObjectAsync(id);
          this.createdIds.delete(id);
        }
      })
    );
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
    this.adapter.log.debug(
      `migrateLegacyStates: scanning ${existingNames.length} existing system(s) for legacy flat states`
    );
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
    const counts = await Promise.all(
      existingNames.map(async (name) => {
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
      })
    );
    const migrated = counts.reduce((a, b) => a + b, 0);
    if (migrated > 0) {
      this.adapter.log.info(`Migration: removed ${migrated} legacy state(s) from flat structure`);
    }
  }
  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------
  async updateStatsStates(sysId, system, stats, config) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m, _n, _o, _p, _q, _r, _s, _t, _u, _v, _w, _x, _y, _z, _A;
    if (config.metrics_cpu || config.metrics_loadAvg || config.metrics_cpuBreakdown) {
      await this.ensureChannel(`${sysId}.cpu`, (0, import_i18n_states.tName)("channelCpu"));
    }
    if (config.metrics_memory || config.metrics_memoryDetails || config.metrics_swap) {
      await this.ensureChannel(`${sysId}.memory`, (0, import_i18n_states.tName)("channelMemory"));
    }
    if (config.metrics_disk || config.metrics_diskSpeed) {
      await this.ensureChannel(`${sysId}.disk`, (0, import_i18n_states.tName)("channelDisk"));
    }
    if (config.metrics_network) {
      await this.ensureChannel(`${sysId}.network`, (0, import_i18n_states.tName)("channelNetwork"));
    }
    if (config.metrics_temperature || config.metrics_temperatureDetails) {
      await this.ensureChannel(`${sysId}.temperature`, (0, import_i18n_states.tName)("channelTemperature"));
    }
    if (config.metrics_battery) {
      await this.ensureChannel(`${sysId}.battery`, (0, import_i18n_states.tName)("channelBattery"));
    }
    if (config.metrics_cpu) {
      await this.createAndSetState(`${sysId}.cpu.usage`, this.percentCommon((0, import_i18n_states.tName)("cpuUsage")), (_a = stats.cpu) != null ? _a : null);
    }
    if (config.metrics_loadAvg) {
      await this.createLoadAvgStates(sysId, (_b = stats.la) != null ? _b : system.info.la);
    }
    if (config.metrics_cpuBreakdown && stats.cpub && stats.cpub.length >= 5) {
      const [user, sys, iowait, steal, idle] = stats.cpub;
      await this.createAndSetState(`${sysId}.cpu.user`, this.percentCommon((0, import_i18n_states.tName)("cpuUser")), user);
      await this.createAndSetState(`${sysId}.cpu.system`, this.percentCommon((0, import_i18n_states.tName)("cpuSystem")), sys);
      await this.createAndSetState(`${sysId}.cpu.iowait`, this.percentCommon((0, import_i18n_states.tName)("cpuIowait")), iowait);
      await this.createAndSetState(`${sysId}.cpu.steal`, this.percentCommon((0, import_i18n_states.tName)("cpuSteal")), steal);
      await this.createAndSetState(`${sysId}.cpu.idle`, this.percentCommon((0, import_i18n_states.tName)("cpuIdle")), idle);
    }
    if (config.metrics_memory) {
      await this.createAndSetState(
        `${sysId}.memory.percent`,
        this.percentCommon((0, import_i18n_states.tName)("memoryPercent")),
        (_c = stats.mp) != null ? _c : null
      );
      await this.createAndSetState(`${sysId}.memory.used`, this.numCommon((0, import_i18n_states.tName)("memoryUsed"), "GB"), (_d = stats.mu) != null ? _d : null);
      await this.createAndSetState(
        `${sysId}.memory.total`,
        this.numCommon((0, import_i18n_states.tName)("memoryTotal"), "GB"),
        (_e = stats.m) != null ? _e : null
      );
    }
    if (config.metrics_memoryDetails) {
      await this.createAndSetState(
        `${sysId}.memory.buffers`,
        this.numCommon((0, import_i18n_states.tName)("memoryBuffers"), "GB"),
        (_f = stats.mb) != null ? _f : null
      );
      await this.createAndSetState(
        `${sysId}.memory.zfs_arc`,
        this.numCommon((0, import_i18n_states.tName)("memoryZfsArc"), "GB"),
        (_g = stats.mz) != null ? _g : null
      );
    }
    if (config.metrics_swap) {
      await this.createAndSetState(
        `${sysId}.memory.swap_used`,
        this.numCommon((0, import_i18n_states.tName)("swapUsed"), "GB"),
        (_h = stats.su) != null ? _h : null
      );
      await this.createAndSetState(
        `${sysId}.memory.swap_total`,
        this.numCommon((0, import_i18n_states.tName)("swapTotal"), "GB"),
        (_i = stats.s) != null ? _i : null
      );
    }
    if (config.metrics_disk) {
      await this.createAndSetState(`${sysId}.disk.percent`, this.percentCommon((0, import_i18n_states.tName)("diskPercent")), (_j = stats.dp) != null ? _j : null);
      await this.createAndSetState(`${sysId}.disk.used`, this.numCommon((0, import_i18n_states.tName)("diskUsed"), "GB"), (_k = stats.du) != null ? _k : null);
      await this.createAndSetState(`${sysId}.disk.total`, this.numCommon((0, import_i18n_states.tName)("diskTotal"), "GB"), (_l = stats.d) != null ? _l : null);
    }
    if (config.metrics_diskSpeed) {
      await this.createAndSetState(`${sysId}.disk.read`, this.numCommon((0, import_i18n_states.tName)("diskRead"), "MB/s"), (_m = stats.dr) != null ? _m : null);
      await this.createAndSetState(`${sysId}.disk.write`, this.numCommon((0, import_i18n_states.tName)("diskWrite"), "MB/s"), (_n = stats.dw) != null ? _n : null);
    }
    if (config.metrics_network) {
      await this.createAndSetState(
        `${sysId}.network.sent`,
        this.numCommon((0, import_i18n_states.tName)("networkSent"), "MB/s"),
        (_o = stats.ns) != null ? _o : null
      );
      await this.createAndSetState(
        `${sysId}.network.recv`,
        this.numCommon((0, import_i18n_states.tName)("networkReceived"), "MB/s"),
        (_p = stats.nr) != null ? _p : null
      );
    }
    if (config.metrics_temperature) {
      await this.createAndSetState(
        `${sysId}.temperature.average`,
        this.numCommon((0, import_i18n_states.tName)("temperatureAvg"), "\xB0C", "value.temperature"),
        this.computeTopAvgTemp(stats.t)
      );
    }
    if (config.metrics_temperatureDetails && stats.t) {
      await this.ensureChannel(`${sysId}.temperature.sensors`, (0, import_i18n_states.tName)("channelSensors"));
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
        this.percentCommon((0, import_i18n_states.tName)("batteryPercent")),
        (_r = bat == null ? void 0 : bat[0]) != null ? _r : null
      );
      await this.createAndSetState(
        `${sysId}.battery.charging`,
        this.boolCommon((0, import_i18n_states.tName)("batteryCharging")),
        bat ? bat[1] > 0 : null
      );
    }
    if (config.metrics_gpu && stats.g && Object.keys(stats.g).length > 0) {
      await this.ensureChannel(`${sysId}.gpu`, (0, import_i18n_states.tName)("channelGpu"));
      for (const [gpuId, gpuData] of Object.entries(stats.g)) {
        const safeId = this.sanitize(gpuId);
        await this.ensureChannel(`${sysId}.gpu.${safeId}`, (_s = gpuData.n) != null ? _s : gpuId);
        await this.createAndSetState(
          `${sysId}.gpu.${safeId}.usage`,
          this.percentCommon((0, import_i18n_states.tName)("gpuUsage")),
          (_t = gpuData.u) != null ? _t : null
        );
        await this.createAndSetState(
          `${sysId}.gpu.${safeId}.memory_used`,
          this.numCommon((0, import_i18n_states.tName)("gpuMemoryUsed"), "GB"),
          (_u = gpuData.mu) != null ? _u : null
        );
        await this.createAndSetState(
          `${sysId}.gpu.${safeId}.memory_total`,
          this.numCommon((0, import_i18n_states.tName)("gpuMemoryTotal"), "GB"),
          (_v = gpuData.mt) != null ? _v : null
        );
        await this.createAndSetState(
          `${sysId}.gpu.${safeId}.power`,
          this.numCommon((0, import_i18n_states.tName)("gpuPower"), "W"),
          (_w = gpuData.p) != null ? _w : null
        );
      }
    }
    if (config.metrics_extraFs && stats.efs && Object.keys(stats.efs).length > 0) {
      await this.ensureChannel(`${sysId}.filesystems`, (0, import_i18n_states.tName)("channelFilesystems"));
      for (const [fsName, fsData] of Object.entries(stats.efs)) {
        const safeId = this.sanitize(fsName);
        await this.ensureChannel(`${sysId}.filesystems.${safeId}`, fsName);
        const total = (_x = fsData.d) != null ? _x : null;
        const used = (_y = fsData.du) != null ? _y : null;
        const percent = total !== null && used !== null && total > 0 ? Math.min(100, Math.max(0, Math.round(used / total * 100))) : null;
        await this.createAndSetState(
          `${sysId}.filesystems.${safeId}.disk_percent`,
          this.percentCommon((0, import_i18n_states.tName)("diskPercent")),
          percent
        );
        await this.createAndSetState(
          `${sysId}.filesystems.${safeId}.disk_used`,
          this.numCommon((0, import_i18n_states.tName)("diskUsed"), "GB"),
          used
        );
        await this.createAndSetState(
          `${sysId}.filesystems.${safeId}.disk_total`,
          this.numCommon((0, import_i18n_states.tName)("diskTotal"), "GB"),
          total
        );
        await this.createAndSetState(
          `${sysId}.filesystems.${safeId}.read_speed`,
          this.numCommon((0, import_i18n_states.tName)("readSpeed"), "MB/s"),
          (_z = fsData.r) != null ? _z : null
        );
        await this.createAndSetState(
          `${sysId}.filesystems.${safeId}.write_speed`,
          this.numCommon((0, import_i18n_states.tName)("writeSpeed"), "MB/s"),
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
    await this.ensureChannel(`${sysId}.containers`, (0, import_i18n_states.tName)("channelContainers"));
    const healthLabels = ["none", "starting", "healthy", "unhealthy"];
    for (const container of sysContainers) {
      const cId = this.sanitize(container.name);
      if (cId.length === 0) {
        continue;
      }
      await this.ensureChannel(`${sysId}.containers.${cId}`, container.name);
      await this.createAndSetState(
        `${sysId}.containers.${cId}.status`,
        this.textCommon((0, import_i18n_states.tName)("status")),
        container.status
      );
      const healthIdx = Math.floor(container.health);
      await this.createAndSetState(
        `${sysId}.containers.${cId}.health`,
        this.textCommon((0, import_i18n_states.tName)("containerHealth")),
        (_a = healthLabels[healthIdx]) != null ? _a : "unknown"
      );
      await this.createAndSetState(
        `${sysId}.containers.${cId}.cpu`,
        this.percentCommon((0, import_i18n_states.tName)("cpuUsage")),
        container.cpu
      );
      await this.createAndSetState(
        `${sysId}.containers.${cId}.memory`,
        this.numCommon((0, import_i18n_states.tName)("containerMemory"), "MB"),
        container.memory
      );
      await this.createAndSetState(
        `${sysId}.containers.${cId}.image`,
        this.textCommon((0, import_i18n_states.tName)("containerImage")),
        container.image
      );
    }
  }
  async ensureChannel(id, name) {
    if (this.createdIds.has(id)) {
      return;
    }
    await this.adapter.setObjectNotExistsAsync(id, {
      type: "channel",
      common: { name },
      native: {}
    });
    this.createdIds.add(id);
  }
  async deleteChannelIfExists(id) {
    try {
      const obj = await this.adapter.getObjectAsync(id);
      if (obj) {
        await this.adapter.delObjectAsync(id, { recursive: true });
        this.dropCacheUnder(id);
      }
    } catch (err) {
      this.adapter.log.debug(`deleteChannelIfExists(${id}) ignored: ${(0, import_coerce.errText)(err)}`);
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
    await this.createAndSetState(`${sysId}.cpu.load_1m`, this.numCommon((0, import_i18n_states.tName)("load1m")), (_a = la == null ? void 0 : la[0]) != null ? _a : null);
    await this.createAndSetState(`${sysId}.cpu.load_5m`, this.numCommon((0, import_i18n_states.tName)("load5m")), (_b = la == null ? void 0 : la[1]) != null ? _b : null);
    await this.createAndSetState(`${sysId}.cpu.load_15m`, this.numCommon((0, import_i18n_states.tName)("load15m")), (_c = la == null ? void 0 : la[2]) != null ? _c : null);
  }
  async createAndSetState(id, common, value) {
    if (!this.createdIds.has(id)) {
      await this.adapter.setObjectNotExistsAsync(id, {
        type: "state",
        common,
        native: {}
      });
      this.createdIds.add(id);
    }
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
    const values = Object.values(temps).filter((v) => typeof v === "number" && isFinite(v));
    if (values.length === 0) {
      return null;
    }
    values.sort((a, b) => b - a);
    const top3 = values.slice(0, 3);
    const avg = top3.reduce((sum, v) => sum + v, 0) / top3.length;
    return Math.round(avg * 10) / 10;
  }
  formatUptime(seconds) {
    const s = Math.max(0, seconds);
    const d = Math.floor(s / 86400);
    const h = Math.floor(s % 86400 / 3600);
    const m = Math.floor(s % 3600 / 60);
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
