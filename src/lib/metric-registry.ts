import { tDesc, tName, tState } from "./i18n";
import type { I18nKey } from "./i18n";
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
  channel: ChannelKey;
  /** State id relative to the system (e.g. "cpu.usage"). */
  id: string;
  /** i18n key for the state's display name. */
  nameKey: I18nKey;
  /**
   * i18n key for the state's `common.desc` — one plain sentence explaining what the
   * value means. Omitted where the name and unit already say everything: the fleet
   * standard wants an empty desc rather than an invented one. Leaving it out is a
   * DECISION, not a gap — the datapoint then needs its reason in
   * `test/self-explaining.json`, or gate D08 blocks the next release.
   */
  descKey?: I18nKey;
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
 * Value written into `info.status` while the adapter has no current word from the
 * Hub — stopped, or the Hub unreachable. The Hub's own enum knows only
 * up/down/paused/pending, so claiming one of those would assert something the
 * adapter did not observe; this is the datapoint's own fifth value.
 */
export const SYSTEM_STATUS_UNKNOWN = "unknown";

/**
 * `common.states` of `info.status`: the Hub's four values plus {@link SYSTEM_STATUS_UNKNOWN}.
 * One definition — the update path and the offline reset both write it, so the enum
 * can never drift between them.
 *
 * A FUNCTION, not a constant: the KEYS are the technical values written into the state,
 * the VALUES are labels the admin shows. Those follow the system language via
 * {@link tState} — and they must stay plain strings, because the admin renders a
 * `common.states` value directly as a React child (a translation object there takes the
 * whole GUI down with React error #31; `@iobroker/types` types the field accordingly).
 */
export function systemStatusStates(): Record<string, string> {
  return {
    up: tState("stateUp"),
    down: tState("stateDown"),
    paused: tState("statePaused"),
    pending: tState("statePending"),
    [SYSTEM_STATUS_UNKNOWN]: tState("stateUnknown"),
  };
}

/**
 * `common.states` hint of `zfs.<pool>.health`: zpool's own health words as Beszel 0.19.0
 * forwards them (`ZfsPool.Health`, from `zpool list -H -o health`). A hint for the UI, not
 * a filter — a word from a newer ZFS still lands in the state unchanged. Keys stay zpool's
 * uppercase words, labels follow the system language (see {@link systemStatusStates}).
 */
export function zfsHealthStates(): Record<string, string> {
  return {
    ONLINE: tState("zfsOnline"),
    DEGRADED: tState("zfsDegraded"),
    FAULTED: tState("zfsFaulted"),
    OFFLINE: tState("zfsOffline"),
    REMOVED: tState("zfsRemoved"),
    UNAVAIL: tState("zfsUnavailable"),
    SUSPENDED: tState("zfsSuspended"),
  };
}

/**
 * Container health as Beszel reports it: `health` is an INDEX into this list
 * (0=none, 1=starting, 2=healthy, 3=unhealthy). The adapter turns the index into the
 * word, so unlike the Hub's system status or zpool's health this value set is the
 * ADAPTER's own — which is why it also ships as a `common.states` hint.
 */
export const CONTAINER_HEALTH_LABELS = ["none", "starting", "healthy", "unhealthy"] as const;

/** Written when the Hub sends an index outside {@link CONTAINER_HEALTH_LABELS}. */
export const CONTAINER_HEALTH_UNKNOWN = "unknown";

/**
 * `common.states` of `containers.<name>.health` — the four Docker/Podman words plus
 * {@link CONTAINER_HEALTH_UNKNOWN}. Labels follow the system language.
 */
export function containerHealthStates(): Record<string, string> {
  return {
    none: tState("healthNone"),
    starting: tState("healthStarting"),
    healthy: tState("healthHealthy"),
    unhealthy: tState("healthUnhealthy"),
    [CONTAINER_HEALTH_UNKNOWN]: tState("healthUnknown"),
  };
}

/**
 * Map a Hub health INDEX to its word. Floors the index first — API drift could send a
 * float (e.g. 2.5), which a bare lookup resolves to `undefined`.
 *
 * @param index Raw `health` column of the container record.
 */
