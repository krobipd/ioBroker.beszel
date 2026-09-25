/**
 * Adapter configuration as stored in ioBroker native config
 */
export interface AdapterConfig {
  /** Beszel Hub URL, e.g. http://192.168.1.100:8090 */
  url: string;
  /** Login username */
  username: string;
  /** Login password */
  password: string;
  /** Poll interval in seconds */
  pollInterval: number;
  /**
   * v0.4.3 (B5): per-request HTTP timeout in seconds. Defaults to 15s when
   * missing/unparseable. Useful when the Hub returns large container/stats
   * payloads or sits behind a slow link.
   */
  requestTimeout?: number;

  // Metric toggles
  /** Enable uptime states */
  metrics_uptime: boolean;
  /** Enable agent version state */
  metrics_agentVersion: boolean;
  /** Enable systemd services states */
  metrics_services: boolean;

  /** Enable CPU usage state */
  metrics_cpu: boolean;
  /** Enable load average states */
  metrics_loadAvg: boolean;
  /** Enable CPU breakdown states (user/system/iowait/steal/idle) */
  metrics_cpuBreakdown: boolean;

  /** Enable memory states */
  metrics_memory: boolean;
  /** Enable memory detail states (buffers, ZFS ARC) */
  metrics_memoryDetails: boolean;
  /** Enable swap states */
  metrics_swap: boolean;

  /** Enable disk usage states */
  metrics_disk: boolean;
  /** Enable disk speed states */
  metrics_diskSpeed: boolean;
  /** Enable extra filesystem states */
  metrics_extraFs: boolean;

  /** Enable network states */
  metrics_network: boolean;

  /** Enable temperature state (avg top 3 sensors) */
  metrics_temperature: boolean;
  /** Enable per-sensor temperature states */
  metrics_temperatureDetails: boolean;

  /** Enable GPU states */
  metrics_gpu: boolean;

  /** Enable container states */
  metrics_containers: boolean;

  /** Enable battery states */
  metrics_battery: boolean;

  // --- v0.6.0 additions (all default off — opt-in details) ---
  // v0.16.0: required like every other toggle. They were optional only because they
  // arrived later; the manifest ships all of them with a default, `effectiveConfig`
  // writes to them, and one interface with two rules for the same kind of field was a
  // trap waiting for the next addition.
  /** Per-core CPU usage states */
  metrics_cpuCores: boolean;
  /** Disk I/O detail (bytes + utilization + wait times) */
  metrics_diskIo: boolean;
  /** Per-network-interface states */
  metrics_networkInterfaces: boolean;
  /** GPU detail states (package power + per-engine usage) */
  metrics_gpuDetails: boolean;
  // --- v0.11.0 additions (Beszel 0.18.8) ---
  /** Per-fan RPM states (Beszel 0.18.8+, Linux hwmon) */
  metrics_fans: boolean;
  // --- v0.15.0 additions (Beszel 0.19.0) ---
  /** Per-pool ZFS states: usage, throughput, health (Beszel 0.19.0+) */
  metrics_zfs: boolean;
  /** v0.17.0: ZFS pool DETAILS from the `zfs_pools` collection (scrub, vdevs, datasets). */
  metrics_zfsDetails: boolean;
  /** v0.17.0: SMART devices from the `smart_devices` collection. */
  metrics_smart: boolean;
  /** v0.17.0: per-unit systemd detail from the `systemd_services` collection. */
  metrics_servicesDetails: boolean;
  /** v0.19.0: network monitors from the `network_monitors` collection (Beszel 0.20.0). */
  metrics_networkMonitors: boolean;
}

/**
 * System info object from Beszel systems record
 */
export interface SystemInfo {
  /** Uptime in seconds */
  u?: number;
  /** Agent version */
  v?: string;
  /** Systemd services [total, failed] */
  sv?: [number, number];
  /** Load average [1m, 5m, 15m] */
  la?: [number, number, number];
  /** Battery [percent, charge_state] */
  bat?: [number, number];
  /** Custom root disk name set on the agent (`FILESYSTEM=device__name`), Beszel 0.19.0+ */
  rdn?: string;
}

