/**
 * Adapter configuration as stored in ioBroker native config
 */
export interface AdapterConfig {
    url: string;
    username: string;
    password: string;
    pollInterval: number;
    metrics_uptime: boolean;
    metrics_agentVersion: boolean;
    metrics_services: boolean;
    metrics_cpu: boolean;
    metrics_loadAvg: boolean;
    metrics_cpuBreakdown: boolean;
    metrics_memory: boolean;
    metrics_memoryDetails: boolean;
    metrics_swap: boolean;
    metrics_disk: boolean;
    metrics_diskSpeed: boolean;
    metrics_extraFs: boolean;
    metrics_network: boolean;
    metrics_temperature: boolean;
    metrics_temperatureDetails: boolean;
    metrics_gpu: boolean;
    metrics_containers: boolean;
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
    /** Connection type */
    ct?: number;
}
/**
 * A system record from /api/collections/systems/records
 */
export interface BeszelSystem {
    id: string;
    name: string;
    status: "up" | "down" | "paused" | "pending";
    host: string;
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
    /** Bandwidth bytes [sent, recv] */
    b?: [number, number];
}
/**
 * A system_stats record from /api/collections/system_stats/records
 */
export interface BeszelSystemStats {
    id: string;
    system: string;
    type: string;
    stats: SystemStats;
    updated: string;
}
/**
 * A container record from /api/collections/containers/records
 */
export interface BeszelContainer {
    id: string;
    system: string;
    name: string;
    status: string;
    health: number;
    cpu: number;
    memory: number;
    image: string;
}
/**
 * PocketBase list response
 */
export interface PocketBaseList<T> {
    page: number;
    perPage: number;
    totalItems: number;
    totalPages: number;
    items: T[];
}
/**
 * PocketBase auth response
 */
export interface AuthResponse {
    token: string;
    record: {
        id: string;
        email: string;
        [key: string]: unknown;
    };
}
//# sourceMappingURL=types.d.ts.map