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
const LEGACY_FLAT_STATE_IDS = [
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
class StateManager {
  adapter;
  /**
   * Tracks IDs whose object we already wrote this run. Skipping the write on
   * subsequent polls avoids a redundant js-controller round-trip per state per
   * system per minute — the object write happens once per id per restart.
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
   * of disappeared members (renamed interface, removed GPU/sensor/fan/battery/
   * filesystem, stopped container) without a DB round-trip per poll — the object view is
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
   * v0.11.0: datapoint-change bookkeeping behind the user-facing "created /
   * removed N datapoint(s)" log line. `knownStateIds` starts as a snapshot of
   * every state that already existed at adapter start and is kept in sync from
   * then on, so the every-restart `extendObject` retrofit in `createAndSetState`
   * is NOT miscounted as a creation — only a state that did not exist before
   * counts. Removed ids leave the set again, so a later re-appearance counts as
   * a genuine new creation.
   */
  knownStateIds = /* @__PURE__ */ new Set();
  /**
   * v0.14.0: the channels the startup snapshot found. Only the legacy sweep reads
   * them — it lets the one pre-0.3.0 channel be recognised without an object read.
   */
  knownChannelIds = /* @__PURE__ */ new Set();
  /** Whether {@link snapshotExistingStates} has run — the legacy sweep depends on it. */
  snapshotTaken = false;
  createdStatesCount = 0;
  removedStatesCount = 0;
  /**
   * @param adapter The ioBroker adapter instance
   */
  constructor(adapter) {
    this.adapter = adapter;
  }
  /**
   * v0.11.0: snapshot every existing state id of this instance once at startup
   * (one object view). Must run before the first cleanup/poll — anything created
   * or deleted before it would be miscounted.
   */
  async snapshotExistingStates() {
    var _a, _b, _c;
    const list = await this.adapter.getObjectListAsync({
      startkey: `${this.adapter.namespace}.`,
      endkey: `${this.adapter.namespace}.\uFFFF`
    });
    for (const row of (_a = list == null ? void 0 : list.rows) != null ? _a : []) {
      const id = this.stripNamespace(row.id);
      if (((_b = row.value) == null ? void 0 : _b.type) === "state") {
        this.knownStateIds.add(id);
      } else if (((_c = row.value) == null ? void 0 : _c.type) === "channel") {
        this.knownChannelIds.add(id);
      }
    }
    this.snapshotTaken = true;
  }
  /**
   * v0.11.0: return and reset the created/removed datapoint counters, so each
   * log line reports exactly one batch of changes.
   */
  takeChangeCounts() {
    const counts = { created: this.createdStatesCount, removed: this.removedStatesCount };
    this.createdStatesCount = 0;
    this.removedStatesCount = 0;
    return counts;
  }
  /**
   * v0.11.0: record that a state object was just created. A state that was
   * already there (restart retrofit) does not count.
   *
   * @param id State id, namespace-relative.
   */
  noteStateCreated(id) {
    if (!this.knownStateIds.has(id)) {
      this.knownStateIds.add(id);
      this.createdStatesCount++;
    }
  }
  /**
   * v0.11.0: record that a single state object was just deleted.
   *
   * @param id State id, namespace-relative.
   */
  noteStateRemoved(id) {
    this.knownStateIds.delete(id);
    this.removedStatesCount++;
  }
  /**
   * v0.11.0: record the states removed by a RECURSIVE delete (channel, device,
   * dynamic-group child). Counts from the object view — the honest number of
   * datapoints the user loses — and drops them from `knownStateIds` so a later
   * re-appearance counts as a creation. Must be called BEFORE the delete.
   *
   * @param id Object id whose subtree is about to be removed.
   */
  async noteStatesRemovedUnder(id) {
    var _a;
    const view = await this.adapter.getObjectViewAsync("system", "state", {
      startkey: `${this.adapter.namespace}.${id}`,
      endkey: `${this.adapter.namespace}.${id}.\uFFFF`
    });
    for (const row of (_a = view == null ? void 0 : view.rows) != null ? _a : []) {
      const local = this.stripNamespace(row.id);
      if (local === id || local.startsWith(`${id}.`)) {
        this.noteStateRemoved(local);
      }
    }
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
   * State prefixes (`systems.<safeName>`) of the systems resolved for the current poll.
   * Synchronous and in-memory on purpose: `onUnload` must not await an object view.
   * Empty until the first poll got far enough to call {@link prepareForPoll}.
   */
  knownSystemIds() {
    const out = [];
    for (const safe of this.resolvedSafeNames.values()) {
      if (safe) {
        out.push(`systems.${safe}`);
      }
    }
    return out;
  }
  /**
   * Reset every system's `info.online` (and the fleet rollup) to "not online".
   *
   * The device object points its `statusStates.onlineId` at `info.online`, and ioBroker
   * keeps a state's last value forever — so a system stays green in the object tree
   * whenever nothing overwrites it. That happens at startup (the previous run's value
   * survives, and a Hub that is unreachable means no poll ever writes one) as well as
   * after an adapter stop. Called at startup and on shutdown; the poll's failure path
   * uses {@link knownSystemIds} instead, which needs no object view.
   *
   * Only states that actually exist are written — `knownStateIds` is the startup
   * snapshot of the object tree, so an id in it always has an object behind it.
   * `info.status` goes to {@link SYSTEM_STATUS_UNKNOWN} alongside: the Hub's own
   * up/down/paused/pending has no member for "nobody is reading right now", so the
   * datapoint carries a fifth value of its own rather than claiming one of the four.
   * The enum is re-written with the value because an install upgrading from an
   * earlier version still has the four-value list on the object.
   */
  async markAllOffline() {
    for (const id of this.knownStateIds) {
      if (!id.startsWith("systems.")) {
        continue;
      }
      if (id.endsWith(".info.online")) {
        await this.adapter.setStateChangedAsync(id, { val: false, ack: true });
      } else if (id.endsWith(".info.status")) {
        await this.adapter.extendObject(id, {
          type: "state",
          common: { states: import_metric_registry.SYSTEM_STATUS_STATES },
          native: {}
        });
        await this.adapter.setStateChangedAsync(id, { val: import_metric_registry.SYSTEM_STATUS_UNKNOWN, ack: true });
      }
    }
    if (this.knownStateIds.has("info.systemsOnline")) {
      await this.adapter.setStateChangedAsync("info.systemsOnline", { val: 0, ack: true });
    }
    if (this.knownStateIds.has("info.systemsAllUp")) {
      await this.adapter.setStateChangedAsync("info.systemsAllUp", { val: false, ack: true });
    }
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
  // Dynamic groups (per-sensor temperature, per-fan, per-battery, per-GPU,
  // per-filesystem, per-container) are NOT in here — they fan out to N items
  // and stay in their dedicated handlers (`updateDynamicStats`, `updateContainers`).
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
    const touched = [];
    for (const d of this.metricDefs()) {
      if (!config[d.toggle]) {
        continue;
      }
      if (!d.available || d.available(stats, system)) {
        touched.push({ def: d, writeValue: true });
        continue;
      }
      const id = `${sysId}.${d.id}`;
      if (!this.createdIds.has(id) && !this.knownStateIds.has(id)) {
        continue;
      }
      touched.push({ def: d, writeValue: !!stats });
    }
    const channels = new Set(touched.map((t) => t.def.channel));
    for (const ch of channels) {
      await this.ensureChannel(`${sysId}.${ch}`, (0, import_metric_registry.channelName)(ch));
    }
    for (const { def, writeValue } of touched) {
      const id = `${sysId}.${def.id}`;
      if (!writeValue) {
        await this.ensureStateObject(id, (0, import_metric_registry.commonFor)(def));
        continue;
      }
      const raw = def.extract(system, stats);
      const value = def.kind === "percent" && typeof raw === "number" ? (0, import_metric_registry.clampPercent)(raw) : raw;
      await this.createAndSetState(id, (0, import_metric_registry.commonFor)(def), value);
    }
  }
  /**
   * Update all states for a single system.
   *
   * @param system Beszel system record
   * @param stats Latest stats for this system, or undefined if unavailable
   * @param containers Container records belonging to this system (pre-filtered by the poll)
   * @param rawConfig Adapter configuration (detail toggles are gated on their category base via effectiveConfig)
   * @param containersAvailable F1: whether the container fetch succeeded this poll. `false`
   *   (403 / timeout) means "unknown" — the container tree is left untouched (frozen), never
   *   pruned. Defaults to `true` so unit tests exercising other metrics need not pass it.
   */
  async updateSystem(system, stats, containers, rawConfig, containersAvailable = true) {
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
        // The only object that KEEPS `preserve`. Its name is the system name from
        // the Hub, and renaming a system there produces a different sanitized id —
        // i.e. a new device object anyway. So preserving here can only ever protect
        // a rename the user typed in the admin, and never blocks anything the
        // adapter itself ships (unlike the channels/states below, v0.14.0).
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
        ...(0, import_metric_registry.textCommon)((0, import_i18n.tName)("status"), "info.status", (0, import_i18n.tDesc)("descStatus")),
        states: import_metric_registry.SYSTEM_STATUS_STATES
      },
      system.status
    );
    await this.applyMetrics(sysId, system, stats, config);
    if (stats) {
      await this.updateDynamicStats(sysId, stats, config);
    } else {
      await this.refreshDynamicObjects(sysId);
    }
    if (config.metrics_containers && containersAvailable) {
      await this.updateContainers(sysId, containers);
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
        await this.noteStatesRemovedUnder(`systems.${name}`);
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
          this.noteStateRemoved(id);
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
          this.noteStateRemoved(ppId);
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
   *
   * v0.14.0: decided entirely from the startup snapshot — no probing of dozens of
   * legacy ids per system, and therefore no `info.legacyMigrated` marker any more.
   * The marker only ever existed to skip that probing; since v0.11.0 the snapshot
   * reads every existing object once anyway (and runs BEFORE this), so the whole
   * sweep is free and the marker datapoint was pure bookkeeping in the user's tree.
   * An install that still carries it gets it removed here.
   *
   * F3: `existingNames` may be passed in when the caller (onReady) has already
   * enumerated the system devices — then this method reuses that list instead of
   * running the same object view a second time. Omitted (e.g. in unit tests) it
   * enumerates on its own.
   *
   * @param existingNames Pre-enumerated system device names, or undefined to enumerate here.
   */
  async migrateLegacyStates(existingNames) {
    if (!this.snapshotTaken) {
      await this.snapshotExistingStates();
    }
    await this.removeLegacyMigrationMarker();
    const names = existingNames != null ? existingNames : await this.getExistingSystemNames();
    if (names.length === 0) {
      return;
    }
    this.adapter.log.debug(`migrateLegacyStates: scanning ${names.length} existing system(s) for legacy flat states`);
    const counts = await Promise.all(
      names.map(async (name) => {
        const sysId = `systems.${name}`;
        let local = 0;
        for (const stateId of LEGACY_FLAT_STATE_IDS) {
          const fullId = `${sysId}.${stateId}`;
          if (!this.knownStateIds.has(fullId)) {
            continue;
          }
          await this.adapter.delObjectAsync(fullId);
          this.createdIds.delete(fullId);
          this.knownStateIds.delete(fullId);
          local++;
        }
        const legacyChannel = `${sysId}.temperatures`;
        if (this.knownChannelIds.has(legacyChannel)) {
          await this.deleteChannelIfExists(legacyChannel, false);
          this.knownChannelIds.delete(legacyChannel);
        }
        return local;
      })
    );
    const migrated = counts.reduce((a, b) => a + b, 0);
    if (migrated > 0) {
      this.adapter.log.info(`Migration: removed ${migrated} legacy state(s) from flat structure`);
    }
  }
  /**
   * v0.14.0: drop the obsolete `info.legacyMigrated` marker. It guarded a scan that
   * costs nothing any more, and every fresh install created it as well — a technical
   * bookkeeping flag in the user's object tree that says nothing about the system
   * being monitored. Counted like any other removal, so the datapoint line reports it.
   */
  async removeLegacyMigrationMarker() {
    const id = "info.legacyMigrated";
    if (!this.knownStateIds.has(id)) {
      return;
    }
    await this.adapter.delObjectAsync(id);
    this.createdIds.delete(id);
    this.noteStateRemoved(id);
    this.adapter.log.debug(`Removed the obsolete migration marker ${id}`);
  }
  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------
  /**
   * Datapoints inside the dynamic groups whose `common` the ADAPTER owns — name and
   * description come from `admin/i18n`, not from the Hub. Keyed by the id suffix below
   * the system, so {@link refreshDynamicObjects} can rebuild them from the object tree
   * alone, with no live data.
   *
   * Deliberately NOT listed: everything named by the Hub (sensor, fan, battery, GPU,
   * filesystem, interface and container names). Those cannot be rebuilt without the
   * data, and they never change through an adapter update either.
   *
   * A test walks a fully populated system and fails if any adapter-named datapoint is
   * missing here — that is what keeps this table from drifting away from the creation
   * paths below.
   */
  static DYNAMIC_LEAF_COMMONS = [
    {
      match: /^cpu\.cores\.core(\d+)$/,
      common: (m) => (0, import_metric_registry.percentCommon)((0, import_i18n.tName)("cpuCore", Number(m[1])))
    },
    { match: /^network\.interfaces\.[^.]+\.up$/, common: () => (0, import_metric_registry.numCommon)((0, import_i18n.tName)("ifaceUp"), "MB/s") },
    { match: /^network\.interfaces\.[^.]+\.down$/, common: () => (0, import_metric_registry.numCommon)((0, import_i18n.tName)("ifaceDown"), "MB/s") },
    {
      match: /^network\.interfaces\.[^.]+\.total_up$/,
      common: () => (0, import_metric_registry.numCommon)((0, import_i18n.tName)("ifaceTotalUp"), "GB", "value", (0, import_i18n.tDesc)("descIfaceTotal"))
    },
    {
      match: /^network\.interfaces\.[^.]+\.total_down$/,
      common: () => (0, import_metric_registry.numCommon)((0, import_i18n.tName)("ifaceTotalDown"), "GB", "value", (0, import_i18n.tDesc)("descIfaceTotal"))
    },
    { match: /^gpu\.[^.]+\.usage$/, common: () => (0, import_metric_registry.percentCommon)((0, import_i18n.tName)("gpuUsage")) },
    { match: /^gpu\.[^.]+\.memory_used$/, common: () => (0, import_metric_registry.numCommon)((0, import_i18n.tName)("gpuMemoryUsed"), "MB") },
    { match: /^gpu\.[^.]+\.memory_total$/, common: () => (0, import_metric_registry.numCommon)((0, import_i18n.tName)("gpuMemoryTotal"), "MB") },
    { match: /^gpu\.[^.]+\.power$/, common: () => (0, import_metric_registry.numCommon)((0, import_i18n.tName)("gpuPower"), "W", "value.power") },
    {
      match: /^gpu\.[^.]+\.power_package$/,
      common: () => (0, import_metric_registry.numCommon)((0, import_i18n.tName)("gpuPowerPackage"), "W", "value.power", (0, import_i18n.tDesc)("descGpuPowerPackage"))
    },
    { match: /^filesystems\.[^.]+\.disk_percent$/, common: () => (0, import_metric_registry.percentCommon)((0, import_i18n.tName)("diskPercent")) },
    { match: /^filesystems\.[^.]+\.disk_used$/, common: () => (0, import_metric_registry.numCommon)((0, import_i18n.tName)("diskUsed"), "GB") },
    { match: /^filesystems\.[^.]+\.disk_total$/, common: () => (0, import_metric_registry.numCommon)((0, import_i18n.tName)("diskTotal"), "GB") },
    { match: /^filesystems\.[^.]+\.read_speed$/, common: () => (0, import_metric_registry.numCommon)((0, import_i18n.tName)("readSpeed"), "MB/s") },
    { match: /^filesystems\.[^.]+\.write_speed$/, common: () => (0, import_metric_registry.numCommon)((0, import_i18n.tName)("writeSpeed"), "MB/s") },
    { match: /^containers\.[^.]+\.status$/, common: () => (0, import_metric_registry.textCommon)((0, import_i18n.tName)("status")) },
    {
      match: /^containers\.[^.]+\.health$/,
      common: () => (0, import_metric_registry.textCommon)((0, import_i18n.tName)("containerHealth"), "text", (0, import_i18n.tDesc)("descContainerHealth"))
    },
    { match: /^containers\.[^.]+\.cpu$/, common: () => (0, import_metric_registry.percentCommon)((0, import_i18n.tName)("cpuUsage")) },
    { match: /^containers\.[^.]+\.memory$/, common: () => (0, import_metric_registry.numCommon)((0, import_i18n.tName)("containerMemory"), "MB") },
    { match: /^containers\.[^.]+\.image$/, common: () => (0, import_metric_registry.textCommon)((0, import_i18n.tName)("containerImage")) },
    {
      match: /^containers\.[^.]+\.network$/,
      common: () => (0, import_metric_registry.numCommon)((0, import_i18n.tName)("containerNetwork"), "B/s", "value", (0, import_i18n.tDesc)("descContainerNetwork"))
    }
  ];
  /**
   * Bring the dynamic groups' names and descriptions up to date WITHOUT live data.
   *
   * `updateDynamicStats` only runs when the Hub delivered a reading, so a system that is
   * currently down never had its container / GPU / interface / filesystem datapoints
   * refreshed — they kept the wording they were created with, and no gate can see that
   * (found on the live tree, v0.14.1). This walks what the startup snapshot already
   * knows: the group channels the adapter names itself, and the leaves in
   * {@link DYNAMIC_LEAF_COMMONS}. It creates nothing, deletes nothing, writes no value.
   *
   * @param sysId State prefix (`systems.<safeName>`).
   */
  async refreshDynamicObjects(sysId) {
    const prefix = `${sysId}.`;
    for (const id of this.knownChannelIds) {
      if (!id.startsWith(prefix)) {
        continue;
      }
      const last = id.slice(id.lastIndexOf(".") + 1);
      if (import_metric_registry.CHANNEL_NAME_KEY[last]) {
        await this.ensureChannel(id, (0, import_metric_registry.channelName)(last));
      }
    }
    for (const id of this.knownStateIds) {
      if (!id.startsWith(prefix)) {
        continue;
      }
      const rel = id.slice(prefix.length);
      for (const entry of StateManager.DYNAMIC_LEAF_COMMONS) {
        const m = rel.match(entry.match);
        if (m) {
          await this.ensureStateObject(id, entry.common(m));
          break;
        }
      }
    }
  }
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
            (0, import_metric_registry.numCommon)((0, import_coerce.sanitizeDisplayName)(sensor), "\xB0C", "value.temperature"),
            temp
          );
        }
      );
    }
    if (config.metrics_fans) {
      await this.syncDynamicGroup(
        `${sysId}.fans`,
        stats.f ? Object.entries(stats.f) : [],
        "state",
        async () => {
          await this.ensureChannel(`${sysId}.fans`, (0, import_metric_registry.channelName)("fans"));
        },
        async (safeFan, fan, rpm) => {
          await this.createAndSetState(`${sysId}.fans.${safeFan}`, (0, import_metric_registry.numCommon)((0, import_coerce.sanitizeDisplayName)(fan), "rpm"), rpm);
        }
      );
    }
    if (config.metrics_battery) {
      await this.syncDynamicGroup(
        `${sysId}.battery.batteries`,
        stats.bats ? Object.entries(stats.bats) : [],
        "state",
        async () => {
          await this.ensureChannel(`${sysId}.battery`, (0, import_metric_registry.channelName)("battery"));
          await this.ensureChannel(`${sysId}.battery.batteries`, (0, import_metric_registry.channelName)("batteries"));
        },
        async (safeBat, bat, percent) => {
          await this.createAndSetState(
            `${sysId}.battery.batteries.${safeBat}`,
            (0, import_metric_registry.percentCommon)((0, import_coerce.sanitizeDisplayName)(bat), "value.battery"),
            (0, import_metric_registry.clampPercent)(percent)
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
            // Positional label, but still a translation object: the fleet standard
            // wants one for every object, and `%s` carries the index into each language.
            (0, import_metric_registry.percentCommon)((0, import_i18n.tName)("cpuCore", i)),
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
          await this.ensureChannel(`${sysId}.network.interfaces.${safeId}`, (0, import_coerce.sanitizeDisplayName)(iface));
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
            (0, import_metric_registry.numCommon)((0, import_i18n.tName)("ifaceTotalUp"), "GB", "value", (0, import_i18n.tDesc)("descIfaceTotal")),
            (0, import_metric_registry.bytesToGib)(vals[2])
          );
          await this.createAndSetState(
            `${sysId}.network.interfaces.${safeId}.total_down`,
            (0, import_metric_registry.numCommon)((0, import_i18n.tName)("ifaceTotalDown"), "GB", "value", (0, import_i18n.tDesc)("descIfaceTotal")),
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
          await this.ensureChannel(`${sysId}.gpu.${safeId}`, (0, import_coerce.sanitizeDisplayName)((_a2 = gpuData.n) != null ? _a2 : gpuId));
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
              (0, import_metric_registry.numCommon)((0, import_i18n.tName)("gpuPowerPackage"), "W", "value.power", (0, import_i18n.tDesc)("descGpuPowerPackage")),
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
                  (0, import_metric_registry.percentCommon)((0, import_coerce.sanitizeDisplayName)(engine)),
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
          await this.ensureChannel(`${sysId}.filesystems.${safeId}`, (0, import_coerce.sanitizeDisplayName)(fsName));
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
  /**
   * F5: `sysContainers` is already the list belonging to THIS system — the poll
   * groups the global container list by `system` once (O(containers)) instead of
   * each system re-filtering the whole list (O(systems × containers)).
   *
   * @param sysId State prefix (`systems.<safeName>`).
   * @param sysContainers Container records for this system (already filtered).
   */
  async updateContainers(sysId, sysContainers) {
    var _a, _b;
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
      await this.ensureChannel(`${sysId}.containers.${cId}`, (0, import_coerce.sanitizeDisplayName)(container.name));
      await this.createAndSetState(`${sysId}.containers.${cId}.status`, (0, import_metric_registry.textCommon)((0, import_i18n.tName)("status")), container.status);
      const healthIdx = Math.floor(container.health);
      await this.createAndSetState(
        `${sysId}.containers.${cId}.health`,
        (0, import_metric_registry.textCommon)((0, import_i18n.tName)("containerHealth"), "text", (0, import_i18n.tDesc)("descContainerHealth")),
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
          (0, import_metric_registry.numCommon)((0, import_i18n.tName)("containerNetwork"), "B/s", "value", (0, import_i18n.tDesc)("descContainerNetwork")),
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
   * network interface or sensor, vanished fan or battery, unmounted filesystem,
   * shrunk core count.
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
        await this.noteStatesRemovedUnder(`${base}.${cId}`);
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
  /**
   * Ensure a channel exists AND carries the current name. `extendObject`, not
   * `setObjectNotExists`: the names are the adapter's own (translated via
   * `admin/i18n`), so a corrected translation has to reach an installation that
   * already has the channel — otherwise it only ever lands on fresh installs
   * while every gate looks green. Runs once per channel per restart
   * (`createdIds`-gated), so it is a startup cost, not a per-poll write.
   *
   * @param id Channel id, namespace-relative.
   * @param name Current display name (translation object).
   */
  async ensureChannel(id, name) {
    if (this.createdIds.has(id)) {
      return;
    }
    await this.adapter.extendObject(id, {
      type: "channel",
      common: { name },
      native: {}
    });
    this.createdIds.add(id);
  }
  /**
   * @param id Channel id to delete (recursively) if it exists.
   * @param countRemoval Whether the removed states feed the datapoint counter.
   *   `false` only for the legacy migration, which reports its own total.
   */
  async deleteChannelIfExists(id, countRemoval = true) {
    try {
      const obj = await this.adapter.getObjectAsync(id);
      if (obj) {
        if (countRemoval) {
          await this.noteStatesRemovedUnder(id);
        }
        await this.adapter.delObjectAsync(id, { recursive: true });
        this.dropCacheUnder(id);
      }
    } catch (err) {
      this.adapter.log.debug(`deleteChannelIfExists(${id}) ignored: ${(0, import_coerce.errText)(err)}`);
    }
  }
  /**
   * Make sure the state object exists and carries the CURRENT common (name,
   * description, role, unit) — without touching its value.
   *
   * Split out of {@link createAndSetState} because a datapoint of a system the Hub has
   * no reading for still has to receive corrected names and descriptions. Tying the
   * object refresh to "there is a value to write" left every currently-down system on
   * the old wording, which no gate can see — only the live tree (v0.14.1).
   *
   * @param id State id, namespace-relative.
   * @param common The state's current common definition.
   */
  async ensureStateObject(id, common) {
    if (this.createdIds.has(id)) {
      return;
    }
    await this.adapter.extendObject(id, { type: "state", common, native: {} });
    this.createdIds.add(id);
    this.noteStateCreated(id);
  }
  async createAndSetState(id, common, value) {
    await this.ensureStateObject(id, common);
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