/**
 * Static hardware / OS info for one system. Lives in the `system_details`
 * collection (Beszel v0.18.0+); the adapter fetches it only when the
 * "System info" metric is enabled, and rarely (once at start + when a new
 * system appears) because it changes only on agent restart/upgrade.
 *
 * Every field is optional — an older Beszel without the collection, or a
 * partially-populated agent, simply yields absent fields (→ no state created).
 * Column names verified against the beszel v0.18.7 collection snapshot (the
 * bundled release, not main) — note `os_name` is snake_case and `os` is a
 * numeric platform enum, not a string.
 */
export interface SystemDetails {
  /** Host name */
  hostname?: string;
  /** OS platform enum: 0=Linux, 1=Darwin (macOS), 2=Windows, 3=FreeBSD */
  os?: number;
  /** Full OS name, e.g. "Ubuntu 22.04" / "macOS 14.1" */
  os_name?: string;
  /** Kernel version */
  kernel?: string;
  /** CPU model name */
  cpu?: string;
  /** CPU architecture, e.g. "x86_64" / "arm64" */
  arch?: string;
  /** Physical CPU cores */
  cores?: number;
  /** Logical CPU threads */
  threads?: number;
  /** Container engine is Podman (vs Docker) */
  podman?: boolean;
}

/**
 * A system record from /api/collections/systems/records
 */
export interface BeszelSystem {
  /** PocketBase record ID */
  id: string;
  /** Display name */
  name: string;
  /** Current system status */
  status: "up" | "down" | "paused" | "pending";
  /** Hostname or IP */
  host: string;
  /** System info object */
  info: SystemInfo;
  /**
   * Static hardware/OS info, attached by the poll loop from the separately
   * fetched `system_details` collection (only when "System info" is enabled).
   * Absent on systems whose details aren't (yet) cached.
   */
  details?: SystemDetails;
}

/**
 * A system_details record from /api/collections/system_details/records.
 */
export interface BeszelSystemDetailsRecord {
  /** Reference to systems.id */
  system: string;
  /** Static hardware/OS fields */
  details: SystemDetails;
}

/**
 * Extra filesystem stats
 */
export interface FsStats {
  /** disk total GB */
  d?: number;
  /** disk used GB */
  du?: number;
  /**
   * read MB/s. Beszel marks `r`/`w` "TODO: remove" (`system.go`, 0.20.0) in favour of the
   * byte rates `rb`/`wb`, which it already sends; the agent still fills both today.
   */
  r?: number;
  /** write MB/s (see `r`) */
  w?: number;
  /** cumulative device read bytes (Beszel 0.19.0+, `omitzero`) */
  tr?: number;
  /** cumulative device write bytes (Beszel 0.19.0+, `omitzero`) */
  tw?: number;
}

/**
 * Per-pool storage metrics of one collection interval (Beszel 0.19.0+, `system_stats.stats.z`).
 * Verified against beszel v0.20.0 `internal/entities/system/system.go` (`ZfsPool`): capacities in
 * GiB like the root disk, throughput in bytes/s (`omitzero` — absent when idle), health as the
 * pool word (ONLINE, DEGRADED, FAULTED, …). Since 0.20.0 the map also carries btrfs
 * filesystems under `b:<UUID>`, with a display name and a raw-capacity flag.
 */
export interface ZfsPoolStats {
  /** total capacity GiB */
  d?: number;
  /** allocated GiB */
  du?: number;
  /** read throughput bytes/s */
  rb?: number;
  /** write throughput bytes/s */
  wb?: number;
  /** pool health word */
  h?: string;
  /**
   * Beszel 0.20.0: display name of a btrfs pool (label, else first mount point, else UUID —
   * `agent/btrfs/btrfs_linux.go`); empty for ZFS, whose name is the map key itself.
   */
  n?: string;
  /**
   * Beszel 0.20.0: capacity and usage are raw physical bytes (statfs failed on the pool),
   * "unsuitable for disk alerts" per the agent — no percentage is derived from them.
   */
  raw?: boolean;
}

/**
 * GPU data
 */
