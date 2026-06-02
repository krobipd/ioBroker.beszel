import type * as utils from "@iobroker/adapter-core";
import { errText } from "./coerce";
import { tName } from "./i18n";
import type { AdapterConfig, BeszelContainer, BeszelSystem, SystemStats } from "./types";

/**
 * Cast helper: ioBroker's `common.name` accepts string or translation object,
 * but the bundled `@types/iobroker` declarations vary by version, so we cast
 * once here and use `LocalizedName` everywhere.
 */
type LocalizedName = ioBroker.StringOrTranslated;

/**
 * One toggled scalar metric. Shared by the create-path (`applyMetrics`) and
 * the cleanup-path (`cleanupMetrics`) so the toggle → state-id mapping has a
 * single source of truth (K1). `available` gates creation on data shape
 * (default: always); `extract` returns the value or null.
 */
interface MetricDef {
  toggle: keyof AdapterConfig;
  channel: string;
  id: string;
  nameKey: string;
  kind: "percent" | "num" | "text" | "bool";
  unit?: string;
  role?: string;
  available?: (stats: SystemStats | undefined, system: BeszelSystem) => boolean;
  extract: (system: BeszelSystem, stats: SystemStats | undefined) => ioBroker.StateValue;
}

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
  private static readonly BATTERY_STATE_CHARGING = 3;

  /** i18n key for each metric channel. */
  private static readonly CHANNEL_NAME_KEY: Record<string, string> = {
    info: "channelInfo",
    cpu: "channelCpu",
    memory: "channelMemory",
    disk: "channelDisk",
    network: "channelNetwork",
    temperature: "channelTemperature",
    battery: "channelBattery",
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
  private static readonly METRIC_DEPENDENCIES = {
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
   * Return a config copy where every detail/peak toggle whose category base is
   * disabled is forced to `false` (see `METRIC_DEPENDENCIES`). Applied at the
   * top of `updateSystem` and `cleanupMetrics` so both create- and cleanup-path
   * see the same effective values — a disabled category's sub-states are never
   * created, and existing ones are pruned.
   *
   * @param config Raw adapter configuration.
   */
  private effectiveConfig(config: AdapterConfig): AdapterConfig {
    const out = { ...config };
    for (const detail of Object.keys(
      StateManager.METRIC_DEPENDENCIES,
    ) as (keyof typeof StateManager.METRIC_DEPENDENCIES)[]) {
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
  private metricDefs(): MetricDef[] {
    const hasStats = (s: SystemStats | undefined): boolean => !!s;
    const la = (system: BeszelSystem, stats: SystemStats | undefined): [number, number, number] | undefined =>
      stats?.la ?? system.info.la;
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
        extract: s => (s.info.u != null ? this.formatUptime(s.info.u) : null),
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
        extract: s => this.osLabel(s.details?.os),
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
        extract: s => s.info.sv?.[0] ?? null,
      },
      {
        toggle: "metrics_services",
        channel: "info",
        id: "info.services_failed",
        nameKey: "servicesFailed",
        kind: "num",
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
        available: st => !!st?.cpub && st.cpub.length >= 5,
        extract: (_s, st) => st!.cpub![0],
      },
      {
        toggle: "metrics_cpuBreakdown",
        channel: "cpu",
        id: "cpu.system",
        nameKey: "cpuSystem",
        kind: "percent",
        available: st => !!st?.cpub && st.cpub.length >= 5,
        extract: (_s, st) => st!.cpub![1],
      },
      {
        toggle: "metrics_cpuBreakdown",
        channel: "cpu",
        id: "cpu.iowait",
        nameKey: "cpuIowait",
        kind: "percent",
        available: st => !!st?.cpub && st.cpub.length >= 5,
        extract: (_s, st) => st!.cpub![2],
      },
      {
        toggle: "metrics_cpuBreakdown",
        channel: "cpu",
        id: "cpu.steal",
        nameKey: "cpuSteal",
        kind: "percent",
        available: st => !!st?.cpub && st.cpub.length >= 5,
        extract: (_s, st) => st!.cpub![3],
      },
      {
        toggle: "metrics_cpuBreakdown",
        channel: "cpu",
        id: "cpu.idle",
        nameKey: "cpuIdle",
        kind: "percent",
        available: st => !!st?.cpub && st.cpub.length >= 5,
        extract: (_s, st) => st!.cpub![4],
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
        extract: (_s, st) => this.computeTopAvgTemp(st?.t),
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
        extract: (_s, st) => this.computeMaxTemp(st?.t),
      },
      {
        toggle: "metrics_battery",
        channel: "battery",
        id: "battery.percent",
        nameKey: "batteryPercent",
        kind: "percent",
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
          return b[1] === StateManager.BATTERY_STATE_CHARGING;
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
        available: st => !!st?.dios && st.dios.length >= 3,
        extract: (_s, st) => st?.dios?.[2] ?? null,
      },
      {
        toggle: "metrics_diskIo",
        channel: "disk",
        id: "disk.io_await_read",
        nameKey: "diskIoAwaitRead",
        kind: "num",
        unit: "ms",
        available: st => !!st?.dios && st.dios.length >= 5,
        extract: (_s, st) => st?.dios?.[3] ?? null,
      },
      {
        toggle: "metrics_diskIo",
        channel: "disk",
        id: "disk.io_await_write",
        nameKey: "diskIoAwaitWrite",
        kind: "num",
        unit: "ms",
        available: st => !!st?.dios && st.dios.length >= 5,
        extract: (_s, st) => st?.dios?.[4] ?? null,
      },
    ];
  }

  /**
   * Build the StateCommon for a metric definition via the existing factories.
   *
   * @param def Metric definition (kind/unit/role/nameKey) to build the common from.
   */
  private commonFor(def: MetricDef): ioBroker.StateCommon {
    const name = tName(def.nameKey as Parameters<typeof tName>[0]);
    switch (def.kind) {
      case "percent":
        return this.percentCommon(name);
      case "text":
        return this.textCommon(name);
      case "bool":
        return this.boolCommon(name);
      default:
        return this.numCommon(name, def.unit, def.role ?? "value");
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
  private async applyMetrics(
    sysId: string,
    system: BeszelSystem,
    stats: SystemStats | undefined,
    config: AdapterConfig,
  ): Promise<void> {
    const active = this.metricDefs().filter(d => config[d.toggle] && (d.available ? d.available(stats, system) : true));
    const channels = new Set(active.map(d => d.channel));
    for (const ch of channels) {
      await this.ensureChannel(
        `${sysId}.${ch}`,
        tName(StateManager.CHANNEL_NAME_KEY[ch] as Parameters<typeof tName>[0]),
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
  public async updateSystem(
    system: BeszelSystem,
    stats: SystemStats | undefined,
    containers: BeszelContainer[],
    rawConfig: AdapterConfig,
  ): Promise<void> {
    // Detail toggles inherit their category's base toggle (off category → off
    // detail). Applied once here so applyMetrics + updateDynamicStats + the
    // container path all see the same effective config.
    const config = this.effectiveConfig(rawConfig);
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

    // All toggled scalar metrics (info + cpu + memory + disk + network +
    // temperature + battery) are driven by the registry (K1) — single source
    // of truth shared with cleanupMetrics. loadAvg's old with-/without-stats
    // split is unified inside the registry (stats.la ?? info.la fallback).
    await this.applyMetrics(sysId, system, stats, config);

    // Dynamic per-item groups (per-sensor temps, per-GPU, per-filesystem)
    // need live stats and fan out to N children — kept in their own handler.
    if (stats) {
      await this.updateDynamicStats(sysId, stats, config);
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
   * @param rawConfig Adapter configuration (detail toggles are gated on their category base via effectiveConfig)
   */
  public async cleanupMetrics(systemId: string, rawConfig: AdapterConfig): Promise<void> {
    // Same dependency gating as updateSystem: a disabled category forces its
    // detail toggles off, so their states (and empty channels) get pruned.
    const config = this.effectiveConfig(rawConfig);
    const sysId = `systems.${systemId}`;
    const toDelete: string[] = [];

    // Scalar metrics: delete the state of every disabled toggle. Driven by the
    // SAME registry as `applyMetrics` (K1) — create- and cleanup-path share one
    // source of truth, so a metric's toggle → state-id mapping can never drift.
    for (const def of this.metricDefs()) {
      if (!config[def.toggle]) {
        toDelete.push(`${sysId}.${def.id}`);
      }
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
    const noCpu =
      !config.metrics_cpu &&
      !config.metrics_loadAvg &&
      !config.metrics_cpuBreakdown &&
      !config.metrics_cpuCores &&
      !config.metrics_cpuPeak;
    if (noCpu) {
      await this.deleteChannelIfExists(`${sysId}.cpu`);
    }

    const noMemory =
      !config.metrics_memory && !config.metrics_memoryDetails && !config.metrics_swap && !config.metrics_memoryPeak;
    if (noMemory) {
      await this.deleteChannelIfExists(`${sysId}.memory`);
    }

    const noDisk =
      !config.metrics_disk && !config.metrics_diskSpeed && !config.metrics_diskIo && !config.metrics_diskPeak;
    if (noDisk) {
      await this.deleteChannelIfExists(`${sysId}.disk`);
    }

    const noNetwork = !config.metrics_network && !config.metrics_networkInterfaces && !config.metrics_networkPeak;
    if (noNetwork) {
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

  private async updateDynamicStats(sysId: string, stats: SystemStats, config: AdapterConfig): Promise<void> {
    // Temperature details — per-sensor. Sensor names come from the agent
    // (e.g. "coretemp_package0") and have no fixed translation — shown as-is.
    // Ensure the parent `temperature` channel here too: the registry only
    // creates it when the average (metrics_temperature) is enabled, but the
    // details can be on with the average off.
    if (config.metrics_temperatureDetails && stats.t) {
      await this.ensureChannel(`${sysId}.temperature`, tName("channelTemperature"));
      await this.ensureChannel(`${sysId}.temperature.sensors`, tName("channelSensors"));
      for (const [sensor, temp] of Object.entries(stats.t)) {
        await this.createAndSetState(
          `${sysId}.temperature.sensors.${this.sanitize(sensor)}`,
          this.numCommon(sensor, "°C", "value.temperature"),
          temp,
        );
      }
    }

    // Per-core CPU usage (v0.6.0). Core labels are positional (CPU0..), shown as-is.
    if (config.metrics_cpuCores && stats.cpus && stats.cpus.length > 0) {
      await this.ensureChannel(`${sysId}.cpu`, tName("channelCpu"));
      await this.ensureChannel(`${sysId}.cpu.cores`, tName("channelCores"));
      for (let i = 0; i < stats.cpus.length; i++) {
        await this.createAndSetState(`${sysId}.cpu.cores.core${i}`, this.percentCommon(`Core ${i}`), stats.cpus[i]);
      }
    }

    // Per-network-interface (v0.6.0). ni: name -> [up, down, total up, total down] bytes.
    if (config.metrics_networkInterfaces && stats.ni && Object.keys(stats.ni).length > 0) {
      await this.ensureChannel(`${sysId}.network`, tName("channelNetwork"));
      await this.ensureChannel(`${sysId}.network.interfaces`, tName("channelInterfaces"));
      for (const [iface, vals] of Object.entries(stats.ni)) {
        const safeId = this.sanitize(iface);
        if (!safeId) {
          continue;
        }
        // Interface name is OS-defined (eth0, wlan0, ...) → kept as-is.
        await this.ensureChannel(`${sysId}.network.interfaces.${safeId}`, iface);
        await this.createAndSetState(
          `${sysId}.network.interfaces.${safeId}.up`,
          this.numCommon(tName("ifaceUp"), "B/s"),
          vals[0] ?? null,
        );
        await this.createAndSetState(
          `${sysId}.network.interfaces.${safeId}.down`,
          this.numCommon(tName("ifaceDown"), "B/s"),
          vals[1] ?? null,
        );
        await this.createAndSetState(
          `${sysId}.network.interfaces.${safeId}.total_up`,
          this.numCommon(tName("ifaceTotalUp"), "B"),
          vals[2] ?? null,
        );
        await this.createAndSetState(
          `${sysId}.network.interfaces.${safeId}.total_down`,
          this.numCommon(tName("ifaceTotalDown"), "B"),
          vals[3] ?? null,
        );
      }
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
          this.numCommon(tName("gpuMemoryUsed"), "MB"),
          gpuData.mu ?? null,
        );
        await this.createAndSetState(
          `${sysId}.gpu.${safeId}.memory_total`,
          this.numCommon(tName("gpuMemoryTotal"), "MB"),
          gpuData.mt ?? null,
        );
        await this.createAndSetState(
          `${sysId}.gpu.${safeId}.power`,
          this.numCommon(tName("gpuPower"), "W"),
          gpuData.p ?? null,
        );
        // GPU details (v0.6.0): package power + per-engine usage.
        if (config.metrics_gpuDetails) {
          await this.createAndSetState(
            `${sysId}.gpu.${safeId}.power_package`,
            this.numCommon(tName("gpuPowerPackage"), "W"),
            gpuData.pp ?? null,
          );
          if (gpuData.e && Object.keys(gpuData.e).length > 0) {
            await this.ensureChannel(`${sysId}.gpu.${safeId}.engines`, tName("channelEngines"));
            for (const [engine, value] of Object.entries(gpuData.e)) {
              const safeEngine = this.sanitize(engine);
              if (safeEngine) {
                // Engine name is vendor-defined → kept as-is.
                await this.createAndSetState(
                  `${sysId}.gpu.${safeId}.engines.${safeEngine}`,
                  this.percentCommon(engine),
                  value,
                );
              }
            }
          }
        }
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

    // F1: prune containers that disappeared from the host. Build the active set
    // and prune BEFORE the early-return — otherwise a system that drops to zero
    // containers would keep its old container state-trees forever (only stale
    // *systems* were cleaned up before, never stale containers within a system).
    const activeIds = new Set<string>();
    for (const container of sysContainers) {
      const cId = this.sanitize(container.name);
      if (cId) {
        activeIds.add(cId);
      }
    }
    await this.cleanupStaleContainers(sysId, activeIds);

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
      // v0.6.0: combined network throughput (sent + recv, bytes/s). Only when
      // the Hub provides it — older Hubs omit the `net` column.
      if (container.net != null) {
        await this.createAndSetState(
          `${sysId}.containers.${cId}.network`,
          this.numCommon(tName("containerNetwork"), "B/s"),
          container.net,
        );
      }
    }
  }

  /**
   * F1: remove container channels under a system that are no longer reported
   * by Beszel (container stopped/removed/renamed on the host). Looks up the
   * direct children of `<sysId>.containers` and deletes any whose sanitized id
   * is not in `activeIds`.
   *
   * @param sysId State prefix (`systems.<safeName>`)
   * @param activeIds Sanitized ids of the containers currently present
   */
  private async cleanupStaleContainers(sysId: string, activeIds: Set<string>): Promise<void> {
    const base = `${sysId}.containers`;
    const view = await this.adapter.getObjectViewAsync("system", "channel", {
      startkey: `${this.adapter.namespace}.${base}.`,
      endkey: `${this.adapter.namespace}.${base}.香`,
    });
    if (!view?.rows) {
      return;
    }
    const stale = new Set<string>();
    for (const row of view.rows) {
      const id = row.id.startsWith(`${this.adapter.namespace}.`)
        ? row.id.slice(this.adapter.namespace.length + 1)
        : row.id;
      if (!id.startsWith(`${base}.`)) {
        continue;
      }
      // Only the direct child segment (`<base>.<cId>`), not deeper state ids.
      const cId = id.slice(base.length + 1).split(".")[0];
      if (cId && !activeIds.has(cId)) {
        stale.add(cId);
      }
    }
    await Promise.all(
      [...stale].map(async cId => {
        this.adapter.log.debug(`Removing stale container: ${base}.${cId}`);
        await this.adapter.delObjectAsync(`${base}.${cId}`, { recursive: true });
        this.dropCacheUnder(`${base}.${cId}`);
      }),
    );
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

  private async createAndSetState(id: string, common: ioBroker.StateCommon, value: ioBroker.StateValue): Promise<void> {
    if (!this.createdIds.has(id)) {
      await this.adapter.setObjectNotExistsAsync(id, {
        type: "state",
        common,
        native: {},
      });
      this.createdIds.add(id);
    }
    await this.adapter.setStateChangedAsync(id, { val: value, ack: true });
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

  /**
   * F7: hottest single sensor — the actionable "is anything overheating" value
   * (vs. the top-3 average). Returns null when there are no finite readings.
   *
   * @param temps Sensor → °C map, or undefined.
   */
  private computeMaxTemp(temps: Record<string, number> | undefined): number | null {
    if (!temps) {
      return null;
    }
    const values = Object.values(temps).filter(v => typeof v === "number" && isFinite(v));
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
  private osLabel(os: number | undefined): string | null {
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