export function containerHealthLabel(index: number): string {
  return CONTAINER_HEALTH_LABELS[Math.floor(index)] ?? CONTAINER_HEALTH_UNKNOWN;
}

/**
 * Scrub words the agent reads out of `zpool status` (`internal/entities/zfs`: NONE,
 * SCANNING, FINISHED, CANCELED). The KEYS are those words — that is what lands in the
 * state; only the labels follow the system language.
 */
export function scrubStates(): Record<string, string> {
  return {
    NONE: tState("scrubNone"),
    SCANNING: tState("scrubScanning"),
    FINISHED: tState("scrubFinished"),
    CANCELED: tState("scrubCanceled"),
  };
}

/** `common.states` of a SMART device's overall verdict (smartctl: PASSED / FAILED). */
export function smartStates(): Record<string, string> {
  return { PASSED: tState("smartPassed"), FAILED: tState("smartFailed") };
}

/**
 * systemd unit states in the hub's order (`internal/entities/systemd`: 0 active,
 * 1 inactive, 2 failed, 3 activating, 4 deactivating, 5 reloading).
 */
export const SERVICE_STATE_LABELS = [
  "active",
  "inactive",
  "failed",
  "activating",
  "deactivating",
  "reloading",
] as const;

/** systemd sub-states in the hub's order (0 dead, 1 running, 2 exited, 3 failed, 4 unknown). */
export const SERVICE_SUB_LABELS = ["dead", "running", "exited", "failed", "unknown"] as const;

/** Written when the Hub sends an index outside the two label lists. */
export const SERVICE_UNKNOWN = "unknown";

/** `common.states` of `services.<unit>.state`. */
export function serviceStates(): Record<string, string> {
  return {
    active: tState("svcActive"),
    inactive: tState("svcInactive"),
    failed: tState("svcFailed"),
    activating: tState("svcActivating"),
    deactivating: tState("svcDeactivating"),
    reloading: tState("svcReloading"),
    [SERVICE_UNKNOWN]: tState("subUnknown"),
  };
}

/** `common.states` of `services.<unit>.sub_state`. */
export function serviceSubStates(): Record<string, string> {
  return {
    dead: tState("subDead"),
    running: tState("subRunning"),
    exited: tState("subExited"),
    failed: tState("subFailed"),
    unknown: tState("subUnknown"),
  };
}

/**
 * Index → systemd state word. Floors like {@link containerHealthLabel}: the column is a
 * number in the schema and nothing forbids a fractional value reaching it.
 *
 * @param index State index as the Hub stores it
 */
export function serviceStateLabel(index: number): string {
  return SERVICE_STATE_LABELS[Math.floor(index)] ?? SERVICE_UNKNOWN;
}

/**
 * Index → systemd sub-state word.
 *
 * @param index Sub-state index as the Hub stores it
 */
export function serviceSubLabel(index: number): string {
  return SERVICE_SUB_LABELS[Math.floor(index)] ?? SERVICE_UNKNOWN;
}

/**
 * StateCommon of a container's health word (string, role `info.status`, states hint).
 */
export function containerHealthCommon(): ioBroker.StateCommon {
  return {
    ...textCommon(tName("containerHealth"), "info.status", tDesc("descContainerHealth")),
    states: containerHealthStates(),
  };
}

/**
 * StateCommon of a ZFS pool's health word (string, role `info.status`, states hint).
 */