export interface GPUData {
  /** GPU name */
  n?: string;
  /** GPU usage % */
  u?: number;
  /** GPU memory used MB (agent reports MiB/bytes → MB, verified gpu.go) */
  mu?: number;
  /** GPU memory total MB (agent reports MiB/bytes → MB, verified gpu.go) */
  mt?: number;
  /** GPU power W */
  p?: number;
  /** Package power W (v0.18.7) */
  pp?: number;
  /** Per-engine usage %: engine name -> % (v0.18.7) */
  e?: Record<string, number>;
}

/**
 * The stats object inside a system_stats record
 */
export interface SystemStats {
  /** CPU usage % */
  cpu?: number;
  /** RAM used GB */
  mu?: number;
  /** RAM total GB */
  m?: number;
  /** RAM % */
  mp?: number;
  /** Buffers + cache GB */
  mb?: number;
  /** ZFS ARC GB */
  mz?: number;
  /** Swap used GB */
  su?: number;
  /** Swap total GB */
  s?: number;
  /** Disk used GB */
  du?: number;
  /** Disk total GB */
  d?: number;
  /** Disk % */
  dp?: number;
  /**
   * Disk read MB/s — deprecated on the wire since Beszel 0.18.3 (`dio` is the canonical
   * field). Still sent by 0.19.0 agents while the disk is busy; the Hub zeroes it for
   * older agents after back-filling `dio`. Read only as a fallback when `dio` is absent.
   */
  dr?: number;
  /** Disk write MB/s — see `dr`. */
  dw?: number;
  /**
   * Network sent MB/s — deprecated on the wire since Beszel 0.18.3 (`b` is the canonical
   * field). A Hub >= 0.19.0 never delivers it: the agent no longer fills it and the Hub's
   * `migrateDeprecatedFields` zeroes it after back-filling `b`. Read only as a fallback
   * for older Hubs without that migration.
   */
  ns?: number;
  /** Network recv MB/s — see `ns`. */
  nr?: number;
  /**
   * Bandwidth [sent bytes/s, recv bytes/s] — the canonical network rate since Beszel 0.18.3
   * (`omitzero`: absent while the network is idle, i.e. both are zero).
   */
  b?: [number, number];
  /**
   * Disk I/O [read bytes/s, write bytes/s] — the canonical disk rate since Beszel 0.18.3
   * (`omitzero`: absent while the disk is idle).
   */
  dio?: [number, number];
  /** Temperatures map sensor->°C */
  t?: Record<string, number>;
  /** Load avg [1m, 5m, 15m] */
  la?: [number, number, number];
  /** GPU data */
  g?: Record<string, GPUData>;
  /** Extra filesystems */
  efs?: Record<string, FsStats>;
  /** Battery [%, charge_state] */
  bat?: [number, number];
  /** CPU breakdown [user, sys, iowait, steal, idle] % */
  cpub?: number[];
  // --- v0.18.7 additions (all optional → absent on older Beszel versions) ---
  /**
   * Per-interface bandwidth: name -> [up bytes/s, down bytes/s, total up bytes,
   * total down bytes]. up/down are rates; total_up/total_down are cumulative
   * since boot (the only genuine cumulative network counters Beszel exposes).
   */
  ni?: Record<string, [number, number, number, number]>;
  /** Per-core CPU busy % */
  cpus?: number[];
  /** Disk I/O stats [read time %, write time %, io util %, r_await ms, w_await ms, weighted io %] */
  dios?: number[];
  // --- v0.18.8 additions (both absent on older Beszel versions) ---
  /**
   * Fan speeds: fan name -> RPM. Linux hwmon only; keys are
   * `<chip>_<label-or-fanN>` and may contain spaces. 0 RPM is a real reading
   * (stopped fan) — verified against beszel v0.18.8 agent/fans.go.
   */
  f?: Record<string, number>;
  /**
   * Per-battery charge: battery name -> percent (0–100). The aggregate `bat`
   * tuple (primary battery) stays alongside. Names are OS-reported with a
   * `Battery N` fallback — verified against beszel v0.18.8 agent/system.go.
   */
  bats?: Record<string, number>;
  // --- v0.19.0 additions (both absent on older Beszel versions) ---
  /** ZFS pools: pool name -> metrics (Beszel 0.19.0+). */
  z?: Record<string, ZfsPoolStats>;
  /** Cumulative device counters [read bytes, write bytes] since boot (Beszel 0.19.0+, `omitzero`). */
  diot?: [number, number];
}

