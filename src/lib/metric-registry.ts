import { tName } from "./i18n";
import type { AdapterConfig, BeszelSystem, SystemStats } from "./types";

/**
 * F2: the metric catalog + value-shaping layer, split out of StateManager so
 * the manager keeps only the ioBroker state I/O orchestration. Everything here
 * is pure (no adapter/log/DB) — the registry predicates take (system, stats)
 * as args and the factories/helpers close over nothing but each other.
 */

/**
 * Cast helper: ioBroker's `common.name` accepts string or translation object,
 * but the bundled `@types/iobroker` declarations vary by version, so we cast
 * once here and use `LocalizedName` everywhere.
 */
export type LocalizedName = ioBroker.StringOrTranslated;

/**
 * One toggled scalar metric. Shared by the create-path (`applyMetrics`) and
 * the cleanup-path (`cleanupMetrics`) so the toggle → state-id mapping has a
 * single source of truth (K1). `available` gates creation on data shape
 * (default: always); `extract` returns the value or null.
 */
export interface MetricDef {
  /** Config toggle that enables this metric. */
  toggle: keyof AdapterConfig;
  /** Channel segment the state lives under (e.g. "cpu"). */
  channel: string;
  /** State id relative to the system (e.g. "cpu.usage"). */
  id: string;
  /** i18n key for the state's display name. */
  nameKey: string;
  /** Which common shape to build. */
  kind: "percent" | "num" | "text" | "bool";
  /** Unit for numeric kinds. */
  unit?: string;
  /** common.role override (defaults per kind). */
  role?: string;
  /** Gate state creation on data shape; default is always-available. */
  available?: (stats: SystemStats | undefined, system: BeszelSystem) => boolean;
  /** Pull the state value from a system and its stats. */
  extract: (system: BeszelSystem, stats: SystemStats | undefined) => ioBroker.StateValue;
}

/**
 * Beszel battery charge-state value that means "actively charging"
 * (agent/battery/battery.go enum: 0=unknown 1=empty 2=full 3=charging
 * 4=discharging 5=idle). Used to map `bat[1]` to the `charging` boolean.
 */
export const BATTERY_STATE_CHARGING = 3;

/**
 * N7: i18n key for every channel — the scalar metric channels (driven by
 * `metricDefs().channel` in applyMetrics) and the dynamic-group parents /
 * sub-channels ensured in updateDynamicStats. Single source so a channel's
 * display name is never spelled inline in two places.
 */
export const CHANNEL_NAME_KEY: Record<string, string> = {
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
  containers: "channelContainers",
};

/**
 * v0.7.2: dynamic-group toggles that write into a scalar channel without
 * appearing in `metricDefs` (their states fan out per item in
 * `updateDynamicStats`). Merged into the derived per-channel toggle sets
 * when `cleanupMetrics` decides whether a channel is completely empty.
 * Exported for unit-tests via the class (invariant lock against jsonConfig).
 */
export const DYNAMIC_CHANNEL_TOGGLES: Record<string, (keyof AdapterConfig)[]> = {
  cpu: ["metrics_cpuCores"],
  network: ["metrics_networkInterfaces"],
  temperature: ["metrics_temperatureDetails"],
};

/**
 * v0.6.0: each detail/peak toggle depends on its category's base toggle — when
 * the category is off, the detail is off too. This mirrors the admin grey-out
 * (`disabled` in jsonConfig) in the DATA logic, so a sub-metric never creates
 * states while its category is disabled (krobi: "Kategorie aus → Unterkategorie
 * automatisch mit aus"). Must stay in sync with the `disabled` conditions in
 * admin/jsonConfig.json. Every non-base metric in a category gates on the
 * category's base/usage metric — including the default-on co-metrics `loadAvg`
 * (→ CPU) and `diskSpeed` (→ Disk): krobi wants a category to switch off
 * completely, no "logischer Ausreißer". Only the System category (uptime /
 * system-info / services) has no single base, so its three are not gated.
 */
export const METRIC_DEPENDENCIES = {
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
  metrics_gpuDetails: "metrics_gpu",
} satisfies Partial<Record<keyof AdapterConfig, keyof AdapterConfig>>;