export function zfsHealthCommon(): ioBroker.StateCommon {
  return { ...textCommon(tName("zfsHealth"), "info.status", tDesc("descZfsHealth")), states: zfsHealthStates() };
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
export const CHANNEL_NAME_KEY = {
  info: "channelInfo",
  cpu: "channelCpu",
  memory: "channelMemory",
  disk: "channelDisk",
  network: "channelNetwork",
  temperature: "channelTemperature",
  battery: "channelBattery",
  fans: "channelFans",
  zfs: "channelZfs",
  // dynamic-group parents + sub-channels
  cores: "channelCores",
  sensors: "channelSensors",
  batteries: "channelBatteries",
  interfaces: "channelInterfaces",
  gpu: "channelGpu",
  engines: "channelEngines",
  filesystems: "channelFilesystems",
  containers: "channelContainers",
  // v0.17.0: the three detail collections (zfs_pools / smart_devices / systemd_services)
  vdevs: "zfsVdevs",
  datasets: "zfsDatasets",
  smart: "smart",
  services: "services",
} as const satisfies Record<string, I18nKey>;

/** Last path segment of a channel the ADAPTER names (i.e. a key of {@link CHANNEL_NAME_KEY}). */
export type ChannelKey = keyof typeof CHANNEL_NAME_KEY;

/**
 * Narrow an arbitrary path segment to a channel the adapter names. Needed where the
 * segment comes from the object tree rather than from a literal — a Hub-named channel
 * (`gpu.<id>`, `containers.<name>`) is not in the catalog and keeps its own name.
 *
 * @param segment Last path segment of a channel id.
 */
export function isChannelKey(segment: string): segment is ChannelKey {
  return Object.prototype.hasOwnProperty.call(CHANNEL_NAME_KEY, segment);
}

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
  // v0.11.0: the fans channel holds ONLY the dynamic per-fan states — this
  // entry is what makes cleanupMetrics delete the channel when the toggle is off.
  fans: ["metrics_fans"],
  // v0.15.0: same shape for the ZFS pools channel (only dynamic per-pool channels).
  zfs: ["metrics_zfs"],
  // v0.16.0: gpu / filesystems / containers are the same shape again — top-level
  // channels holding nothing but their dynamic children. They used to be three
  // hand-written `if` branches in cleanupMetrics next to this table, i.e. two
  // mechanisms for one job; a seventh dynamic channel would have needed a fourth.
  gpu: ["metrics_gpu"],
  filesystems: ["metrics_extraFs"],
  containers: ["metrics_containers"],
  // v0.17.0: two more channels that hold nothing but their dynamic children.
  smart: ["metrics_smart"],
  services: ["metrics_servicesDetails"],
};

/**
 * v0.16.0: dynamic SUB-channels (`<channel>.<sub>` below a system) and the single toggle
 * each one depends on. Same job as {@link DYNAMIC_CHANNEL_TOGGLES} one level down, and the
 * replacement for the hand-written branches that used to delete them. `battery.batteries`
 * is deliberately absent: it has no toggle of its own and disappears with the recursive
 * delete of `battery`.
 */