// Note: the peak fields (`cpum`, `mm`, `drm`, `dwm`, `nsm`, `nrm`, `bm`, `diom`, `diosm`)
// are deliberately NOT in this interface. They are `cbor:"-"` in Beszel's Stats struct —
// the agent never transmits them; the Hub computes them only while aggregating 1m records
// into the 10m/20m/120m/480m resolutions (`internal/records/records.go`). The adapter reads
// the 1m records. A Hub from 0.19.0 on (encoding/json v2) does write them into the 1m record
// as 0 — measured on a 0.20.0 Hub —, which carries no information either.

/**
 * A system_stats record from /api/collections/system_stats/records
 */
export interface BeszelSystemStats {
  /** Reference to systems.id — the only reference the client keys on. */
  system: string;
  /** Metric values */
  stats: SystemStats;
}

/**
 * A container record from /api/collections/containers/records
 */
export interface BeszelContainer {
  /** PocketBase record ID */
  id: string;
  /** Reference to systems.id */
  system: string;
  /** Container name */
  name: string;
  /** Docker's status text as the agent reads it ("Up 3 hours", "Exited (0) 2 days ago") */
  status: string;
  /** 0=none 1=starting 2=healthy 3=unhealthy */
  health: number;
  /** CPU usage % */
  cpu: number;
  /** Memory usage MB */
  memory: number;
  /** Docker image name */
  image: string;
  /**
   * Combined network throughput in bytes/s (sent + recv). Hub stores
   * `Bandwidth[0] + Bandwidth[1]` in the `net` column (v0.18.7). Optional —
   * absent on an older Hub → no container network state.
   */
  net?: number;
  /**
   * Beszel 0.20.0: an image update is available (the agent checks the registry once an
   * hour per image). `false` means "no update known" — also a digest-pinned or excluded
   * image, a failed or not-yet-run check, an agent < 0.20. Absent on an older Hub.
   */
  updatable?: boolean;
}

/**
 * PocketBase list response — only the two fields the client actually reads.
 * `page`/`perPage`/`totalItems` are dropped from the raw body during coercion
 * (fetchAllPages drives pagination from `totalPages` alone).
 */
export interface PocketBaseList<T> {
  /** Total number of pages */
  totalPages: number;
  /** Records on this page that survived coercion */
  items: T[];
  /**
   * Records the page carried before coercion dropped any. Distinguishes the
   * genuinely empty page (past the last one) from a page whose records were all
   * unusable — only the former ends the pagination walk.
   */
  rawCount: number;
  /** Total number of records across all pages, as the Hub counts them (0 when absent). */
  totalItems: number;
  /**
   * `false` when the body is not a PocketBase list at all (no object, or no `items` array)
   * — a proxy page or another service at the URL. Such a body must not read as
   * "zero records", which the empty-list guards would then take at face value.
   */
  valid: boolean;
}

/**
 * PocketBase auth response
 */
export interface AuthResponse {
  /** Auth token — sent as the bare `Authorization` header value (Beszel/PocketBase uses no "Bearer " prefix). */
  token: string;
}

/**
 * Error codes the BeszelClient tags onto thrown errors via `err.code`. main.ts's
 * `classifyError` reads exactly these (plus Node's own network codes like
 * ENOTFOUND). Shared so the producer (client) and consumer (main) can't drift on
 * a bare string literal — a typo is now a compile error (F4). The timeout path
 * uses ETIMEDOUT so classification no longer depends on a message substring (N6).
 */
