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
   * v0.7.2: per dynamic group (`<sysId>.<group>` → set of child segments seen
   * in the last poll). Used by {@link pruneDynamicChildren} to delete states
   * of disappeared members (renamed interface, removed GPU/sensor/filesystem,
   * stopped container) without a DB round-trip per poll — the object view is
   * queried only once per group after adapter start (reconciles zombies from
   * previous runs), afterwards the in-memory diff does the work.
   */
  dynamicChildren = /* @__PURE__ */ new Map();
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
   * Beszel battery charge-state value that means "actively charging"
   * (agent/battery/battery.go enum: 0=unknown 1=empty 2=full 3=charging
   * 4=discharging 5=idle). Used to map `bat[1]` to the `charging` boolean.
   */
  static BATTERY_STATE_CHARGING = 3;
  /** i18n key for each metric channel. */
  static CHANNEL_NAME_KEY = {
    info: "channelInfo",
    cpu: "channelCpu",
    memory: "channelMemory",
    disk: "channelDisk",
    network: "channelNetwork",
    temperature: "channelTemperature",
    battery: "channelBattery"
  };
  /**
   * v0.6.0: each detail/peak toggle depends on its category's base toggle —
   * when the category is off, the detail is off too. This mirrors the admin
   * grey-out (`disabled` in jsonConfig) in the DATA logic, so a sub-metric
   * never creates states while its category is disabled (krobi: "Kategorie aus
   * → Unterkategorie automatisch mit aus"). Must stay in sync with the
   * `disabled` conditions in admin/jsonConfig.json. Every non-base metric in a
   * category gates on the category's base/usage metric — including the
   * default-on co-metrics `loadAvg` (→ CPU) and `diskSpeed` (→ Disk): krobi
   * wants a category to switch off completely, no "logischer Ausreißer". Only
   * the System category (uptime / system-info / services) has no single base,
   * so its three independent metrics are not gated.
   */
  /**
   * v0.7.2: dynamic-group toggles that write into a scalar channel without
   * appearing in `metricDefs` (their states fan out per item in
   * `updateDynamicStats`). Merged into the derived per-channel toggle sets
   * when `cleanupMetrics` decides whether a channel is completely empty.
   * Exported for unit-tests via the class (invariant lock against jsonConfig).
   */
  static DYNAMIC_CHANNEL_TOGGLES = {
    cpu: ["metrics_cpuCores"],
    network: ["metrics_networkInterfaces"],
    temperature: ["metrics_temperatureDetails"]
  };
  static METRIC_DEPENDENCIES = {
    metrics_loadAvg: "metrics_cpu",
    metrics_cpuBreakdown: "metrics_cpu",
    metrics_cpuCores: "metrics_cpu",
    metrics_cpuPeak: "metrics_cpu",
    metrics_memoryDetails: "metrics_memory",
    metrics_swap: "metrics_memory",
    metrics_memoryPeak: "metrics_memory",
    metrics_diskSpeed: "metrics_disk",
    metrics_extraFs: "metrics_disk",
    metrics_diskIo: "metrics_disk",
    metrics_diskPeak: "metrics_disk",
    metrics_networkInterfaces: "metrics_network",
    metrics_networkPeak: "metrics_network",
    metrics_temperatureDetails: "metrics_temperature",
    metrics_gpuDetails: "metrics_gpu"
  };
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
    for (const detail of Object.keys(
      StateManager.METRIC_DEPENDENCIES
    )) {
      const base = StateManager.METRIC_DEPENDENCIES[detail];
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
  metricDefs() {
    const hasStats = (s) => !!s;
    const la = (system, stats) => {
      var _a;
      return (_a = stats == null ? void 0 : stats.la) != null ? _a : system.info.la;
    };
    return [
      // info (no stats required)
      {
        toggle: "metrics_uptime",
        channel: "info",
        id: "info.uptime",
        nameKey: "uptime",
        kind: "num",
        unit: "s",
        extract: (s) => {
          var _a;
          return (_a = s.info.u) != null ? _a : null;
        }
      },
      {
        toggle: "metrics_uptime",
        channel: "info",
        id: "info.uptime_text",
        nameKey: "uptimeFormatted",
        kind: "text",
        extract: (s) => s.info.u != null ? this.formatUptime(s.info.u) : null
      },
      {
        toggle: "metrics_agentVersion",
        channel: "info",
        id: "info.agent_version",
        nameKey: "agentVersion",
        kind: "text",
        extract: (s) => {
          var _a;
          return (_a = s.info.v) != null ? _a : null;
        }
      },
      // F2: static hardware/OS info from the system_details collection (attached
      // to system.details by the poll loop). Each field gated on its own presence
      // so a partially-populated agent yields no empty states; all share the
      // "System info" toggle (metrics_agentVersion) and the existing info channel.
      {
        toggle: "metrics_agentVersion",
        channel: "info",
        id: "info.hostname",
        nameKey: "hostname",
        kind: "text",
        available: (_st, s) => {
          var _a;
          return ((_a = s.details) == null ? void 0 : _a.hostname) != null;
        },
        extract: (s) => {
          var _a, _b;
          return (_b = (_a = s.details) == null ? void 0 : _a.hostname) != null ? _b : null;
        }
      },
      {
        toggle: "metrics_agentVersion",
        channel: "info",
        id: "info.os",
        nameKey: "os",
        kind: "text",
        available: (_st, s) => {
          var _a;
          return ((_a = s.details) == null ? void 0 : _a.os) != null;
        },
        extract: (s) => {
          var _a;
          return this.osLabel((_a = s.details) == null ? void 0 : _a.os);
        }
      },
      {
        toggle: "metrics_agentVersion",
        channel: "info",
        id: "info.os_name",
        nameKey: "osName",
        kind: "text",
        available: (_st, s) => {
          var _a;
          return ((_a = s.details) == null ? void 0 : _a.os_name) != null;
        },
        extract: (s) => {
          var _a, _b;
          return (_b = (_a = s.details) == null ? void 0 : _a.os_name) != null ? _b : null;
        }
      },
      {
        toggle: "metrics_agentVersion",
        channel: "info",
        id: "info.kernel",
        nameKey: "kernel",
        kind: "text",
        available: (_st, s) => {
          var _a;
          return ((_a = s.details) == null ? void 0 : _a.kernel) != null;
        },
        extract: (s) => {
          var _a, _b;
          return (_b = (_a = s.details) == null ? void 0 : _a.kernel) != null ? _b : null;
        }
      },
      {
        toggle: "metrics_agentVersion",
        channel: "info",
        id: "info.cpu_model",
        nameKey: "cpuModel",
        kind: "text",
        available: (_st, s) => {
          var _a;
          return ((_a = s.details) == null ? void 0 : _a.cpu) != null;
        },
        extract: (s) => {
          var _a, _b;
          return (_b = (_a = s.details) == null ? void 0 : _a.cpu) != null ? _b : null;
        }
      },
      {
        toggle: "metrics_agentVersion",
        channel: "info",
        id: "info.arch",
        nameKey: "arch",
        kind: "text",
        available: (_st, s) => {
          var _a;
          return ((_a = s.details) == null ? void 0 : _a.arch) != null;
        },
        extract: (s) => {
          var _a, _b;
          return (_b = (_a = s.details) == null ? void 0 : _a.arch) != null ? _b : null;
        }
      },
      {
        toggle: "metrics_agentVersion",
        channel: "info",
        id: "info.cores",
        nameKey: "cores",
        kind: "num",
        available: (_st, s) => {
          var _a;
          return ((_a = s.details) == null ? void 0 : _a.cores) != null;
        },
        extract: (s) => {
          var _a, _b;
          return (_b = (_a = s.details) == null ? void 0 : _a.cores) != null ? _b : null;
        }
      },
      {
        toggle: "metrics_agentVersion",
        channel: "info",
        id: "info.threads",
        nameKey: "threads",
        kind: "num",
        available: (_st, s) => {
          var _a;
          return ((_a = s.details) == null ? void 0 : _a.threads) != null;
        },
        extract: (s) => {
          var _a, _b;
          return (_b = (_a = s.details) == null ? void 0 : _a.threads) != null ? _b : null;
        }
      },
      {
        toggle: "metrics_agentVersion",
        channel: "info",
        id: "info.podman",
        nameKey: "podman",
        kind: "bool",
        available: (_st, s) => {
          var _a;
          return ((_a = s.details) == null ? void 0 : _a.podman) != null;
        },
        extract: (s) => {
          var _a, _b;
          return (_b = (_a = s.details) == null ? void 0 : _a.podman) != null ? _b : null;
        }
      },
      {
        toggle: "metrics_services",
        channel: "info",
        id: "info.services_total",
        nameKey: "servicesTotal",
        kind: "num",
        extract: (s) => {
          var _a, _b;
          return (_b = (_a = s.info.sv) == null ? void 0 : _a[0]) != null ? _b : null;
        }
      },
      {
        toggle: "metrics_services",
        channel: "info",
        id: "info.services_failed",
        nameKey: "servicesFailed",
        kind: "num",
        extract: (s) => {
          var _a, _b;
          return (_b = (_a = s.info.sv) == null ? void 0 : _a[1]) != null ? _b : null;
        }
      },
      // load average — always created if toggled (stats.la or info.la fallback)
      {
        toggle: "metrics_loadAvg",
        channel: "cpu",
        id: "cpu.load_1m",
        nameKey: "load1m",
        kind: "num",
        extract: (s, st) => {
          var _a, _b;
          return (_b = (_a = la(s, st)) == null ? void 0 : _a[0]) != null ? _b : null;
        }
      },
      {
        toggle: "metrics_loadAvg",
        channel: "cpu",
        id: "cpu.load_5m",
        nameKey: "load5m",
        kind: "num",
        extract: (s, st) => {
          var _a, _b;
          return (_b = (_a = la(s, st)) == null ? void 0 : _a[1]) != null ? _b : null;
        }
      },
      {
        toggle: "metrics_loadAvg",
        channel: "cpu",
        id: "cpu.load_15m",
        nameKey: "load15m",
        kind: "num",
        extract: (s, st) => {
          var _a, _b;
          return (_b = (_a = la(s, st)) == null ? void 0 : _a[2]) != null ? _b : null;
        }
      },
      // stats-gated scalar metrics
      {
        toggle: "metrics_cpu",
        channel: "cpu",
        id: "cpu.usage",
        nameKey: "cpuUsage",
        kind: "percent",
        available: hasStats,
        extract: (_s, st) => {
          var _a;
          return (_a = st == null ? void 0 : st.cpu) != null ? _a : null;
        }
      },
      {
        toggle: "metrics_cpuBreakdown",
        channel: "cpu",
        id: "cpu.user",
        nameKey: "cpuUser",
        kind: "percent",
        available: (st) => !!(st == null ? void 0 : st.cpub) && st.cpub.length >= 5,
        extract: (_s, st) => st.cpub[0]
      },
      {
        toggle: "metrics_cpuBreakdown",
        channel: "cpu",
        id: "cpu.system",
        nameKey: "cpuSystem",
        kind: "percent",
        available: (st) => !!(st == null ? void 0 : st.cpub) && st.cpub.length >= 5,
        extract: (_s, st) => st.cpub[1]
      },
      {
        toggle: "metrics_cpuBreakdown",
        channel: "cpu",
        id: "cpu.iowait",
        nameKey: "cpuIowait",
        kind: "percent",
        available: (st) => !!(st == null ? void 0 : st.cpub) && st.cpub.length >= 5,
        extract: (_s, st) => st.cpub[2]
      },
      {
        toggle: "metrics_cpuBreakdown",
        channel: "cpu",
        id: "cpu.steal",
        nameKey: "cpuSteal",
        kind: "percent",
        available: (st) => !!(st == null ? void 0 : st.cpub) && st.cpub.length >= 5,
        extract: (_s, st) => st.cpub[3]
      },
      {
        toggle: "metrics_cpuBreakdown",
        channel: "cpu",
        id: "cpu.idle",
        nameKey: "cpuIdle",
        kind: "percent",
        available: (st) => !!(st == null ? void 0 : st.cpub) && st.cpub.length >= 5,
        extract: (_s, st) => st.cpub[4]
      },
      {
        toggle: "metrics_memory",
        channel: "memory",
        id: "memory.percent",
        nameKey: "memoryPercent",
        kind: "percent",
        available: hasStats,
        extract: (_s, st) => {
          var _a;
          return (_a = st == null ? void 0 : st.mp) != null ? _a : null;
        }
      },
      {
        toggle: "metrics_memory",
        channel: "memory",
        id: "memory.used",
        nameKey: "memoryUsed",
        kind: "num",
        unit: "GB",
        available: hasStats,
        extract: (_s, st) => {
          var _a;
          return (_a = st == null ? void 0 : st.mu) != null ? _a : null;
        }
      },
      {
        toggle: "metrics_memory",
        channel: "memory",
        id: "memory.total",
        nameKey: "memoryTotal",
        kind: "num",
        unit: "GB",
        available: hasStats,
        extract: (_s, st) => {
          var _a;
          return (_a = st == null ? void 0 : st.m) != null ? _a : null;
        }
      },
      {
        toggle: "metrics_memoryDetails",
        channel: "memory",
        id: "memory.buffers",
        nameKey: "memoryBuffers",
        kind: "num",
        unit: "GB",
        available: hasStats,
        extract: (_s, st) => {
          var _a;
          return (_a = st == null ? void 0 : st.mb) != null ? _a : null;
        }
      },
      {
        toggle: "metrics_memoryDetails",
        channel: "memory",
        id: "memory.zfs_arc",
        nameKey: "memoryZfsArc",
        kind: "num",
        unit: "GB",
        available: hasStats,
        extract: (_s, st) => {
          var _a;
          return (_a = st == null ? void 0 : st.mz) != null ? _a : null;
        }
      },
      {
        toggle: "metrics_swap",
        channel: "memory",
        id: "memory.swap_used",
        nameKey: "swapUsed",
        kind: "num",
        unit: "GB",
        available: hasStats,
        extract: (_s, st) => {
          var _a;
          return (_a = st == null ? void 0 : st.su) != null ? _a : null;
        }
      },
      {
        toggle: "metrics_swap",
        channel: "memory",
        id: "memory.swap_total",
        nameKey: "swapTotal",
        kind: "num",
        unit: "GB",
        available: hasStats,
        extract: (_s, st) => {
          var _a;
          return (_a = st == null ? void 0 : st.s) != null ? _a : null;
        }
      },
      {
        toggle: "metrics_disk",
        channel: "disk",
        id: "disk.percent",
        nameKey: "diskPercent",
        kind: "percent",
        available: hasStats,
        extract: (_s, st) => {
          var _a;
          return (_a = st == null ? void 0 : st.dp) != null ? _a : null;
        }
      },
      {
        toggle: "metrics_disk",
        channel: "disk",
        id: "disk.used",
        nameKey: "diskUsed",
        kind: "num",
        unit: "GB",
        available: hasStats,
        extract: (_s, st) => {
          var _a;
          return (_a = st == null ? void 0 : st.du) != null ? _a : null;
        }
      },
      {
        toggle: "metrics_disk",
        channel: "disk",
        id: "disk.total",
        nameKey: "diskTotal",
        kind: "num",
        unit: "GB",
        available: hasStats,
        extract: (_s, st) => {
          var _a;
          return (_a = st == null ? void 0 : st.d) != null ? _a : null;
        }
      },
      {
        toggle: "metrics_diskSpeed",
        channel: "disk",
        id: "disk.read",
        nameKey: "diskRead",
        kind: "num",
        unit: "MB/s",
        available: hasStats,
        extract: (_s, st) => {
          var _a;
          return (_a = st == null ? void 0 : st.dr) != null ? _a : null;
        }
      },
      {
        toggle: "metrics_diskSpeed",
        channel: "disk",
        id: "disk.write",
        nameKey: "diskWrite",
        kind: "num",
        unit: "MB/s",
        available: hasStats,
        extract: (_s, st) => {
          var _a;
          return (_a = st == null ? void 0 : st.dw) != null ? _a : null;
        }
      },
      {
        toggle: "metrics_network",
        channel: "network",
        id: "network.sent",
        nameKey: "networkSent",
        kind: "num",
        unit: "MB/s",
        available: hasStats,
        extract: (_s, st) => {
          var _a;
          return (_a = st == null ? void 0 : st.ns) != null ? _a : null;
        }
      },
      {
        toggle: "metrics_network",
        channel: "network",
        id: "network.recv",
        nameKey: "networkReceived",
        kind: "num",
        unit: "MB/s",
        available: hasStats,
        extract: (_s, st) => {
          var _a;
          return (_a = st == null ? void 0 : st.nr) != null ? _a : null;
        }
      },
      {
        toggle: "metrics_temperature",
        channel: "temperature",
        id: "temperature.average",
        nameKey: "temperatureAvg",
        kind: "num",
        unit: "\xB0C",
        role: "value.temperature",
        available: hasStats,
        extract: (_s, st) => this.computeTopAvgTemp(st == null ? void 0 : st.t)
      },
      {
        toggle: "metrics_temperature",
        channel: "temperature",
        id: "temperature.max",
        nameKey: "temperatureMax",
        kind: "num",
        unit: "\xB0C",
        role: "value.temperature",
        available: hasStats,
        extract: (_s, st) => this.computeMaxTemp(st == null ? void 0 : st.t)
      },
      {
        toggle: "metrics_battery",
        channel: "battery",
        id: "battery.percent",
        nameKey: "batteryPercent",
        kind: "percent",
        available: hasStats,
        extract: (s, st) => {
          var _a, _b, _c;
          return (_c = (_b = (_a = st == null ? void 0 : st.bat) != null ? _a : s.info.bat) == null ? void 0 : _b[0]) != null ? _c : null;
        }
      },
      {
        toggle: "metrics_battery",
        channel: "battery",
        id: "battery.charging",
        nameKey: "batteryCharging",
        kind: "bool",
        available: hasStats,
        extract: (s, st) => {
          var _a;
          const b = (_a = st == null ? void 0 : st.bat) != null ? _a : s.info.bat;
          if (!b) {
            return null;
          }
          return b[1] === StateManager.BATTERY_STATE_CHARGING;
        }
      },
      // --- v0.6.0 peaks + detail (available-gated on the field being present,
      // so an older Beszel that doesn't send it gets no empty state) ---
      {
        toggle: "metrics_cpuPeak",
        channel: "cpu",
        id: "cpu.peak",
        nameKey: "cpuPeak",
        kind: "percent",
        available: (st) => (st == null ? void 0 : st.cpum) != null,
        extract: (_s, st) => {
          var _a;
          return (_a = st == null ? void 0 : st.cpum) != null ? _a : null;
        }
      },
      {
        toggle: "metrics_memoryPeak",
        channel: "memory",
        id: "memory.peak",
        nameKey: "memoryPeak",
        kind: "num",
        unit: "GB",
        available: (st) => (st == null ? void 0 : st.mm) != null,
        extract: (_s, st) => {
          var _a;
          return (_a = st == null ? void 0 : st.mm) != null ? _a : null;
        }
      },
      {
        toggle: "metrics_diskPeak",
        channel: "disk",
        id: "disk.read_peak",
        nameKey: "diskReadPeak",
        kind: "num",
        unit: "MB/s",
        available: (st) => (st == null ? void 0 : st.drm) != null,
        extract: (_s, st) => {
          var _a;
          return (_a = st == null ? void 0 : st.drm) != null ? _a : null;
        }
      },
      {
        toggle: "metrics_diskPeak",
        channel: "disk",
        id: "disk.write_peak",
        nameKey: "diskWritePeak",
        kind: "num",
        unit: "MB/s",
        available: (st) => (st == null ? void 0 : st.dwm) != null,
        extract: (_s, st) => {
          var _a;
          return (_a = st == null ? void 0 : st.dwm) != null ? _a : null;
        }
      },
      {
        toggle: "metrics_networkPeak",
        channel: "network",
        id: "network.sent_peak",
        nameKey: "networkSentPeak",
        kind: "num",
        unit: "MB/s",
        available: (st) => (st == null ? void 0 : st.nsm) != null,
        extract: (_s, st) => {
          var _a;
          return (_a = st == null ? void 0 : st.nsm) != null ? _a : null;
        }
      },
      {
        toggle: "metrics_networkPeak",
        channel: "network",
        id: "network.recv_peak",
        nameKey: "networkRecvPeak",
        kind: "num",
        unit: "MB/s",
        available: (st) => (st == null ? void 0 : st.nrm) != null,
        extract: (_s, st) => {
          var _a;
          return (_a = st == null ? void 0 : st.nrm) != null ? _a : null;
        }
      },
      {
        toggle: "metrics_diskIo",
        channel: "disk",
        id: "disk.io_util",
        nameKey: "diskIoUtil",
        kind: "percent",
        available: (st) => !!(st == null ? void 0 : st.dios) && st.dios.length >= 3,
        extract: (_s, st) => {
          var _a, _b;
          return (_b = (_a = st == null ? void 0 : st.dios) == null ? void 0 : _a[2]) != null ? _b : null;
        }
      },
      {
        toggle: "metrics_diskIo",
        channel: "disk",
        id: "disk.io_await_read",
        nameKey: "diskIoAwaitRead",
        kind: "num",
        unit: "ms",
        available: (st) => !!(st == null ? void 0 : st.dios) && st.dios.length >= 5,
        extract: (_s, st) => {
          var _a, _b;
          return (_b = (_a = st == null ? void 0 : st.dios) == null ? void 0 : _a[3]) != null ? _b : null;
        }
      },
      {
        toggle: "metrics_diskIo",
        channel: "disk",
        id: "disk.io_await_write",
        nameKey: "diskIoAwaitWrite",
        kind: "num",
        unit: "ms",
        available: (st) => !!(st == null ? void 0 : st.dios) && st.dios.length >= 5,
        extract: (_s, st) => {
          var _a, _b;
          return (_b = (_a = st == null ? void 0 : st.dios) == null ? void 0 : _a[4]) != null ? _b : null;
        }
      }
    ];
  }
  /**
   * Build the StateCommon for a metric definition via the existing factories.
   *
   * @param def Metric definition (kind/unit/role/nameKey) to build the common from.
   */
  commonFor(def) {
    var _a;
    const name = (0, import_i18n.tName)(def.nameKey);
    switch (def.kind) {
      case "percent":
        return this.percentCommon(name);
      case "text":
        return this.textCommon(name);
      case "bool":
        return this.boolCommon(name);
      default:
        return this.numCommon(name, def.unit, (_a = def.role) != null ? _a : "value");
    }
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
    const active = this.metricDefs().filter((d) => config[d.toggle] && (d.available ? d.available(stats, system) : true));
    const channels = new Set(active.map((d) => d.channel));
    for (const ch of channels) {
      await this.ensureChannel(
        `${sysId}.${ch}`,
        (0, import_i18n.tName)(StateManager.CHANNEL_NAME_KEY[ch])
      );
    }
    for (const def of active) {
      await this.createAndSetState(`${sysId}.${def.id}`, this.commonFor(def), def.extract(system, stats));
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
        `Skipping system with unusable name: ${typeof system.name === "string" ? system.name : JSON.stringify(system.name)}`
      );
      return;
    }
    const sysId = `systems.${safeName}`;
    this.adapter.log.debug(`updateSystem state-tree: '${system.name}' \u2192 safeName='${safeName}'`);
    const deviceSig = `${system.id}\0${system.host}\0${system.name}`;
    if (this.deviceWritten.get(sysId) !== deviceSig) {
      await this.adapter.extendObjectAsync(
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
    await this.ensureChannel(`${sysId}.info`, (0, import_i18n.tName)("channelInfo"));
    await this.createAndSetState(
      `${sysId}.info.online`,
      this.boolCommon((0, import_i18n.tName)("online"), "indicator.reachable"),
      system.status === "up"
    );
    await this.createAndSetState(`${sysId}.info.status`, this.textCommon((0, import_i18n.tName)("status")), system.status);
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
    for (const [channel, extras] of Object.entries(StateManager.DYNAMIC_CHANNEL_TOGGLES)) {
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
        endkey: `${this.adapter.namespace}.${sysId}.gpu.\u9999`
      });
      for (const row of (_c = view == null ? void 0 : view.rows) != null ? _c : []) {
        const id = row.id.slice(this.adapter.namespace.length + 1);
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
  async updateDynamicStats(sysId, stats, config) {
    var _a, _b, _c, _d, _e, _f, _g, _h, _i, _j, _k, _l, _m, _n;
    if (config.metrics_temperatureDetails && stats.t) {
      await this.ensureChannel(`${sysId}.temperature`, (0, import_i18n.tName)("channelTemperature"));
      await this.ensureChannel(`${sysId}.temperature.sensors`, (0, import_i18n.tName)("channelSensors"));
      const activeSensors = /* @__PURE__ */ new Set();
      for (const [sensor, temp] of Object.entries(stats.t)) {
        const safeSensor = this.sanitize(sensor);
        if (!safeSensor) {
          continue;
        }
        activeSensors.add(safeSensor);
        await this.createAndSetState(
          `${sysId}.temperature.sensors.${safeSensor}`,
          this.numCommon(sensor, "\xB0C", "value.temperature"),
          temp
        );
      }
      await this.pruneDynamicChildren(`${sysId}.temperature.sensors`, activeSensors, "state");
    }
    if (config.metrics_cpuCores && stats.cpus && stats.cpus.length > 0) {
      await this.ensureChannel(`${sysId}.cpu`, (0, import_i18n.tName)("channelCpu"));
      await this.ensureChannel(`${sysId}.cpu.cores`, (0, import_i18n.tName)("channelCores"));
      const activeCores = /* @__PURE__ */ new Set();
      for (let i = 0; i < stats.cpus.length; i++) {
        activeCores.add(`core${i}`);
        await this.createAndSetState(`${sysId}.cpu.cores.core${i}`, this.percentCommon(`Core ${i}`), stats.cpus[i]);
      }
      await this.pruneDynamicChildren(`${sysId}.cpu.cores`, activeCores, "state");
    }
    if (config.metrics_networkInterfaces && stats.ni && Object.keys(stats.ni).length > 0) {
      await this.ensureChannel(`${sysId}.network`, (0, import_i18n.tName)("channelNetwork"));
      await this.ensureChannel(`${sysId}.network.interfaces`, (0, import_i18n.tName)("channelInterfaces"));
      const activeIfaces = /* @__PURE__ */ new Set();
      for (const [iface, vals] of Object.entries(stats.ni)) {
        const safeId = this.sanitize(iface);
        if (!safeId) {
          continue;
        }
        activeIfaces.add(safeId);
        await this.ensureChannel(`${sysId}.network.interfaces.${safeId}`, iface);
        await this.createAndSetState(
          `${sysId}.network.interfaces.${safeId}.up`,
          this.numCommon((0, import_i18n.tName)("ifaceUp"), "B/s"),
          (_a = vals[0]) != null ? _a : null
        );
        await this.createAndSetState(
          `${sysId}.network.interfaces.${safeId}.down`,
          this.numCommon((0, import_i18n.tName)("ifaceDown"), "B/s"),
          (_b = vals[1]) != null ? _b : null
        );
        await this.createAndSetState(
          `${sysId}.network.interfaces.${safeId}.total_up`,
          this.numCommon((0, import_i18n.tName)("ifaceTotalUp"), "B"),
          (_c = vals[2]) != null ? _c : null
        );
        await this.createAndSetState(
          `${sysId}.network.interfaces.${safeId}.total_down`,
          this.numCommon((0, import_i18n.tName)("ifaceTotalDown"), "B"),
          (_d = vals[3]) != null ? _d : null
        );
      }
      await this.pruneDynamicChildren(`${sysId}.network.interfaces`, activeIfaces, "channel");
    }
    if (config.metrics_gpu && stats.g && Object.keys(stats.g).length > 0) {
      await this.ensureChannel(`${sysId}.gpu`, (0, import_i18n.tName)("channelGpu"));
      const activeGpus = /* @__PURE__ */ new Set();
      for (const [gpuId, gpuData] of Object.entries(stats.g)) {
        const safeId = this.sanitize(gpuId);
        if (!safeId) {
          continue;
        }
        activeGpus.add(safeId);
        await this.ensureChannel(`${sysId}.gpu.${safeId}`, (_e = gpuData.n) != null ? _e : gpuId);
        await this.createAndSetState(
          `${sysId}.gpu.${safeId}.usage`,
          this.percentCommon((0, import_i18n.tName)("gpuUsage")),
          (_f = gpuData.u) != null ? _f : null
        );
        await this.createAndSetState(
          `${sysId}.gpu.${safeId}.memory_used`,
          this.numCommon((0, import_i18n.tName)("gpuMemoryUsed"), "MB"),
          (_g = gpuData.mu) != null ? _g : null
        );
        await this.createAndSetState(
          `${sysId}.gpu.${safeId}.memory_total`,
          this.numCommon((0, import_i18n.tName)("gpuMemoryTotal"), "MB"),
          (_h = gpuData.mt) != null ? _h : null
        );
        await this.createAndSetState(
          `${sysId}.gpu.${safeId}.power`,
          this.numCommon((0, import_i18n.tName)("gpuPower"), "W"),
          (_i = gpuData.p) != null ? _i : null
        );
        if (config.metrics_gpuDetails) {
          await this.createAndSetState(
            `${sysId}.gpu.${safeId}.power_package`,
            this.numCommon((0, import_i18n.tName)("gpuPowerPackage"), "W"),
            (_j = gpuData.pp) != null ? _j : null
          );
          const activeEngines = /* @__PURE__ */ new Set();
          if (gpuData.e && Object.keys(gpuData.e).length > 0) {
            await this.ensureChannel(`${sysId}.gpu.${safeId}.engines`, (0, import_i18n.tName)("channelEngines"));
            for (const [engine, value] of Object.entries(gpuData.e)) {
              const safeEngine = this.sanitize(engine);
              if (safeEngine) {
                await this.createAndSetState(
                  `${sysId}.gpu.${safeId}.engines.${safeEngine}`,
                  this.percentCommon(engine),
                  value
                );
                activeEngines.add(safeEngine);
              }
            }
          }
          await this.pruneDynamicChildren(`${sysId}.gpu.${safeId}.engines`, activeEngines, "state");
        }
      }
      await this.pruneDynamicChildren(`${sysId}.gpu`, activeGpus, "channel");
    }
    if (config.metrics_extraFs && stats.efs && Object.keys(stats.efs).length > 0) {
      await this.ensureChannel(`${sysId}.filesystems`, (0, import_i18n.tName)("channelFilesystems"));
      const activeFs = /* @__PURE__ */ new Set();
      for (const [fsName, fsData] of Object.entries(stats.efs)) {
        const safeId = this.sanitize(fsName);
        if (!safeId) {
          continue;
        }
        activeFs.add(safeId);
        await this.ensureChannel(`${sysId}.filesystems.${safeId}`, fsName);
        const total = (_k = fsData.d) != null ? _k : null;
        const used = (_l = fsData.du) != null ? _l : null;
        const percent = total !== null && used !== null && total > 0 ? Math.min(100, Math.max(0, Math.round(used / total * 100))) : null;
        await this.createAndSetState(
          `${sysId}.filesystems.${safeId}.disk_percent`,
          this.percentCommon((0, import_i18n.tName)("diskPercent")),
          percent
        );
        await this.createAndSetState(
          `${sysId}.filesystems.${safeId}.disk_used`,
          this.numCommon((0, import_i18n.tName)("diskUsed"), "GB"),
          used
        );
        await this.createAndSetState(
          `${sysId}.filesystems.${safeId}.disk_total`,
          this.numCommon((0, import_i18n.tName)("diskTotal"), "GB"),
          total
        );
        await this.createAndSetState(
          `${sysId}.filesystems.${safeId}.read_speed`,
          this.numCommon((0, import_i18n.tName)("readSpeed"), "MB/s"),
          (_m = fsData.r) != null ? _m : null
        );
        await this.createAndSetState(
          `${sysId}.filesystems.${safeId}.write_speed`,
          this.numCommon((0, import_i18n.tName)("writeSpeed"), "MB/s"),
          (_n = fsData.w) != null ? _n : null
        );
      }
      await this.pruneDynamicChildren(`${sysId}.filesystems`, activeFs, "channel");
    }
  }
  async updateContainers(sysId, systemId, allContainers) {
    var _a;
    const sysContainers = allContainers.filter((c) => c.system === systemId);
    const activeIds = /* @__PURE__ */ new Set();
    for (const container of sysContainers) {
      const cId = this.sanitize(container.name);
      if (cId) {
        activeIds.add(cId);
      }
    }
    await this.pruneDynamicChildren(`${sysId}.containers`, activeIds, "channel");
    if (sysContainers.length === 0) {
      return;
    }
    await this.ensureChannel(`${sysId}.containers`, (0, import_i18n.tName)("channelContainers"));
    const healthLabels = ["none", "starting", "healthy", "unhealthy"];
    for (const container of sysContainers) {
      const cId = this.sanitize(container.name);
      if (cId.length === 0) {
        continue;
      }
      await this.ensureChannel(`${sysId}.containers.${cId}`, container.name);
      await this.createAndSetState(
        `${sysId}.containers.${cId}.status`,
        this.textCommon((0, import_i18n.tName)("status")),
        container.status
      );
      const healthIdx = Math.floor(container.health);
      await this.createAndSetState(
        `${sysId}.containers.${cId}.health`,
        this.textCommon((0, import_i18n.tName)("containerHealth")),
        (_a = healthLabels[healthIdx]) != null ? _a : "unknown"
      );
      await this.createAndSetState(
        `${sysId}.containers.${cId}.cpu`,
        this.percentCommon((0, import_i18n.tName)("cpuUsage")),
        container.cpu
      );
      await this.createAndSetState(
        `${sysId}.containers.${cId}.memory`,
        this.numCommon((0, import_i18n.tName)("containerMemory"), "MB"),
        container.memory
      );
      await this.createAndSetState(
        `${sysId}.containers.${cId}.image`,
        this.textCommon((0, import_i18n.tName)("containerImage")),
        container.image
      );
      if (container.net != null) {
        await this.createAndSetState(
          `${sysId}.containers.${cId}.network`,
          this.numCommon((0, import_i18n.tName)("containerNetwork"), "B/s"),
          container.net
        );
      }
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
        endkey: `${this.adapter.namespace}.${base}.\u9999`
      });
      for (const row of (_a = view == null ? void 0 : view.rows) != null ? _a : []) {
        const id = row.id.startsWith(`${this.adapter.namespace}.`) ? row.id.slice(this.adapter.namespace.length + 1) : row.id;
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
      await this.adapter.setObjectNotExistsAsync(id, {
        type: "state",
        common,
        native: {}
      });
      this.createdIds.add(id);
    }
    await this.adapter.setStateChangedAsync(id, { val: value, ack: true });
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
  /**
   * F7: hottest single sensor — the actionable "is anything overheating" value
   * (vs. the top-3 average). Returns null when there are no finite readings.
   *
   * @param temps Sensor → °C map, or undefined.
   */
  computeMaxTemp(temps) {
    if (!temps) {
      return null;
    }
    const values = Object.values(temps).filter((v) => typeof v === "number" && isFinite(v));
    if (values.length === 0) {
      return null;
    }
    return Math.round(Math.max(...values) * 10) / 10;
  }
  /**
   * F2: map the numeric OS platform enum from system_details into a readable
   * label. Values verified against the v0.18.7 source
   * (`Ressourcen/beszel/beszel-0.18.7/internal/entities/system/system.go`).
   *
   * @param os Platform enum (0=Linux, 1=Darwin/macOS, 2=Windows, 3=FreeBSD).
   */
  osLabel(os) {
    switch (os) {
      case 0:
        return "Linux";
      case 1:
        return "macOS";
      case 2:
        return "Windows";
      case 3:
        return "FreeBSD";
      default:
        return os == null ? null : `Unknown (${os})`;
    }
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