/**
 * Build a percentage StateCommon (0–100, unit %, read-only).
 *
 * @param name Localized state name.
 * @param role common.role (default "value"; e.g. "value.battery").
 */
export function percentCommon(name: LocalizedName, role = "value"): ioBroker.StateCommon {
  return {
    name,
    type: "number",
    role,
    unit: "%",
    min: 0,
    max: 100,
    read: true,
    write: false,
  };
}

/**
 * Build a numeric StateCommon (read-only).
 *
 * @param name Localized state name.
 * @param unit Optional unit label (e.g. "MB/s").
 * @param role common.role (default "value").
 */
export function numCommon(name: LocalizedName, unit?: string, role = "value"): ioBroker.StateCommon {
  return {
    name,
    type: "number",
    role,
    unit,
    read: true,
    write: false,
  };
}

/**
 * Build a string StateCommon (read-only).
 *
 * @param name Localized state name.
 * @param role common.role (default "text").
 */
export function textCommon(name: LocalizedName, role = "text"): ioBroker.StateCommon {
  return {
    name,
    type: "string",
    role,
    read: true,
    write: false,
  };
}

/**
 * Build a boolean StateCommon (read-only).
 *
 * @param name Localized state name.
 * @param role common.role (default "indicator").
 */
export function boolCommon(name: LocalizedName, role = "indicator"): ioBroker.StateCommon {
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

/**
 * F7: average of the three hottest sensor readings, or null when none.
 *
 * @param temps Sensor → °C map, or undefined.
 */
export function computeTopAvgTemp(temps: Record<string, number> | undefined): number | null {
  const values = finiteTempValues(temps);
  if (!values) {
    return null;
  }
  values.sort((a, b) => b - a);
  const top3 = values.slice(0, 3);
  return round1(top3.reduce((sum, v) => sum + v, 0) / top3.length);
}

/**
 * F7: hottest single sensor — the actionable "is anything overheating" value
 * (vs. the top-3 average). Returns null when there are no finite readings.
 *
 * @param temps Sensor → °C map, or undefined.
 */
export function computeMaxTemp(temps: Record<string, number> | undefined): number | null {
  const values = finiteTempValues(temps);
  if (!values) {
    return null;
  }
  // INFO: reduce, not Math.max(...values) — a hostile Hub could send a huge
  // sensor map and blow V8's argument-count limit (RangeError). computeTopAvgTemp
  // already avoided the spread.
  return round1(values.reduce((max, v) => (v > max ? v : max), -Infinity));
}

/**
 * D1: finite sensor readings shared by the temperature computations, or null when none.
 *
 * @param temps Sensor → °C map, or undefined.
 */
export function finiteTempValues(temps: Record<string, number> | undefined): number[] | null {
  if (!temps) {
    return null;
  }
  const values = Object.values(temps).filter(v => typeof v === "number" && isFinite(v));
  return values.length > 0 ? values : null;
}

/**
 * D1: round to one decimal place.
 *
 * @param x Value to round.
 */
export function round1(x: number): number {
  return Math.round(x * 10) / 10;
}

/**
 * INFO: clamp a percentage to [0, 100], defense-in-depth against a Hub that
 * reports a transiently out-of-range value (mirrors the computed FS percent,
 * SM8). Null passes through so absent data stays null.
 *
 * @param v Percentage value, or null.
 */
export function clampPercent(v: number | null): number | null {
  return v === null ? null : Math.min(100, Math.max(0, v));
}

/**
 * N7: resolve a channel's translated display name from CHANNEL_NAME_KEY. The
 * `tName` key cast lives here once instead of at every ensureChannel call.
 *
 * @param ch Channel key (e.g. "cpu", "cores", "containers").
 */
export function channelName(ch: string): ReturnType<typeof tName> {
  return tName(CHANNEL_NAME_KEY[ch] as Parameters<typeof tName>[0]);
}

/**
 * US7: bytes → MiB, 3-decimal, null-safe. Per-interface network speeds arrive
 * as raw bytes (`ni` = [4]uint64) while the aggregate network.sent/recv is
 * MiB-based MB/s (the Hub does `NetworkSent * 1024 * 1024`, v0.18.7
 * system.go). Normalizing here keeps a dashboard's per-interface and
 * aggregate rows on the same scale.
 *
 * @param v Raw byte value, or undefined.
 */
export function bytesToMib(v: number | undefined): number | null {
  return typeof v === "number" ? Math.round((v / (1024 * 1024)) * 1000) / 1000 : null;
}

/**
 * US7: bytes → GiB, 3-decimal, null-safe. For the per-interface cumulative
 * transfer totals, matching the MiB convention above.
 *
 * @param v Raw byte value, or undefined.
 */
export function bytesToGib(v: number | undefined): number | null {
  return typeof v === "number" ? Math.round((v / (1024 * 1024 * 1024)) * 1000) / 1000 : null;
}

/**
 * F2: map the numeric OS platform enum from system_details into a readable
 * label. Values verified against the v0.18.7 source
 * (`Ressourcen/beszel/beszel-0.18.7/internal/entities/system/system.go`).
 *
 * @param os Platform enum (0=Linux, 1=Darwin/macOS, 2=Windows, 3=FreeBSD).
 */
export function osLabel(os: number | undefined): string | null {
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

/**
 * Format a duration in seconds as a compact `Dd Hh Mm` string.
 *
 * @param seconds Uptime in seconds.
 */
export function formatUptime(seconds: number): string {
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

/**
 * Build the StateCommon for a metric definition via the existing factories.
 *
 * @param def Metric definition (kind/unit/role/nameKey) to build the common from.
 */
export function commonFor(def: MetricDef): ioBroker.StateCommon {
  const name = tName(def.nameKey as Parameters<typeof tName>[0]);
  switch (def.kind) {
    case "percent":
      return percentCommon(name, def.role);
    case "text":
      return textCommon(name);
    case "bool":
      return boolCommon(name);
    default:
      return numCommon(name, def.unit, def.role ?? "value");
  }
}

/**
 * K1: build the scalar-metric registry — one table drives both the create-path
 * (applyMetrics) and the cleanup-path (cleanupMetrics). Stateless: predicates
 * take (system, stats) as args, so StateManager memoizes the result.
 */
export function buildMetricDefs(): MetricDef[] {
  const hasStats = (s: SystemStats | undefined): boolean => !!s;
  const la = (system: BeszelSystem, stats: SystemStats | undefined): [number, number, number] | undefined =>
    stats?.la ?? system.info.la;
  // N4: the per-core (cpub) and disk-I/O (dios) availability guards were copied
  // verbatim across their metric defs — hoist to one predicate each.
  const hasCpub = (s: SystemStats | undefined): boolean => !!s?.cpub && s.cpub.length >= 5;
  const hasDio = (s: SystemStats | undefined, n: number): boolean => !!s?.dios && s.dios.length >= n;
  return [
    // info (no stats required)
    {
      toggle: "metrics_uptime",
      channel: "info",
      id: "info.uptime",
      nameKey: "uptime",
      kind: "num",
      unit: "s",
      extract: s => s.info.u ?? null,
    },
    {
      toggle: "metrics_uptime",
      channel: "info",
      id: "info.uptime_text",
      nameKey: "uptimeFormatted",
      kind: "text",
      extract: s => (s.info.u != null ? formatUptime(s.info.u) : null),
    },
    {
      toggle: "metrics_agentVersion",
      channel: "info",
      id: "info.agent_version",
      nameKey: "agentVersion",
      kind: "text",
      extract: s => s.info.v ?? null,
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
      available: (_st, s) => s.details?.hostname != null,
      extract: s => s.details?.hostname ?? null,
    },
    {
      toggle: "metrics_agentVersion",
      channel: "info",
      id: "info.os",
      nameKey: "os",
      kind: "text",
      available: (_st, s) => s.details?.os != null,
      extract: s => osLabel(s.details?.os),
    },
    {
      toggle: "metrics_agentVersion",
      channel: "info",
      id: "info.os_name",
      nameKey: "osName",
      kind: "text",
      available: (_st, s) => s.details?.os_name != null,
      extract: s => s.details?.os_name ?? null,
    },
    {
      toggle: "metrics_agentVersion",
      channel: "info",
      id: "info.kernel",
      nameKey: "kernel",
      kind: "text",
      available: (_st, s) => s.details?.kernel != null,
      extract: s => s.details?.kernel ?? null,
    },
    {
      toggle: "metrics_agentVersion",
      channel: "info",
      id: "info.cpu_model",
      nameKey: "cpuModel",
      kind: "text",
      available: (_st, s) => s.details?.cpu != null,
      extract: s => s.details?.cpu ?? null,
    },
    {
      toggle: "metrics_agentVersion",
      channel: "info",
      id: "info.arch",
      nameKey: "arch",
      kind: "text",
      available: (_st, s) => s.details?.arch != null,
      extract: s => s.details?.arch ?? null,
    },
    {
      toggle: "metrics_agentVersion",
      channel: "info",
      id: "info.cores",
      nameKey: "cores",
      kind: "num",
      available: (_st, s) => s.details?.cores != null,
      extract: s => s.details?.cores ?? null,
    },
    {
      toggle: "metrics_agentVersion",
      channel: "info",
      id: "info.threads",
      nameKey: "threads",
      kind: "num",
      available: (_st, s) => s.details?.threads != null,
      extract: s => s.details?.threads ?? null,
    },
    {
      toggle: "metrics_agentVersion",
      channel: "info",
      id: "info.podman",
      nameKey: "podman",
      kind: "bool",
      available: (_st, s) => s.details?.podman != null,
      extract: s => s.details?.podman ?? null,
    },
    {
      toggle: "metrics_services",
      channel: "info",
      id: "info.services_total",
      nameKey: "servicesTotal",
      kind: "num",
      available: (_st, s) => s.info.sv != null,
      extract: s => s.info.sv?.[0] ?? null,
    },
    {
      toggle: "metrics_services",
      channel: "info",
      id: "info.services_failed",
      nameKey: "servicesFailed",
      kind: "num",
      available: (_st, s) => s.info.sv != null,
      extract: s => s.info.sv?.[1] ?? null,
    },
    // load average — always created if toggled (stats.la or info.la fallback)
    {
      toggle: "metrics_loadAvg",
      channel: "cpu",
      id: "cpu.load_1m",
      nameKey: "load1m",
      kind: "num",
      extract: (s, st) => la(s, st)?.[0] ?? null,
    },
    {
      toggle: "metrics_loadAvg",
      channel: "cpu",
      id: "cpu.load_5m",
      nameKey: "load5m",
      kind: "num",
      extract: (s, st) => la(s, st)?.[1] ?? null,
    },
    {
      toggle: "metrics_loadAvg",
      channel: "cpu",
      id: "cpu.load_15m",
      nameKey: "load15m",
      kind: "num",
      extract: (s, st) => la(s, st)?.[2] ?? null,
    },
    // stats-gated scalar metrics
    {
      toggle: "metrics_cpu",
      channel: "cpu",
      id: "cpu.usage",
      nameKey: "cpuUsage",
      kind: "percent",
      available: hasStats,
      extract: (_s, st) => st?.cpu ?? null,
    },
    {
      toggle: "metrics_cpuBreakdown",
      channel: "cpu",
      id: "cpu.user",
      nameKey: "cpuUser",
      kind: "percent",
      available: hasCpub,
      extract: (_s, st) => st?.cpub?.[0] ?? null,
    },
    {
      toggle: "metrics_cpuBreakdown",
      channel: "cpu",
      id: "cpu.system",
      nameKey: "cpuSystem",
      kind: "percent",
      available: hasCpub,
      extract: (_s, st) => st?.cpub?.[1] ?? null,
    },
    {
      toggle: "metrics_cpuBreakdown",
      channel: "cpu",
      id: "cpu.iowait",
      nameKey: "cpuIowait",
      kind: "percent",
      available: hasCpub,
      extract: (_s, st) => st?.cpub?.[2] ?? null,
    },
    {
      toggle: "metrics_cpuBreakdown",
      channel: "cpu",
      id: "cpu.steal",
      nameKey: "cpuSteal",
      kind: "percent",
      available: hasCpub,
      extract: (_s, st) => st?.cpub?.[3] ?? null,
    },
    {
      toggle: "metrics_cpuBreakdown",
      channel: "cpu",
      id: "cpu.idle",
      nameKey: "cpuIdle",
      kind: "percent",
      available: hasCpub,
      extract: (_s, st) => st?.cpub?.[4] ?? null,
    },
    {
      toggle: "metrics_memory",
      channel: "memory",
      id: "memory.percent",
      nameKey: "memoryPercent",
      kind: "percent",
      available: hasStats,
      extract: (_s, st) => st?.mp ?? null,
    },
    {
      toggle: "metrics_memory",
      channel: "memory",
      id: "memory.used",
      nameKey: "memoryUsed",
      kind: "num",
      unit: "GB",
      available: hasStats,
      extract: (_s, st) => st?.mu ?? null,
    },
    {
      toggle: "metrics_memory",
      channel: "memory",
      id: "memory.total",
      nameKey: "memoryTotal",
      kind: "num",
      unit: "GB",
      available: hasStats,
      extract: (_s, st) => st?.m ?? null,
    },
    {
      toggle: "metrics_memoryDetails",
      channel: "memory",
      id: "memory.buffers",
      nameKey: "memoryBuffers",
      kind: "num",
      unit: "GB",
      available: hasStats,
      extract: (_s, st) => st?.mb ?? null,
    },
    {
      toggle: "metrics_memoryDetails",
      channel: "memory",
      id: "memory.zfs_arc",
      nameKey: "memoryZfsArc",
      kind: "num",
      unit: "GB",
      available: hasStats,
      extract: (_s, st) => st?.mz ?? null,
    },
    {
      toggle: "metrics_swap",
      channel: "memory",
      id: "memory.swap_used",
      nameKey: "swapUsed",
      kind: "num",
      unit: "GB",
      available: hasStats,
      extract: (_s, st) => st?.su ?? null,
    },
    {
      toggle: "metrics_swap",
      channel: "memory",
      id: "memory.swap_total",
      nameKey: "swapTotal",
      kind: "num",
      unit: "GB",
      available: hasStats,
      extract: (_s, st) => st?.s ?? null,
    },
    {
      toggle: "metrics_disk",
      channel: "disk",
      id: "disk.percent",
      nameKey: "diskPercent",
      kind: "percent",
      available: hasStats,
      extract: (_s, st) => st?.dp ?? null,
    },
    {
      toggle: "metrics_disk",
      channel: "disk",
      id: "disk.used",
      nameKey: "diskUsed",
      kind: "num",
      unit: "GB",
      available: hasStats,
      extract: (_s, st) => st?.du ?? null,
    },
    {
      toggle: "metrics_disk",
      channel: "disk",
      id: "disk.total",
      nameKey: "diskTotal",
      kind: "num",
      unit: "GB",
      available: hasStats,
      extract: (_s, st) => st?.d ?? null,
    },
    {
      toggle: "metrics_diskSpeed",
      channel: "disk",
      id: "disk.read",
      nameKey: "diskRead",
      kind: "num",
      unit: "MB/s",
      available: hasStats,
      extract: (_s, st) => st?.dr ?? null,
    },
    {
      toggle: "metrics_diskSpeed",
      channel: "disk",
      id: "disk.write",
      nameKey: "diskWrite",
      kind: "num",
      unit: "MB/s",
      available: hasStats,
      extract: (_s, st) => st?.dw ?? null,
    },
    {
      toggle: "metrics_network",
      channel: "network",
      id: "network.sent",
      nameKey: "networkSent",
      kind: "num",
      unit: "MB/s",
      available: hasStats,
      extract: (_s, st) => st?.ns ?? null,
    },
    {
      toggle: "metrics_network",
      channel: "network",
      id: "network.recv",
      nameKey: "networkReceived",
      kind: "num",
      unit: "MB/s",
      available: hasStats,
      extract: (_s, st) => st?.nr ?? null,
    },
    {
      toggle: "metrics_temperature",
      channel: "temperature",
      id: "temperature.average",
      nameKey: "temperatureAvg",
      kind: "num",
      unit: "°C",
      role: "value.temperature",
      available: hasStats,
      extract: (_s, st) => computeTopAvgTemp(st?.t),
    },
    {
      toggle: "metrics_temperature",
      channel: "temperature",
      id: "temperature.max",
      nameKey: "temperatureMax",
      kind: "num",
      unit: "°C",
      role: "value.temperature",
      available: hasStats,
      extract: (_s, st) => computeMaxTemp(st?.t),
    },
    {
      toggle: "metrics_battery",
      channel: "battery",
      id: "battery.percent",
      nameKey: "batteryPercent",
      kind: "percent",
      role: "value.battery",
      available: hasStats,
      extract: (s, st) => (st?.bat ?? s.info.bat)?.[0] ?? null,
    },
    {
      toggle: "metrics_battery",
      channel: "battery",
      id: "battery.charging",
      nameKey: "batteryCharging",
      kind: "bool",
      available: hasStats,
      extract: (s, st) => {
        const b = st?.bat ?? s.info.bat;
        if (!b) {
          return null;
        }
        // bat[1] is a charge-STATE enum, not a boolean — verified against
        // agent/battery/battery.go: 0=unknown, 1=empty, 2=full, 3=charging,
        // 4=discharging, 5=idle. Only state 3 means actively charging; the
        // old `> 0` wrongly reported charging while discharging/full/idle.
        return b[1] === BATTERY_STATE_CHARGING;
      },
    },
    // --- v0.6.0 peaks + detail (available-gated on the field being present,
    // so an older Beszel that doesn't send it gets no empty state) ---
    {
      toggle: "metrics_cpuPeak",
      channel: "cpu",
      id: "cpu.peak",
      nameKey: "cpuPeak",
      kind: "percent",
      available: st => st?.cpum != null,
      extract: (_s, st) => st?.cpum ?? null,
    },
    {
      toggle: "metrics_memoryPeak",
      channel: "memory",
      id: "memory.peak",
      nameKey: "memoryPeak",
      kind: "num",
      unit: "GB",
      available: st => st?.mm != null,
      extract: (_s, st) => st?.mm ?? null,
    },
    {
      toggle: "metrics_diskPeak",
      channel: "disk",
      id: "disk.read_peak",
      nameKey: "diskReadPeak",
      kind: "num",
      unit: "MB/s",
      available: st => st?.drm != null,
      extract: (_s, st) => st?.drm ?? null,
    },
    {
      toggle: "metrics_diskPeak",
      channel: "disk",
      id: "disk.write_peak",
      nameKey: "diskWritePeak",
      kind: "num",
      unit: "MB/s",
      available: st => st?.dwm != null,
      extract: (_s, st) => st?.dwm ?? null,
    },
    {
      toggle: "metrics_networkPeak",
      channel: "network",
      id: "network.sent_peak",
      nameKey: "networkSentPeak",
      kind: "num",
      unit: "MB/s",
      available: st => st?.nsm != null,
      extract: (_s, st) => st?.nsm ?? null,
    },
    {
      toggle: "metrics_networkPeak",
      channel: "network",
      id: "network.recv_peak",
      nameKey: "networkRecvPeak",
      kind: "num",
      unit: "MB/s",
      available: st => st?.nrm != null,
      extract: (_s, st) => st?.nrm ?? null,
    },
    {
      toggle: "metrics_diskIo",
      channel: "disk",
      id: "disk.io_util",
      nameKey: "diskIoUtil",
      kind: "percent",
      available: st => hasDio(st, 3),
      extract: (_s, st) => st?.dios?.[2] ?? null,
    },
    {
      toggle: "metrics_diskIo",
      channel: "disk",
      id: "disk.io_await_read",
      nameKey: "diskIoAwaitRead",
      kind: "num",
      unit: "ms",
      available: st => hasDio(st, 5),
      extract: (_s, st) => st?.dios?.[3] ?? null,
    },
    {
      toggle: "metrics_diskIo",
      channel: "disk",
      id: "disk.io_await_write",
      nameKey: "diskIoAwaitWrite",
      kind: "num",
      unit: "ms",
      available: st => hasDio(st, 5),
      extract: (_s, st) => st?.dios?.[4] ?? null,
    },
  ];
}