export type BeszelErrorCode =
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "RATE_LIMITED"
  | "HTTP_ERROR"
  | "INVALID_AUTH_RESPONSE"
  | "ETIMEDOUT"
  // The login itself, told apart by what PocketBase answers (measured on a 0.20.0 Hub):
  // 400 "Failed to authenticate." (wrong e-mail/password, a user name instead of the
  // e-mail, superuser credentials), 401 with `mfaId` (one-time-password login on),
  // 403 "not configured to allow password authentication" (password login off) and any
  // other 403 (e.g. the account is not verified).
  | "AUTH_FAILED"
  | "MFA_REQUIRED"
  | "PASSWORD_AUTH_DISABLED"
  | "AUTH_FORBIDDEN"
  // A body that is not the Beszel API (proxy page, SPA fallback, other service).
  | "INVALID_RESPONSE"
  | "INVALID_URL"
  | "RESPONSE_TOO_LARGE"
  // cancelAll() on shutdown — the request never reached an answer.
  | "ABORTED"
  // More records than the adapter reads in one walk: the list is incomplete and must
  // not be treated as the full set (a missing entry would read as "gone").
  | "TRUNCATED";

/**
 * One row of the Hub's `zfs_pools` collection — the DETAIL record the agent refreshes
 * hourly, next to the summary the adapter already reads from `stats.z`.
 *
 * Verified against the bundled Beszel 0.20.0 source: the hub writes `name`, `health`,
 * `display_name`, `raw`,
 * `size`/`alloc`/`free` (bytes) plus the three JSON columns from
 * `internal/hub/systems/system_zfs.go:upsertZfsPoolRecord`. Read access is the same
 * `systemScopedReadRule` as `system_stats` (`internal/hub/collections.go`), so the
 * adapter's existing credentials suffice.
 */
export interface ZfsPoolDetail {
  /** PocketBase record ID */
  id: string;
  /** Reference to systems.id */
  system: string;
  /**
   * Pool key: the zpool name, or `b:<UUID>` for a btrfs pool (Beszel 0.20.0) — the same key
   * as in `stats.z`.
   */
  name: string;
  /** Beszel 0.20.0: display name (btrfs: label, mount point or UUID; empty for ZFS). */
  displayName?: string;
  /** Beszel 0.20.0: capacity/usage are raw physical bytes. */
  raw?: boolean;
  /**
   * Scrub/resilver state: SCANNING | FINISHED | CANCELED. Absent → the pool has no scrub
   * record (a ZFS pool never scrubbed; a btrfs pool always — the agent drops `NONE`).
   */
  scrubState?: string;
  /** Progress the agent read from `zpool status` while scanning, as "NN.NN%" */
  scrubProgress?: string;
  /** Errors the last scrub found (0 once a scrub finished without errors) */
  scrubErrors?: number;
  /** vdevs of the pool, each with its own error counters */
  vdevs: ZfsVdev[];
  /** datasets of the pool */
  datasets: ZfsDataset[];
}

/** One vdev of a ZFS pool (mirror, raidz or a leaf disk) with its error counters. */
export interface ZfsVdev {
  /** vdev name as `zpool status` prints it (`mirror-0`, `sda`) */
  name: string;
  /** ONLINE | DEGRADED | FAULTED | … — same vocabulary as the pool health */
  state?: string;
  /** Read errors counted since the pool was last cleared */
  readErrors: number;
  /** Write errors counted since the pool was last cleared */
  writeErrors: number;
  /** Checksum errors counted since the pool was last cleared */
  checksumErrors: number;
}

/** One ZFS dataset with its usage. Bytes as the hub stores them. */
export interface ZfsDataset {
  /** Dataset name (`tank/media`) */
  name: string;
  /** Used bytes */
  used?: number;
  /** Available bytes */
  avail?: number;
  /** Mount point, absent for a dataset that is not mounted */
  mountpoint?: string;
}

/**
 * One row of the Hub's `smart_devices` collection. Verified against the bundled 0.20.0
 * schema (`internal/migrations/0_collections_snapshot_0_20_0.go`, unchanged since 0.19.0): `name`, `model`,
 * `state`, `capacity`, `temp`, `firmware`, `serial`, `type`, `hours`, `cycles`.
 * `attributes` (the raw SMART attribute table) is deliberately NOT read — it is a
 * vendor-specific blob whose keys differ per device, and an adapter cannot name
 * datapoints it cannot describe.
 */
