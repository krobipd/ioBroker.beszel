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
var import_i18n = require("./i18n");
var import_metric_registry = require("./metric-registry");
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
  /** L5: collision bases already warned about — the warn fires once, not every poll. */
  warnedCollisions = /* @__PURE__ */ new Set();
  /**
   * v0.7.2: per dynamic group (`<sysId>.<group>` → set of child segments seen
   * in the last poll). Used by {@link pruneDynamicChildren} to delete states
   * of disappeared members (renamed interface, removed GPU/sensor/filesystem,
   * stopped container) without a DB round-trip per poll — the object view is
   * queried only once per group after adapter start (reconciles zombies from
   * previous runs), afterwards the in-memory diff does the work.
   */
  dynamicChildren = /* @__PURE__ */ new Map();
  /**
   * H2: per dynamic group (`<sysId>.<group>`, incl. containers) → was the group
   * empty on the previous poll. Debounces the drop-to-zero prune: a single empty
   * response (the `g/efs/t/ni` maps are `omitempty` on the wire, so a transient
   * gap drops the key) must not wipe the group's states — only a second
   * consecutive empty confirms removal. Replaces the old global `lastContainersEmpty`.
   */
  lastGroupEmpty = /* @__PURE__ */ new Map();
  /**
   * v0.7.2: last-written device-object signature per sysId (`id|host|name`).
   * `updateSystem` used to extendObject the device on EVERY poll — one write
   * + objectChange event per system per minute for data that practically
   * never changes. Now the write happens only when the signature differs.
   */
  deviceWritten = /* @__PURE__ */ new Map();
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
   * SEC-6: resolve one dynamic-group child id segment, disambiguating collisions
   * the same way `prepareForPoll` does for systems. The first member with a given
   * sanitized base keeps it; a later member that sanitizes to the SAME base (e.g.
   * `/mnt/data` and `/mnt-data` both → `mnt_data`, or two names sharing the first
   * 50 chars) gets a stable `__<hash>` suffix so they never overwrite each other's
   * states. Returns "" when the name is unusable (caller skips it).
   *
   * @param rawName Raw member name from the Hub.
   * @param stableKey Stable unique key for the suffix (record id, or the raw name).
   * @param seen Sanitized bases already used in this group's pass (mutated).
   */
  resolveChildId(rawName, stableKey, seen) {
    const base = this.sanitize(rawName);
    if (!base) {
      return "";
    }
    if (seen.has(base)) {
      return this.sanitizeWithSuffix(rawName, stableKey);
    }
    seen.add(base);
    return base;
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
      if (this.warnedCollisions.has(safe)) {
        continue;
      }
      this.warnedCollisions.add(safe);
      const names = dupes.map((s) => `${(0, import_coerce.sanitizeForLog)(s.name)}(${s.id.slice(0, 8)})`).join(", ");
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
      endkey: `${this.adapter.namespace}.systems.\uFFFF`
    });
    if (!(objects == null ? void 0 : objects.rows)) {
      return [];
    }
    const names = [];
    for (const row of objects.rows) {
      const id = row.id.startsWith(`${this.adapter.namespace}.`) ? this.stripNamespace(row.id) : row.id;
      const parts = id.split(".");
      if (parts.length === 2 && parts[0] === "systems") {
        names.push(parts[1]);
      }
    }
    return names;
  }
  // -------------------------------------------------------------------------
  // Metric registry (K1): single source of truth for every toggled scalar
  // state. Both the create-path (`applyMetrics`) and the cleanup-path
  // (`cleanupMetrics`) iterate this list, so a metric's toggle → state-id
  // mapping can never drift between "create" and "delete".
  //
  // Dynamic groups (per-sensor temperature, per-GPU, per-filesystem,
  // per-container) are NOT in here — they fan out to N items and stay in
  // their dedicated handlers (`updateDynamicStats`, `updateContainers`).
  // -------------------------------------------------------------------------
  /**
   * Return a config copy where every detail/peak toggle whose category base is
   * disabled is forced to `false` (see `METRIC_DEPENDENCIES`). Applied at the
   * top of `updateSystem` and `cleanupMetrics` so both create- and cleanup-path
   * see the same effective values — a disabled category's sub-states are never
   * created, and existing ones are pruned.
   *
   * @param config Raw adapter configuration.
   */
  effectiveConfig(config) {
    const out = { ...config };
    for (const detail of Object.keys(import_metric_registry.METRIC_DEPENDENCIES)) {
      const base = import_metric_registry.METRIC_DEPENDENCIES[detail];
      if (!config[base]) {
        out[detail] = false;
      }
    }
    return out;
  }
  /**
   * Shared metric definitions. `extract` returns the value (or null);
   * `available` (default: always) gates state CREATION exactly like the old
   * inline guards (e.g. cpuBreakdown needs `cpub.length >= 5`). Entries that
   * need live stats set `available: hasStats`.
   *
   * Note: `loadAvg` is defined once here and falls back `stats.la ?? info.la`
   * — this unifies the two old code paths (with-stats in updateStatsStates,
   * without-stats in updateSystem) that previously duplicated it.
   */
  metricDefsCache;
  /**
   * INFO: the registry is stateless — every `available`/`extract` predicate
   * takes (system, stats) as args and closes only over pure helpers, so it can
   * be built once and reused across polls/systems instead of rebuilt (and
   * re-`tName`d) on every applyMetrics/cleanupMetrics call.
   */
  metricDefs() {
    var _a;
    return (_a = this.metricDefsCache) != null ? _a : this.metricDefsCache = (0, import_metric_registry.buildMetricDefs)();
  }
  /**
   * Create + set every enabled scalar metric for one system, driven by the
   * registry. Ensures each needed channel once.
   *
   * @param sysId State prefix (`systems.<safeName>`)
   * @param system The Beszel system record
   * @param stats Latest stats, or undefined
   * @param config Current adapter configuration
   */
  async applyMetrics(sysId, system, stats, config) {
    const active = this.metricDefs().filter((d) => {
      if (!config[d.toggle]) {
        return false;
      }
      if (!d.available || d.available(stats, system)) {
        return true;
      }
      return this.createdIds.has(`${sysId}.${d.id}`);
    });
    const channels = new Set(active.map((d) => d.channel));
    for (const ch of channels) {
      await this.ensureChannel(`${sysId}.${ch}`, (0, import_metric_registry.channelName)(ch));
    }
    for (const def of active) {
      const raw = def.extract(system, stats);
      const value = def.kind === "percent" && typeof raw === "number" ? (0, import_metric_registry.clampPercent)(raw) : raw;
      await this.createAndSetState(`${sysId}.${def.id}`, (0, import_metric_registry.commonFor)(def), value);
    }
  }
  /**
   * Update all states for a single system.
   *
   * @param system Beszel system record
   * @param stats Latest stats for this system, or undefined if unavailable
   * @param containers Container records belonging to this system
   * @param rawConfig Adapter configuration (detail toggles are gated on their category base via effectiveConfig)
   */
  async updateSystem(system, stats, containers, rawConfig) {
    const config = this.effectiveConfig(rawConfig);
    const safeName = this.resolvedSafeName(system);
    if (safeName.length === 0) {
      this.adapter.log.warn(
        `Skipping system with unusable name: ${(0, import_coerce.sanitizeForLog)(typeof system.name === "string" ? system.name : JSON.stringify(system.name))}`
      );
      return;
    }
    const sysId = `systems.${safeName}`;
    this.adapter.log.debug(`updateSystem state-tree: '${(0, import_coerce.sanitizeForLog)(system.name)}' \u2192 safeName='${safeName}'`);
    const deviceSig = `${system.id} ${system.host} ${system.name}`;
    if (this.deviceWritten.get(sysId) !== deviceSig) {
      await this.adapter.extendObject(
        sysId,
        {
          type: "device",
          common: {
            name: system.name,
            statusStates: {
              onlineId: `${this.adapter.namespace}.${sysId}.info.online`
            }
          },
          native: { id: system.id, host: system.host }
        },
        { preserve: { common: ["name"] } }
      );
      this.deviceWritten.set(sysId, deviceSig);
    }
    await this.ensureChannel(`${sysId}.info`, (0, import_metric_registry.channelName)("info"));
    await this.createAndSetState(
      `${sysId}.info.online`,
      (0, import_metric_registry.boolCommon)((0, import_i18n.tName)("online"), "indicator.reachable"),
      system.status === "up"
    );
    await this.createAndSetState(
      `${sysId}.info.status`,
      {
        ...(0, import_metric_registry.textCommon)((0, import_i18n.tName)("status"), "info.status"),
        states: { up: "Online", down: "Offline", paused: "Paused", pending: "Pending" }
      },
      system.status
    );
    await this.applyMetrics(sysId, system, stats, config);
    if (stats) {
      await this.updateDynamicStats(sysId, stats, config);
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
    for (const key of [...this.dynamicChildren.keys()]) {
      if (key === exact || key.startsWith(dot)) {
        this.dynamicChildren.delete(key);
      }
    }
    for (const key of [...this.deviceWritten.keys()]) {
      if (key === exact || key.startsWith(dot)) {
        this.deviceWritten.delete(key);
      }
    }
    for (const key of [...this.lastGroupEmpty.keys()]) {
      if (key === exact || key.startsWith(dot)) {
        this.lastGroupEmpty.delete(key);
      }
    }
  }
  /**
   * Delete states for metrics that have been disabled in the config.
   * Called on startup to clean up previously-enabled states.
   *
   * @param systemId Sanitized system name (the part after "systems.")
   * @param rawConfig Adapter configuration (detail toggles are gated on their category base via effectiveConfig)
   */
  async cleanupMetrics(systemId, rawConfig) {
    var _a, _b, _c;
    const config = this.effectiveConfig(rawConfig);
    const sysId = `systems.${systemId}`;
    const toDelete = [];
    for (const def of this.metricDefs()) {
      if (!config[def.toggle]) {
        toDelete.push(`${sysId}.${def.id}`);
      }
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
    const channelToggles = /* @__PURE__ */ new Map();
    for (const def of this.metricDefs()) {
      if (def.channel === "info") {
        continue;
      }
      const set = (_a = channelToggles.get(def.channel)) != null ? _a : /* @__PURE__ */ new Set();
      set.add(def.toggle);
      channelToggles.set(def.channel, set);
    }
    for (const [channel, extras] of Object.entries(import_metric_registry.DYNAMIC_CHANNEL_TOGGLES)) {
      const set = (_b = channelToggles.get(channel)) != null ? _b : /* @__PURE__ */ new Set();
      for (const t of extras) {
        set.add(t);
      }
      channelToggles.set(channel, set);
    }
    for (const [channel, toggles] of channelToggles) {
      if ([...toggles].every((t) => !config[t])) {
        await this.deleteChannelIfExists(`${sysId}.${channel}`);
      }
    }
    if (!config.metrics_cpuCores) {
      await this.deleteChannelIfExists(`${sysId}.cpu.cores`);
    }
    if (!config.metrics_networkInterfaces) {
      await this.deleteChannelIfExists(`${sysId}.network.interfaces`);
    }
    if (!config.metrics_temperatureDetails) {
      await this.deleteChannelIfExists(`${sysId}.temperature.sensors`);
    }
    if (!config.metrics_gpu) {
      await this.deleteChannelIfExists(`${sysId}.gpu`);
    }
    if (config.metrics_gpu && !config.metrics_gpuDetails) {
      const view = await this.adapter.getObjectViewAsync("system", "channel", {
        startkey: `${this.adapter.namespace}.${sysId}.gpu.`,
        endkey: `${this.adapter.namespace}.${sysId}.gpu.\uFFFF`
      });
      for (const row of (_c = view == null ? void 0 : view.rows) != null ? _c : []) {
        const id = this.stripNamespace(row.id);
        const child = id.slice(`${sysId}.gpu.`.length);
        if (!child || child.includes(".")) {
          continue;
        }
        const ppId = `${sysId}.gpu.${child}.power_package`;
        const ppObj = await this.adapter.getObjectAsync(ppId);
        if (ppObj) {
          await this.adapter.delObjectAsync(ppId);
          this.createdIds.delete(ppId);
        }
        await this.deleteChannelIfExists(`${sysId}.gpu.${child}.engines`);
      }
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
    const marker = await this.adapter.getStateAsync("info.legacyMigrated");
    if ((marker == null ? void 0 : marker.val) === true) {
      return;
    }
    const existingNames = await this.getExistingSystemNames();
    if (existingNames.length === 0) {
      await this.markLegacyMigrationDone();
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
    await this.markLegacyMigrationDone();
  }
  /** L6: set the one-shot marker so later restarts skip the legacy-state scan. */
  async markLegacyMigrationDone() {
    await this.adapter.setObjectNotExistsAsync("info.legacyMigrated", {
      type: "state",
      common: {
        name: "Legacy state migration completed",
        type: "boolean",
        role: "indicator",
        read: true,
        write: false
      },
      native: {}
    });
    await this.adapter.setStateChangedAsync("info.legacyMigrated", { val: true, ack: true });
  }
  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------
  async updateDynamicStats(sysId, stats, config) {
    var _a;
    if (config.metrics_temperatureDetails) {
      await this.syncDynamicGroup(
        `${sysId}.temperature.sensors`,
        stats.t ? Object.entries(stats.t) : [],
        "state",
        async () => {
          await this.ensureChannel(`${sysId}.temperature`, (0, import_metric_registry.channelName)("temperature"));
          await this.ensureChannel(`${sysId}.temperature.sensors`, (0, import_metric_registry.channelName)("sensors"));
        },
        async (safeSensor, sensor, temp) => {
          await this.createAndSetState(
            `${sysId}.temperature.sensors.${safeSensor}`,
            (0, import_metric_registry.numCommon)((0, import_coerce.sanitizeForLog)(sensor), "\xB0C", "value.temperature"),
            temp
          );
        }
      );
    }
    if (config.metrics_cpuCores) {
      const cores = (_a = stats.cpus) != null ? _a : [];
      const activeCores = /* @__PURE__ */ new Set();
      if (cores.length > 0) {
        await this.ensureChannel(`${sysId}.cpu`, (0, import_metric_registry.channelName)("cpu"));
        await this.ensureChannel(`${sysId}.cpu.cores`, (0, import_metric_registry.channelName)("cores"));
        for (let i = 0; i < cores.length; i++) {
          activeCores.add(`core${i}`);
          await this.createAndSetState(
            `${sysId}.cpu.cores.core${i}`,
            (0, import_metric_registry.percentCommon)(`Core ${i}`),
            (0, import_metric_registry.clampPercent)(cores[i])
          );
        }
      }
      await this.pruneGroup(`${sysId}.cpu.cores`, activeCores, "state", cores.length === 0);
    }
    if (config.metrics_networkInterfaces) {
      await this.syncDynamicGroup(
        `${sysId}.network.interfaces`,
        stats.ni ? Object.entries(stats.ni) : [],
        "channel",
        async () => {
          await this.ensureChannel(`${sysId}.network`, (0, import_metric_registry.channelName)("network"));
          await this.ensureChannel(`${sysId}.network.interfaces`, (0, import_metric_registry.channelName)("interfaces"));
        },
        async (safeId, iface, vals) => {
          await this.ensureChannel(`${sysId}.network.interfaces.${safeId}`, (0, import_coerce.sanitizeForLog)(iface));
          await this.createAndSetState(
            `${sysId}.network.interfaces.${safeId}.up`,
            (0, import_metric_registry.numCommon)((0, import_i18n.tName)("ifaceUp"), "MB/s"),
            (0, import_metric_registry.bytesToMib)(vals[0])
          );
          await this.createAndSetState(
            `${sysId}.network.interfaces.${safeId}.down`,
            (0, import_metric_registry.numCommon)((0, import_i18n.tName)("ifaceDown"), "MB/s"),
            (0, import_metric_registry.bytesToMib)(vals[1])
          );
          await this.createAndSetState(
            `${sysId}.network.interfaces.${safeId}.total_up`,
            (0, import_metric_registry.numCommon)((0, import_i18n.tName)("ifaceTotalUp"), "GB"),
            (0, import_metric_registry.bytesToGib)(vals[2])
          );
          await this.createAndSetState(
            `${sysId}.network.interfaces.${safeId}.total_down`,
            (0, import_metric_registry.numCommon)((0, import_i18n.tName)("ifaceTotalDown"), "GB"),
            (0, import_metric_registry.bytesToGib)(vals[3])
          );
        }
      );
    }
    if (config.metrics_gpu) {
      await this.syncDynamicGroup(
        `${sysId}.gpu`,
        stats.g ? Object.entries(stats.g) : [],
        "channel",
        async () => {
          await this.ensureChannel(`${sysId}.gpu`, (0, import_metric_registry.channelName)("gpu"));
        },
        async (safeId, gpuId, gpuData) => {
          var _a2, _b, _c, _d, _e, _f;
          await this.ensureChannel(`${sysId}.gpu.${safeId}`, (0, import_coerce.sanitizeForLog)((_a2 = gpuData.n) != null ? _a2 : gpuId));
          await this.createAndSetState(
            `${sysId}.gpu.${safeId}.usage`,
            (0, import_metric_registry.percentCommon)((0, import_i18n.tName)("gpuUsage")),
            (0, import_metric_registry.clampPercent)((_b = gpuData.u) != null ? _b : null)
          );
          await this.createAndSetState(
            `${sysId}.gpu.${safeId}.memory_used`,
            (0, import_metric_registry.numCommon)((0, import_i18n.tName)("gpuMemoryUsed"), "MB"),
            (_c = gpuData.mu) != null ? _c : null
          );
          await this.createAndSetState(
            `${sysId}.gpu.${safeId}.memory_total`,
            (0, import_metric_registry.numCommon)((0, import_i18n.tName)("gpuMemoryTotal"), "MB"),
            (_d = gpuData.mt) != null ? _d : null
          );
          await this.createAndSetState(
            `${sysId}.gpu.${safeId}.power`,
            (0, import_metric_registry.numCommon)((0, import_i18n.tName)("gpuPower"), "W", "value.power"),
            (_e = gpuData.p) != null ? _e : null
          );
          if (config.metrics_gpuDetails) {
            await this.createAndSetState(
              `${sysId}.gpu.${safeId}.power_package`,
              (0, import_metric_registry.numCommon)((0, import_i18n.tName)("gpuPowerPackage"), "W", "value.power"),
              (_f = gpuData.pp) != null ? _f : null
            );
            await this.syncDynamicGroup(
              `${sysId}.gpu.${safeId}.engines`,
              gpuData.e ? Object.entries(gpuData.e) : [],
              "state",
              async () => {
                await this.ensureChannel(`${sysId}.gpu.${safeId}.engines`, (0, import_metric_registry.channelName)("engines"));
              },
              async (safeEngine, engine, value) => {
                await this.createAndSetState(
                  `${sysId}.gpu.${safeId}.engines.${safeEngine}`,
                  (0, import_metric_registry.percentCommon)((0, import_coerce.sanitizeForLog)(engine)),
                  (0, import_metric_registry.clampPercent)(value)
                );
              }
            );
          }
        }
      );
    }
    if (config.metrics_extraFs) {
      await this.syncDynamicGroup(
        `${sysId}.filesystems`,
        stats.efs ? Object.entries(stats.efs) : [],
        "channel",
        async () => {
          await this.ensureChannel(`${sysId}.filesystems`, (0, import_metric_registry.channelName)("filesystems"));
        },
        async (safeId, fsName, fsData) => {
          var _a2, _b, _c, _d;
          await this.ensureChannel(`${sysId}.filesystems.${safeId}`, (0, import_coerce.sanitizeForLog)(fsName));
          const total = (_a2 = fsData.d) != null ? _a2 : null;
          const used = (_b = fsData.du) != null ? _b : null;
          const percent = total !== null && used !== null && total > 0 ? Math.min(100, Math.max(0, Math.round(used / total * 100))) : null;
          await this.createAndSetState(
            `${sysId}.filesystems.${safeId}.disk_percent`,
            (0, import_metric_registry.percentCommon)((0, import_i18n.tName)("diskPercent")),
            percent
          );
          await this.createAndSetState(
            `${sysId}.filesystems.${safeId}.disk_used`,
            (0, import_metric_registry.numCommon)((0, import_i18n.tName)("diskUsed"), "GB"),
            used
          );
          await this.createAndSetState(
            `${sysId}.filesystems.${safeId}.disk_total`,
            (0, import_metric_registry.numCommon)((0, import_i18n.tName)("diskTotal"), "GB"),
            total
          );
          await this.createAndSetState(
            `${sysId}.filesystems.${safeId}.read_speed`,
            (0, import_metric_registry.numCommon)((0, import_i18n.tName)("readSpeed"), "MB/s"),
            (_c = fsData.r) != null ? _c : null
          );
          await this.createAndSetState(
            `${sysId}.filesystems.${safeId}.write_speed`,
            (0, import_metric_registry.numCommon)((0, import_i18n.tName)("writeSpeed"), "MB/s"),
            (_d = fsData.w) != null ? _d : null
          );
        }
      );
    }
  }
  async updateContainers(sysId, systemId, allContainers) {
    var _a, _b;
    const sysContainers = allContainers.filter((c) => c.system === systemId);
    const seenContainers = /* @__PURE__ */ new Set();
    const resolvedIds = /* @__PURE__ */ new Map();
    for (const container of sysContainers) {
      resolvedIds.set(container.id, this.resolveChildId(container.name, container.id, seenContainers));
    }
    const activeIds = /* @__PURE__ */ new Set();
    for (const cId of resolvedIds.values()) {
      if (cId) {
        activeIds.add(cId);
      }
    }
    await this.pruneGroup(`${sysId}.containers`, activeIds, "channel", sysContainers.length === 0);
    if (sysContainers.length === 0) {
      return;
    }
    await this.ensureChannel(`${sysId}.containers`, (0, import_metric_registry.channelName)("containers"));
    const healthLabels = ["none", "starting", "healthy", "unhealthy"];
    for (const container of sysContainers) {
      const cId = (_a = resolvedIds.get(container.id)) != null ? _a : "";
      if (cId.length === 0) {
        continue;
      }
      await this.ensureChannel(`${sysId}.containers.${cId}`, (0, import_coerce.sanitizeForLog)(container.name));
      await this.createAndSetState(`${sysId}.containers.${cId}.status`, (0, import_metric_registry.textCommon)((0, import_i18n.tName)("status")), container.status);
      const healthIdx = Math.floor(container.health);
      await this.createAndSetState(
        `${sysId}.containers.${cId}.health`,
        (0, import_metric_registry.textCommon)((0, import_i18n.tName)("containerHealth")),
        (_b = healthLabels[healthIdx]) != null ? _b : "unknown"
      );
      await this.createAndSetState(`${sysId}.containers.${cId}.cpu`, (0, import_metric_registry.percentCommon)((0, import_i18n.tName)("cpuUsage")), container.cpu);
      await this.createAndSetState(
        `${sysId}.containers.${cId}.memory`,
        (0, import_metric_registry.numCommon)((0, import_i18n.tName)("containerMemory"), "MB"),
        container.memory
      );
      await this.createAndSetState(
        `${sysId}.containers.${cId}.image`,
        (0, import_metric_registry.textCommon)((0, import_i18n.tName)("containerImage")),
        container.image
      );
      if (container.net != null) {
        await this.createAndSetState(
          `${sysId}.containers.${cId}.network`,
          (0, import_metric_registry.numCommon)((0, import_i18n.tName)("containerNetwork"), "B/s"),
          container.net
        );
      }
    }
  }
  /**
   * D3: run one dynamic group's lifecycle — the scaffold shared by the sensor /
   * interface / GPU / filesystem / engine groups. Ensures the parent channel(s),
   * iterates the entries with SEC-6 collision-safe child-id resolution, tracks
   * the active ids, and prunes disappeared members (drop-to-zero debounced).
   * Only the parent-ensure and per-item work vary, so they are callbacks. The
   * per-core group stays hand-written: its children are positional (`core0`..),
   * not an `Object.entries` map, so it does not fit this shape.
   *
   * @param base Group prefix (e.g. `systems.<safeName>.gpu`).
   * @param entries The group's `[rawId, data]` pairs (empty array when absent).
   * @param childType Object type of the direct children (`channel` or `state`).
   * @param ensureParents Creates the parent channel(s); run once before the loop.
   * @param perItem Creates the child channel/states for one collision-safe id.
   */
  async syncDynamicGroup(base, entries, childType, ensureParents, perItem) {
    const active = /* @__PURE__ */ new Set();
    if (entries.length > 0) {
      await ensureParents();
      const seen = /* @__PURE__ */ new Set();
      for (const [rawId, data] of entries) {
        const safeId = this.resolveChildId(rawId, rawId, seen);
        if (!safeId) {
          continue;
        }
        active.add(safeId);
        await perItem(safeId, rawId, data);
      }
    }
    await this.pruneGroup(base, active, childType, entries.length === 0);
  }
  /**
   * H2: prune a dynamic group's disappeared children, with a drop-to-zero
   * debounce. A NON-empty group prunes immediately (drops members that vanished
   * among the ones still present). An EMPTY group (all members gone) prunes only
   * on the SECOND consecutive empty poll — a single transient empty response
   * must not wipe every state. Used by every dynamic group incl. containers.
   *
   * @param base Group prefix (e.g. `systems.<safeName>.gpu`).
   * @param activeIds Sanitized direct-child segments currently present.
   * @param childType Object type of the direct children (`channel` or `state`).
   * @param isEmpty Whether the group has zero members this poll.
   */
  async pruneGroup(base, activeIds, childType, isEmpty) {
    var _a;
    const wasEmpty = (_a = this.lastGroupEmpty.get(base)) != null ? _a : false;
    this.lastGroupEmpty.set(base, isEmpty);
    if (!isEmpty || wasEmpty) {
      await this.pruneDynamicChildren(base, activeIds, childType);
    }
  }
  /**
   * v0.7.2 (generalised F1): remove children of a dynamic group that are no
   * longer reported by Beszel — stopped container, removed GPU, renamed
   * network interface or sensor, unmounted filesystem, shrunk core count.
   * Before this only containers were pruned; every other dynamic group left
   * zombie states with frozen values behind forever.
   *
   * Cost model: the object view is queried only on the FIRST call per group
   * after adapter start (reconciles leftovers from previous runs). After
   * that the in-memory set diff detects disappearances with zero DB reads.
   *
   * @param base Group prefix (e.g. `systems.<safeName>.containers`)
   * @param activeIds Sanitized direct-child segments currently present
   * @param childType Object type of the direct children (`channel` or `state`)
   */
  async pruneDynamicChildren(base, activeIds, childType) {
    var _a;
    let known = this.dynamicChildren.get(base);
    if (!known) {
      known = /* @__PURE__ */ new Set();
      const view = await this.adapter.getObjectViewAsync("system", childType, {
        startkey: `${this.adapter.namespace}.${base}.`,
        endkey: `${this.adapter.namespace}.${base}.\uFFFF`
      });
      for (const row of (_a = view == null ? void 0 : view.rows) != null ? _a : []) {
        const id = row.id.startsWith(`${this.adapter.namespace}.`) ? this.stripNamespace(row.id) : row.id;
        if (!id.startsWith(`${base}.`)) {
          continue;
        }
        const cId = id.slice(base.length + 1).split(".")[0];
        if (cId) {
          known.add(cId);
        }
      }
    }
    const stale = [...known].filter((cId) => !activeIds.has(cId));
    await Promise.all(
      stale.map(async (cId) => {
        this.adapter.log.debug(`Removing stale ${childType} ${base}.${cId} (no longer reported)`);
        await this.adapter.delObjectAsync(`${base}.${cId}`, { recursive: true });
        this.dropCacheUnder(`${base}.${cId}`);
      })
    );
    if (stale.length > 0 && activeIds.size === 0) {
      const parent = await this.adapter.getObjectAsync(base);
      if (parent) {
        await this.adapter.delObjectAsync(base);
        this.createdIds.delete(base);
      }
    }
    this.dynamicChildren.set(base, new Set(activeIds));
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
  async createAndSetState(id, common, value) {
    if (!this.createdIds.has(id)) {
      await this.adapter.extendObject(id, { type: "state", common, native: {} }, { preserve: { common: ["name"] } });
      this.createdIds.add(id);
    }
    await this.adapter.setStateChangedAsync(id, { val: value, ack: true });
  }
  // -------------------------------------------------------------------------
  // State common factories
  // -------------------------------------------------------------------------
  /**
   * N1: strip the adapter namespace prefix (`beszel.0.`) from a full object id.
   *
   * @param id Full object id.
   */
  stripNamespace(id) {
    return id.slice(this.adapter.namespace.length + 1);
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  StateManager
});
//# sourceMappingURL=state-manager.js.map
