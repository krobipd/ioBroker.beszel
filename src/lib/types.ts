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
  /** GPU memory used GB */
  mu?: number;
  /** GPU memory total GB */
  mt?: number;
  /** GPU power W */
  p?: number;
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
}

/**
 * A system_stats record from /api/collections/system_stats/records
 */
export interface BeszelSystemStats {
  /** PocketBase record ID */
  id: string;
  /** Reference to systems.id */
  system: string;
  /** Stats type, e.g. "1m" */
  type: string;
  /** Metric values */
  stats: SystemStats;
  /** ISO timestamp of last update */
  updated: string;
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
}

/**
 * PocketBase list response
 */
export interface PocketBaseList<T> {
  /** Current page number */
  page: number;
  /** Items per page */
  perPage: number;
  /** Total number of items */
  totalItems: number;
  /** Total number of pages */
  totalPages: number;
  /** Records on this page */
  items: T[];
}

/**
 * PocketBase auth response
 */
export interface AuthResponse {
  /** Bearer token for subsequent requests */
  token: string;
  /** Authenticated user record */
  record: {
    /** User ID */
    id: string;
    /** User email */
    email: string;
    [key: string]: unknown;
  };
}
