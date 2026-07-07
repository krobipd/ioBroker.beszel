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
var metric_registry_exports = {};
__export(metric_registry_exports, {
  BATTERY_STATE_CHARGING: () => BATTERY_STATE_CHARGING,
  CHANNEL_NAME_KEY: () => CHANNEL_NAME_KEY,
  DYNAMIC_CHANNEL_TOGGLES: () => DYNAMIC_CHANNEL_TOGGLES,
  METRIC_DEPENDENCIES: () => METRIC_DEPENDENCIES,
  boolCommon: () => boolCommon,
  buildMetricDefs: () => buildMetricDefs,
  bytesToGib: () => bytesToGib,
  bytesToMib: () => bytesToMib,
  channelName: () => channelName,
  clampPercent: () => clampPercent,
  commonFor: () => commonFor,
  computeMaxTemp: () => computeMaxTemp,
  computeTopAvgTemp: () => computeTopAvgTemp,
  finiteTempValues: () => finiteTempValues,
  formatUptime: () => formatUptime,
  numCommon: () => numCommon,
  osLabel: () => osLabel,
  percentCommon: () => percentCommon,
  round1: () => round1,
  textCommon: () => textCommon
});
module.exports = __toCommonJS(metric_registry_exports);
var import_i18n = require("./i18n");
const BATTERY_STATE_CHARGING = 3;
const CHANNEL_NAME_KEY = {
  info: "channelInfo",
  cpu: "channelCpu",
  memory: "channelMemory",
  disk: "channelDisk",
  network: "channelNetwork",
  temperature: "channelTemperature",
  battery: "channelBattery",
  // dynamic-group parents + sub-channels
  cores: "channelCores",
  sensors: "channelSensors",
  interfaces: "channelInterfaces",
  gpu: "channelGpu",
  engines: "channelEngines",
  filesystems: "channelFilesystems",
  containers: "channelContainers"
};
const DYNAMIC_CHANNEL_TOGGLES = {
  cpu: ["metrics_cpuCores"],
  network: ["metrics_networkInterfaces"],
  temperature: ["metrics_temperatureDetails"]
};
const METRIC_DEPENDENCIES = {
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
function percentCommon(name, role = "value") {
  return {
    name,
    type: "number",
    role,
    unit: "%",
    min: 0,
    max: 100,
    read: true,
    write: false
  };
}
function numCommon(name, unit, role = "value") {
  return {
    name,
    type: "number",
    role,
    unit,
    read: true,
    write: false
  };
}
function textCommon(name, role = "text") {
  return {
    name,
    type: "string",
    role,
    read: true,
    write: false
  };
}
function boolCommon(name, role = "indicator") {
  return {
    name,
    type: "boolean",
    role,
    read: true,
    write: false
  };
}
function computeTopAvgTemp(temps) {
  const values = finiteTempValues(temps);
  if (!values) {
    return null;
  }
  values.sort((a, b) => b - a);
  const top3 = values.slice(0, 3);
  return round1(top3.reduce((sum, v) => sum + v, 0) / top3.length);
}
function computeMaxTemp(temps) {
  const values = finiteTempValues(temps);
  if (!values) {
    return null;
  }
  return round1(values.reduce((max, v) => v > max ? v : max, -Infinity));
}
function finiteTempValues(temps) {
  if (!temps) {
    return null;
  }
  const values = Object.values(temps).filter((v) => typeof v === "number" && isFinite(v));
  return values.length > 0 ? values : null;
}
function round1(x) {
  return Math.round(x * 10) / 10;
}
function clampPercent(v) {
  return v === null ? null : Math.min(100, Math.max(0, v));
}
function channelName(ch) {
  return (0, import_i18n.tName)(CHANNEL_NAME_KEY[ch]);
}
function bytesToMib(v) {
  return typeof v === "number" ? Math.round(v / (1024 * 1024) * 1e3) / 1e3 : null;
}
function bytesToGib(v) {
  return typeof v === "number" ? Math.round(v / (1024 * 1024 * 1024) * 1e3) / 1e3 : null;
}
function osLabel(os) {
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
function formatUptime(seconds) {
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
function commonFor(def) {
  var _a;
  const name = (0, import_i18n.tName)(def.nameKey);
  switch (def.kind) {
    case "percent":
      return percentCommon(name, def.role);
    case "text":
      return textCommon(name);
    case "bool":
      return boolCommon(name);
    default:
      return numCommon(name, def.unit, (_a = def.role) != null ? _a : "value");
  }
}
function buildMetricDefs() {
  const hasStats = (s) => !!s;
  const la = (system, stats) => {
    var _a;
    return (_a = stats == null ? void 0 : stats.la) != null ? _a : system.info.la;
  };
  const hasCpub = (s) => !!(s == null ? void 0 : s.cpub) && s.cpub.length >= 5;
  const hasDio = (s, n) => !!(s == null ? void 0 : s.dios) && s.dios.length >= n;
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
      extract: (s) => s.info.u != null ? formatUptime(s.info.u) : null
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
        return osLabel((_a = s.details) == null ? void 0 : _a.os);
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
      available: (_st, s) => s.info.sv != null,
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
      available: (_st, s) => s.info.sv != null,
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
      available: hasCpub,
      extract: (_s, st) => {
        var _a, _b;
        return (_b = (_a = st == null ? void 0 : st.cpub) == null ? void 0 : _a[0]) != null ? _b : null;
      }
    },
    {
      toggle: "metrics_cpuBreakdown",
      channel: "cpu",
      id: "cpu.system",
      nameKey: "cpuSystem",
      kind: "percent",
      available: hasCpub,
      extract: (_s, st) => {
        var _a, _b;
        return (_b = (_a = st == null ? void 0 : st.cpub) == null ? void 0 : _a[1]) != null ? _b : null;
      }
    },
    {
      toggle: "metrics_cpuBreakdown",
      channel: "cpu",
      id: "cpu.iowait",
      nameKey: "cpuIowait",
      kind: "percent",
      available: hasCpub,
      extract: (_s, st) => {
        var _a, _b;
        return (_b = (_a = st == null ? void 0 : st.cpub) == null ? void 0 : _a[2]) != null ? _b : null;
      }
    },
    {
      toggle: "metrics_cpuBreakdown",
      channel: "cpu",
      id: "cpu.steal",
      nameKey: "cpuSteal",
      kind: "percent",
      available: hasCpub,
      extract: (_s, st) => {
        var _a, _b;
        return (_b = (_a = st == null ? void 0 : st.cpub) == null ? void 0 : _a[3]) != null ? _b : null;
      }
    },
    {
      toggle: "metrics_cpuBreakdown",
      channel: "cpu",
      id: "cpu.idle",
      nameKey: "cpuIdle",
      kind: "percent",
      available: hasCpub,
      extract: (_s, st) => {
        var _a, _b;
        return (_b = (_a = st == null ? void 0 : st.cpub) == null ? void 0 : _a[4]) != null ? _b : null;
      }
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
      extract: (_s, st) => computeTopAvgTemp(st == null ? void 0 : st.t)
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
      extract: (_s, st) => computeMaxTemp(st == null ? void 0 : st.t)
    },
    {
      toggle: "metrics_battery",
      channel: "battery",
      id: "battery.percent",
      nameKey: "batteryPercent",
      kind: "percent",
      role: "value.battery",
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
        return b[1] === BATTERY_STATE_CHARGING;
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
      available: (st) => hasDio(st, 3),
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
      available: (st) => hasDio(st, 5),
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
      available: (st) => hasDio(st, 5),
      extract: (_s, st) => {
        var _a, _b;
        return (_b = (_a = st == null ? void 0 : st.dios) == null ? void 0 : _a[4]) != null ? _b : null;
      }
    }
  ];
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  BATTERY_STATE_CHARGING,
  CHANNEL_NAME_KEY,
  DYNAMIC_CHANNEL_TOGGLES,
  METRIC_DEPENDENCIES,
  boolCommon,
  buildMetricDefs,
  bytesToGib,
  bytesToMib,
  channelName,
  clampPercent,
  commonFor,
  computeMaxTemp,
  computeTopAvgTemp,
  finiteTempValues,
  formatUptime,
  numCommon,
  osLabel,
  percentCommon,
  round1,
  textCommon
});
//# sourceMappingURL=metric-registry.js.map