export interface SmartDevice {
  /** PocketBase record ID */
  id: string;
  /** Reference to systems.id */
  system: string;
  /** Device node as smartctl names it (`/dev/sda`, `nvme0`) */
  name: string;
  /** PASSED | WARNING | FAILED | UNKNOWN — the overall SMART verdict */
  state?: string;
  /** Device model as smartctl reports it */
  model?: string;
  /** Serial number */
  serial?: string;
  /** Firmware revision */
  firmware?: string;
  /** Transport as smartctl reports it (`sat`, `nvme`, …) */
  type?: string;
  /** Device temperature in °C */
  temperature?: number;
  /** Capacity in bytes */
  capacity?: number;
  /** Power-on hours */
  hours?: number;
  /** Power cycle count */
  cycles?: number;
}

/**
 * One row of the Hub's `systemd_services` collection. The hub INSERTs all columns of a
 * batch in one statement (`internal/hub/systems/system.go` `createSystemdServiceRecords`,
 * 0.20.0), so a row never carries
 * a missing `state`/`cpu`/`memory`. Only the `list` rule is granted for this collection
 * — the adapter never fetches a single record, it pages the list like every other one.
 */
export interface SystemdService {
  /** PocketBase record ID */
  id: string;
  /** Reference to systems.id */
  system: string;
  /** Unit name, e.g. `ssh.service` */
  name: string;
  /** 0 active · 1 inactive · 2 failed · 3 activating · 4 deactivating · 5 reloading */
  state: number;
  /** 0 dead · 1 running · 2 exited · 3 failed · 4 unknown */
  sub: number;
  /** CPU usage in percent */
  cpu: number;
  /** Highest CPU usage in percent since the agent started watching the unit */
  cpuPeak: number;
  /** Resident memory in bytes */
  memory: number;
  /** Peak resident memory in bytes */
  memPeak: number;
}

/**
 * One row of the Hub's `network_monitors` collection (Beszel 0.20.0): a probe the agent
 * runs against a target — ICMP ping, TCP connect, HTTP request or DNS lookup. Read access
 * is `systemScopedReadRule` (list and view). The Hub rewrites the measured columns on every
 * agent update (`internal/hub/systems/system.go`); response times are in MICROSECONDS, the
 * loss is a percentage 0–100 (`internal/entities/monitor/monitor.go`).
 *
 * The record id is a hash of system + target + protocol (+ port for TCP): changing any of
 * them makes the Hub create a new record and delete the old one — there is no name field.
 */
export interface NetworkMonitor {
  /** PocketBase record ID */
  id: string;
  /** Reference to systems.id */
  system: string;
  /** Host, IP address or URL */
  target: string;
  /** icmp · tcp · http · dns */
  protocol: string;
  /** Port — only meaningful for TCP (0 otherwise) */
  port: number;
  /** Probe interval in seconds */
  interval: number;
  /** Mean response of the successful probes in the last window, µs (0 = no success) */
  res: number;
  /** Mean response over the last hour, µs */
  resAvg1h: number;
  /** Fastest response in the last hour, µs */
  resMin1h: number;
  /** Slowest response in the last hour, µs */
  resMax1h: number;
  /** Packet/probe loss over the last hour, % */
  loss1h: number;
  /** Whether the monitor is switched on (a disabled one keeps its last values) */
  enabled: boolean;
  /** When the Hub last wrote a measurement (epoch ms); absent = never */
  updated?: number;
}

/**
 * The newest 1-minute record of one monitor from `network_monitor_stats` (list rule only):
 * how many probes ran and succeeded. A 1m record is only written when a new probe came in,
 * so its age follows the monitor's interval (up to an hour).
 */
export interface MonitorProbeStat {
  /** Reference to network_monitors.id */
  monitor: string;
  /** Probes run in the minute */
  total: number;
  /** Probes that succeeded */
  success: number;
  /** When the record was written (epoch ms — the column is a number, not a date) */
  created: number;
}