export const DYNAMIC_SUBCHANNEL_TOGGLES: Record<string, keyof AdapterConfig> = {
  "cpu.cores": "metrics_cpuCores",
  "network.interfaces": "metrics_networkInterfaces",
  "temperature.sensors": "metrics_temperatureDetails",
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
 * completely, with no odd one out. Only the System category (uptime /
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
  // v0.17.0: the ZFS detail collection extends the ZFS group, the systemd unit
  // detail extends the services metric. `metrics_smart` has no base — SMART is its
  // own agent source, like fans and the ZFS group itself.
  metrics_zfsDetails: "metrics_zfs",
  metrics_servicesDetails: "metrics_services",
} satisfies Partial<Record<keyof AdapterConfig, keyof AdapterConfig>>;

/**
 * Build a percentage StateCommon (0–100, unit %, read-only).
 *
 * @param name Localized state name.
 * @param role common.role (default "value"; e.g. "value.battery").
 * @param desc Localized one-sentence explanation, omitted when there is nothing to explain.
 */
export function percentCommon(name: LocalizedName, role = "value", desc?: LocalizedName): ioBroker.StateCommon {
  return {
    name,
    ...(desc ? { desc } : {}),
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
 * @param desc Localized one-sentence explanation, omitted when there is nothing to explain.
 */
export function numCommon(
  name: LocalizedName,
  unit?: string,
  role = "value",
  desc?: LocalizedName,
): ioBroker.StateCommon {
  return {
    name,
    ...(desc ? { desc } : {}),
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
 * @param desc Localized one-sentence explanation, omitted when there is nothing to explain.
 */
export function textCommon(name: LocalizedName, role = "text", desc?: LocalizedName): ioBroker.StateCommon {
  return {
    name,
    ...(desc ? { desc } : {}),
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
 * @param desc Localized one-sentence explanation, omitted when there is nothing to explain.
 */
export function boolCommon(name: LocalizedName, role = "indicator", desc?: LocalizedName): ioBroker.StateCommon {
  return {
    name,
    ...(desc ? { desc } : {}),
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
 * SM8: used/total as a whole percent clamped to [0, 100] — transient `used > total`
 * (data drift between separate polls) must not push more than 100 % into a state.
 * null when either side is missing or the total is 0. Shared by the filesystem and
 * ZFS pool groups.
 *
 * @param total Capacity (GB), or null.
 * @param used Allocated (GB), or null.
 */
export function usedPercent(total: number | null, used: number | null): number | null {
  return total !== null && used !== null && total > 0
    ? Math.min(100, Math.max(0, Math.round((used / total) * 100)))
    : null;
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
 * N7: resolve a channel's translated display name from CHANNEL_NAME_KEY.
 *
 * The parameter is the CHANNEL KEY TYPE, not a bare string: an unmapped segment used to
 * hand `undefined` to adapter-core, which answers `{ en: undefined }` without a word in
 * the log — and the fleet's i18n gate cannot see it because the key is computed, not
 * literal. Now that is a compile error. Callers holding a runtime segment narrow it with
 * {@link isChannelKey} first.
 *
 * @param ch Channel key (e.g. "cpu", "cores", "containers").
 */
export function channelName(ch: ChannelKey): ReturnType<typeof tName> {
  return tName(CHANNEL_NAME_KEY[ch]);
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
 * label. Values verified against beszel v0.18.7 —
 * `internal/entities/system/system.go`.
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
  const name = tName(def.nameKey);
  const desc = def.descKey ? tDesc(def.descKey) : undefined;
  switch (def.kind) {
    case "percent":
      return percentCommon(name, def.role, desc);
    case "text":
      return textCommon(name, "text", desc);
    case "bool":
      return boolCommon(name, "indicator", desc);
    default:
      return numCommon(name, def.unit, def.role ?? "value", desc);
  }
}

// -------------------------------------------------------------------------
// Dynamic-group leaves (v0.16.0)
//
// The counterpart of the scalar registry (K1) for the datapoints inside the
// dynamic groups whose name and description the ADAPTER owns. Both paths read
// THIS table: `updateDynamicStats` when it creates a leaf with a value, and
// `refreshDynamicObjects` when it brings a system without a reading up to date.
//
// Before v0.16.0 the refresh path carried its own copy of all 29 `common`
// expressions, kept in step with the creation code by nothing but an invariant
// test that checked COVERAGE (does every leaf have an entry) and not EQUALITY
// (does the entry build the same common). A changed unit or role on one side
// alone would have passed every gate, and the effect — a wrong common on
// exactly the systems that are offline right now — is visible only on the live
// tree. Hub-named leaves (sensor / fan / battery / GPU-engine) are deliberately
// absent: their name is the device's own and cannot be rebuilt without data.
// -------------------------------------------------------------------------

/**
 * The `common` of every adapter-named leaf inside a dynamic group, by id.
 *
 * Exported so a test can replace one entry and prove that BOTH paths go through
 * {@link leafCommon} — the fleet lesson being that a table can be complete while a
 * caller quietly stopped reading it, with gate, linter and type check all green.
 */
export const LEAF_COMMONS = {
  /** @param arg Core index, from the id (`core7`) or the creation loop. */
  cpuCore: (arg?: string) => percentCommon(tName("cpuCore", Number(arg ?? 0))),
  ifaceUp: () => numCommon(tName("ifaceUp"), "MB/s"),
  ifaceDown: () => numCommon(tName("ifaceDown"), "MB/s"),
  ifaceTotalUp: () => numCommon(tName("ifaceTotalUp"), "GB", "value", tDesc("descIfaceTotal")),
  ifaceTotalDown: () => numCommon(tName("ifaceTotalDown"), "GB", "value", tDesc("descIfaceTotal")),
  gpuUsage: () => percentCommon(tName("gpuUsage")),
  gpuMemoryUsed: () => numCommon(tName("gpuMemoryUsed"), "MB"),
  gpuMemoryTotal: () => numCommon(tName("gpuMemoryTotal"), "MB"),
  gpuPower: () => numCommon(tName("gpuPower"), "W", "value.power"),
  gpuPowerPackage: () => numCommon(tName("gpuPowerPackage"), "W", "value.power", tDesc("descGpuPowerPackage")),
  fsDiskPercent: () => percentCommon(tName("diskPercent")),
  fsDiskUsed: () => numCommon(tName("diskUsed"), "GB"),
  fsDiskTotal: () => numCommon(tName("diskTotal"), "GB"),
  fsReadSpeed: () => numCommon(tName("readSpeed"), "MB/s"),
  fsWriteSpeed: () => numCommon(tName("writeSpeed"), "MB/s"),
  fsTotalRead: () => numCommon(tName("diskTotalRead"), "GB", "value", tDesc("descDiskTotalIo")),
  fsTotalWrite: () => numCommon(tName("diskTotalWrite"), "GB", "value", tDesc("descDiskTotalIo")),
  zfsDiskPercent: () => percentCommon(tName("diskPercent")),
  zfsDiskUsed: () => numCommon(tName("diskUsed"), "GB"),
  zfsDiskTotal: () => numCommon(tName("diskTotal"), "GB"),
  zfsReadSpeed: () => numCommon(tName("readSpeed"), "MB/s"),
  zfsWriteSpeed: () => numCommon(tName("writeSpeed"), "MB/s"),
  zfsHealth: () => zfsHealthCommon(),
  containerStatus: () => textCommon(tName("status")),
  containerHealth: () => containerHealthCommon(),
  containerCpu: () => percentCommon(tName("cpuUsage"), "value", tDesc("descCpuShareOfHost")),
  containerMemory: () => numCommon(tName("containerMemory"), "MB"),
  containerImage: () => textCommon(tName("containerImage")),
  containerNetwork: () => numCommon(tName("containerNetwork"), "B/s", "value", tDesc("descContainerNetwork")),
  // v0.17.0 — ZFS pool details (`zfs_pools`)
  scrubState: () => ({
    ...textCommon(tName("scrubState"), "info.status", tDesc("descScrubState")),
    states: scrubStates(),
  }),
  scrubProgress: () => textCommon(tName("scrubProgress"), "text", tDesc("descScrubProgress")),
  scrubErrors: () => numCommon(tName("scrubErrors"), "", "value", tDesc("descScrubErrors")),
  vdevState: () => ({ ...textCommon(tName("vdevState"), "info.status"), states: zfsHealthStates() }),
  vdevRead: () => numCommon(tName("vdevRead"), "", "value", tDesc("descVdevErrors")),
  vdevWrite: () => numCommon(tName("vdevWrite"), "", "value", tDesc("descVdevErrors")),
  vdevChecksum: () => numCommon(tName("vdevChecksum"), "", "value", tDesc("descVdevErrors")),
  datasetUsed: () => numCommon(tName("datasetUsed"), "GB"),
  datasetAvail: () => numCommon(tName("datasetAvail"), "GB"),
  datasetMount: () => textCommon(tName("datasetMount"), "text"),
  // v0.17.0 — SMART devices (`smart_devices`)
  smartState: () => ({
    ...textCommon(tName("smartState"), "info.status", tDesc("descSmartState")),
    states: smartStates(),
  }),
  smartModel: () => textCommon(tName("smartModel"), "text"),
  smartSerial: () => textCommon(tName("smartSerial"), "text"),
  smartFirmware: () => textCommon(tName("smartFirmware"), "text"),
  smartType: () => textCommon(tName("smartType"), "text"),
  smartTemp: () => numCommon(tName("smartTemp"), "°C", "value.temperature"),
  smartCapacity: () => numCommon(tName("smartCapacity"), "GB"),
  smartHours: () => numCommon(tName("smartHours"), "h", "value", tDesc("descSmartHours")),
  smartCycles: () => numCommon(tName("smartCycles"), "", "value", tDesc("descSmartCycles")),
  // v0.17.0 — systemd units (`systemd_services`)
  serviceState: () => ({ ...textCommon(tName("serviceState"), "info.status"), states: serviceStates() }),
  serviceSub: () => ({
    ...textCommon(tName("serviceSub"), "info.status", tDesc("descServiceSub")),
    states: serviceSubStates(),
  }),
  serviceCpu: () => percentCommon(tName("serviceCpu"), "value", tDesc("descCpuShareOfHost")),
  serviceCpuPeak: () => percentCommon(tName("serviceCpuPeak"), "value", tDesc("descServicePeak")),
  serviceMem: () => numCommon(tName("serviceMem"), "MB"),
  serviceMemPeak: () => numCommon(tName("serviceMemPeak"), "MB", "value", tDesc("descServicePeak")),
} satisfies Record<string, (arg?: string) => ioBroker.StateCommon>;

/** Id of a leaf in {@link LEAF_COMMONS} — a typo is a compile error at both call sites. */
export type DynamicLeafId = keyof typeof LEAF_COMMONS;

/**
 * Which id a state id below the system belongs to. Only the refresh walk needs this
 * direction: it starts from the object tree and has to find the leaf's definition.
 * The single capture group (per-core index) is passed on to {@link leafCommon}.
 */
export const DYNAMIC_LEAF_PATTERNS: { id: DynamicLeafId; match: RegExp }[] = [
  { id: "cpuCore", match: /^cpu\.cores\.core(\d+)$/ },
  { id: "ifaceUp", match: /^network\.interfaces\.[^.]+\.up$/ },
  { id: "ifaceDown", match: /^network\.interfaces\.[^.]+\.down$/ },
  { id: "ifaceTotalUp", match: /^network\.interfaces\.[^.]+\.total_up$/ },
  { id: "ifaceTotalDown", match: /^network\.interfaces\.[^.]+\.total_down$/ },
  { id: "gpuUsage", match: /^gpu\.[^.]+\.usage$/ },
  { id: "gpuMemoryUsed", match: /^gpu\.[^.]+\.memory_used$/ },
  { id: "gpuMemoryTotal", match: /^gpu\.[^.]+\.memory_total$/ },
  { id: "gpuPower", match: /^gpu\.[^.]+\.power$/ },
  { id: "gpuPowerPackage", match: /^gpu\.[^.]+\.power_package$/ },
  { id: "fsDiskPercent", match: /^filesystems\.[^.]+\.disk_percent$/ },
  { id: "fsDiskUsed", match: /^filesystems\.[^.]+\.disk_used$/ },
  { id: "fsDiskTotal", match: /^filesystems\.[^.]+\.disk_total$/ },
  { id: "fsReadSpeed", match: /^filesystems\.[^.]+\.read_speed$/ },
  { id: "fsWriteSpeed", match: /^filesystems\.[^.]+\.write_speed$/ },
  { id: "fsTotalRead", match: /^filesystems\.[^.]+\.total_read$/ },
  { id: "fsTotalWrite", match: /^filesystems\.[^.]+\.total_write$/ },
  { id: "zfsDiskPercent", match: /^zfs\.[^.]+\.disk_percent$/ },
  { id: "zfsDiskUsed", match: /^zfs\.[^.]+\.disk_used$/ },
  { id: "zfsDiskTotal", match: /^zfs\.[^.]+\.disk_total$/ },
  { id: "zfsReadSpeed", match: /^zfs\.[^.]+\.read_speed$/ },
  { id: "zfsWriteSpeed", match: /^zfs\.[^.]+\.write_speed$/ },
  { id: "zfsHealth", match: /^zfs\.[^.]+\.health$/ },
  { id: "containerStatus", match: /^containers\.[^.]+\.status$/ },
  { id: "containerHealth", match: /^containers\.[^.]+\.health$/ },
  { id: "containerCpu", match: /^containers\.[^.]+\.cpu$/ },
  { id: "containerMemory", match: /^containers\.[^.]+\.memory$/ },
  { id: "containerImage", match: /^containers\.[^.]+\.image$/ },
  { id: "containerNetwork", match: /^containers\.[^.]+\.network$/ },
  // v0.17.0 — details of the three extra collections
  { id: "scrubState", match: /^zfs\.[^.]+\.scrub_state$/ },
  { id: "scrubProgress", match: /^zfs\.[^.]+\.scrub_progress$/ },
  { id: "scrubErrors", match: /^zfs\.[^.]+\.scrub_errors$/ },
  { id: "vdevState", match: /^zfs\.[^.]+\.vdevs\.[^.]+\.state$/ },
  { id: "vdevRead", match: /^zfs\.[^.]+\.vdevs\.[^.]+\.read_errors$/ },
  { id: "vdevWrite", match: /^zfs\.[^.]+\.vdevs\.[^.]+\.write_errors$/ },
  { id: "vdevChecksum", match: /^zfs\.[^.]+\.vdevs\.[^.]+\.checksum_errors$/ },
  { id: "datasetUsed", match: /^zfs\.[^.]+\.datasets\.[^.]+\.used$/ },
  { id: "datasetAvail", match: /^zfs\.[^.]+\.datasets\.[^.]+\.avail$/ },
  { id: "datasetMount", match: /^zfs\.[^.]+\.datasets\.[^.]+\.mountpoint$/ },
  { id: "smartState", match: /^smart\.[^.]+\.state$/ },
  { id: "smartModel", match: /^smart\.[^.]+\.model$/ },
  { id: "smartSerial", match: /^smart\.[^.]+\.serial$/ },
  { id: "smartFirmware", match: /^smart\.[^.]+\.firmware$/ },
  { id: "smartType", match: /^smart\.[^.]+\.interface$/ },
  { id: "smartTemp", match: /^smart\.[^.]+\.temperature$/ },
  { id: "smartCapacity", match: /^smart\.[^.]+\.capacity$/ },
  { id: "smartHours", match: /^smart\.[^.]+\.power_on_hours$/ },
  { id: "smartCycles", match: /^smart\.[^.]+\.power_cycles$/ },
  { id: "serviceState", match: /^services\.[^.]+\.state$/ },
  { id: "serviceSub", match: /^services\.[^.]+\.sub_state$/ },
  { id: "serviceCpu", match: /^services\.[^.]+\.cpu$/ },
  { id: "serviceCpuPeak", match: /^services\.[^.]+\.cpu_peak$/ },
  { id: "serviceMem", match: /^services\.[^.]+\.memory$/ },
  { id: "serviceMemPeak", match: /^services\.[^.]+\.memory_peak$/ },
];

/**
 * The one place either path resolves a dynamic leaf's `common`.
 *
 * @param id Leaf id.
 * @param arg Optional argument for the factory (the per-core index).
 */
export function leafCommon(id: DynamicLeafId, arg?: string): ioBroker.StateCommon {
  return LEAF_COMMONS[id](arg);
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
      descKey: "descOsName",
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
      descKey: "descPodman",
      kind: "bool",
      available: (_st, s) => s.details?.podman != null,
      extract: s => s.details?.podman ?? null,
    },
    {
      toggle: "metrics_services",
      channel: "info",
      id: "info.services_total",
      nameKey: "servicesTotal",
      descKey: "descServicesTotal",
      kind: "num",
      available: (_st, s) => s.info.sv != null,
      extract: s => s.info.sv?.[0] ?? null,
    },
    {
      toggle: "metrics_services",
      channel: "info",
      id: "info.services_failed",
      nameKey: "servicesFailed",
      descKey: "descServicesFailed",
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
      descKey: "descLoadAvg",
      kind: "num",
      extract: (s, st) => la(s, st)?.[0] ?? null,
    },
    {
      toggle: "metrics_loadAvg",
      channel: "cpu",
      id: "cpu.load_5m",
      nameKey: "load5m",
      descKey: "descLoadAvg",
      kind: "num",
      extract: (s, st) => la(s, st)?.[1] ?? null,
    },
    {
      toggle: "metrics_loadAvg",
      channel: "cpu",
      id: "cpu.load_15m",
      nameKey: "load15m",
      descKey: "descLoadAvg",
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
      descKey: "descCpuIowait",
      kind: "percent",
      available: hasCpub,
      extract: (_s, st) => st?.cpub?.[2] ?? null,
    },
    {
      toggle: "metrics_cpuBreakdown",
      channel: "cpu",
      id: "cpu.steal",
      nameKey: "cpuSteal",
      descKey: "descCpuSteal",
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
      descKey: "descMemoryBuffers",
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
      descKey: "descMemoryZfsArc",
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
      descKey: "descRootDisk",
      kind: "percent",
      available: hasStats,
      extract: (_s, st) => st?.dp ?? null,
    },
    {
      toggle: "metrics_disk",
      channel: "disk",
      id: "disk.used",
      nameKey: "diskUsed",
      descKey: "descRootDisk",
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
      descKey: "descRootDisk",
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
      descKey: "descRootDisk",
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
      descKey: "descRootDisk",
      kind: "num",
      unit: "MB/s",
      available: hasStats,
      extract: (_s, st) => st?.dw ?? null,
    },
    // Beszel 0.19.0: cumulative device read/write counters (bytes since boot) — a volume,
    // not a rate; shown in GB like the per-interface totals. Rides on the I/O toggle.
    // `omitzero` on the wire, so an older Hub creates nothing.
    {
      toggle: "metrics_diskIo",
      channel: "disk",
      id: "disk.total_read",
      nameKey: "diskTotalRead",
      descKey: "descDiskTotalIo",
      kind: "num",
      unit: "GB",
      available: st => !!st?.diot,
      extract: (_s, st) => bytesToGib(st?.diot?.[0]),
    },
    {
      toggle: "metrics_diskIo",
      channel: "disk",
      id: "disk.total_write",
      nameKey: "diskTotalWrite",
      descKey: "descDiskTotalIo",
      kind: "num",
      unit: "GB",
      available: st => !!st?.diot,
      extract: (_s, st) => bytesToGib(st?.diot?.[1]),
    },
    // Beszel 0.19.0: the root disk's custom name (`FILESYSTEM=device__name` on the agent).
    // Lives in the systems record (`info.rdn`), so it needs no stats; created only when set.
    {
      toggle: "metrics_disk",
      channel: "disk",
      id: "disk.name",
      nameKey: "rootDiskName",
      descKey: "descRootDiskName",
      kind: "text",
      available: (_st, sys) => sys.info.rdn != null,
      extract: s => s.info.rdn ?? null,
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
      descKey: "descTemperatureAvg",
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
      descKey: "descTemperatureMax",
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
      descKey: "descBatteryCharging",
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
      descKey: "descPeak",
      kind: "percent",
      available: st => st?.cpum != null,
      extract: (_s, st) => st?.cpum ?? null,
    },
    {
      toggle: "metrics_memoryPeak",
      channel: "memory",
      id: "memory.peak",
      nameKey: "memoryPeak",
      descKey: "descPeak",
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
      descKey: "descPeak",
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
      descKey: "descPeak",
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
      descKey: "descPeak",
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
      descKey: "descPeak",
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
      descKey: "descDiskIoUtil",
      kind: "percent",
      available: st => hasDio(st, 3),
      extract: (_s, st) => st?.dios?.[2] ?? null,
    },
    {
      toggle: "metrics_diskIo",
      channel: "disk",
      id: "disk.io_await_read",
      nameKey: "diskIoAwaitRead",
      descKey: "descDiskIoAwaitRead",
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
      descKey: "descDiskIoAwaitWrite",
      kind: "num",
      unit: "ms",
      available: st => hasDio(st, 5),
      extract: (_s, st) => st?.dios?.[4] ?? null,
    },
  ];
}
