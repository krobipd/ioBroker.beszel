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

  // --- v0.6.0 additions (all default off — opt-in detail/peaks) ---
  /** Per-core CPU usage states */
  metrics_cpuCores?: boolean;
  /** Peak CPU usage state */
  metrics_cpuPeak?: boolean;
  /** Peak memory state */
  metrics_memoryPeak?: boolean;
  /** Disk I/O detail (bytes + utilization + wait times) */
  metrics_diskIo?: boolean;
  /** Peak disk read/write speed states */
  metrics_diskPeak?: boolean;
  /** Per-network-interface states */
  metrics_networkInterfaces?: boolean;
  /** Peak network sent/received states */
  metrics_networkPeak?: boolean;
  /** GPU detail states (package power + per-engine usage) */
  metrics_gpuDetails?: boolean;
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
}

/**
 * Static hardware / OS info for one system. Lives in the `system_details`
 * collection (Beszel v0.18.0+); the adapter fetches it only when the
 * "System info" metric is enabled, and rarely (once at start + when a new
 * system appears) because it changes only on agent restart/upgrade.
 *
 * Every field is optional — an older Beszel without the collection, or a
 * partially-populated agent, simply yields absent fields (→ no state created).
 * Column names verified against the v0.18.7 collection snapshot
 * (`Ressourcen/beszel/beszel-0.18.7/`) — note `os_name` is snake_case and
 * `os` is a numeric platform enum, not a string.
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
  /** read MB/s */
  r?: number;
  /** write MB/s */
  w?: number;
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
  /** Disk read MB/s */
  dr?: number;
  /** Disk write MB/s */
  dw?: number;
  /** Network sent MB/s */
  ns?: number;
  /** Network recv MB/s */
  nr?: number;
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
  /** Peak CPU usage % in the interval */
  cpum?: number;
  /** Peak RAM used GB */
  mm?: number;
  /** Peak disk read MB/s */
  drm?: number;
  /** Peak disk write MB/s */
  dwm?: number;
  /** Peak network sent MB/s */
  nsm?: number;
  /** Peak network received MB/s */
  nrm?: number;
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
}

// Note: `b`/`bm` (Bandwidth) and `dio`/`diom` (DiskIO) are deliberately NOT in
// this interface. Verified against agent/network.go:231 + agent/disk.go:638-641
// (Ressourcen/beszel/beszel-0.18.7): they are byte/s *rates*, identical to
// `ns`/`nr` and `dr`/`dw` in different units — redundant, so not surfaced.
// `diosm` (peak dios) has no consumer either. See VERIFIED-v0.18.7.md.

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
  /** running / exited / etc. */
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
}

/**
 * PocketBase list response — only the two fields the client actually reads.
 * `page`/`perPage`/`totalItems` are dropped from the raw body during coercion
 * (fetchAllPages drives pagination from `totalPages` alone).
 */
export interface PocketBaseList<T> {
  /** Total number of pages */
  totalPages: number;
  /** Records on this page */
  items: T[];
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
  | "RATE_LIMITED"
  | "HTTP_ERROR"
  | "INVALID_AUTH_RESPONSE"
  | "ETIMEDOUT";
