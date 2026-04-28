import { expect } from "chai";
import { StateManager } from "./state-manager";
import type {
    AdapterConfig,
    BeszelSystem,
    BeszelContainer,
    SystemStats,
} from "./types";

// ---------------------------------------------------------------------------
// Mock adapter
// ---------------------------------------------------------------------------

interface ObjectDef {
    type: string;
    common: Record<string, unknown>;
    native: Record<string, unknown>;
}

interface StateValue {
    val: unknown;
    ack: boolean;
}

interface MockAdapter {
    namespace: string;
    objects: Map<string, ObjectDef>;
    states: Map<string, StateValue>;
    log: {
        debug: (msg: string) => void;
        info: (msg: string) => void;
        warn: (msg: string) => void;
        error: (msg: string) => void;
    };
    extendObjectAsync: (id: string, obj: Partial<ObjectDef>) => Promise<void>;
    setObjectNotExistsAsync: (id: string, obj: ObjectDef) => Promise<void>;
    setStateAsync: (id: string, state: StateValue) => Promise<void>;
    getObjectAsync: (id: string) => Promise<ObjectDef | null>;
    getObjectViewAsync: (
        design: string,
        search: string,
        params: { startkey: string; endkey: string },
    ) => Promise<{ rows: Array<{ id: string; value: ObjectDef }> } | null>;
    delObjectAsync: (id: string, opts?: { recursive: boolean }) => Promise<void>;
}

function createMockAdapter(): MockAdapter {
    const objects = new Map<string, ObjectDef>();
    const states = new Map<string, StateValue>();

    return {
        namespace: "beszel.0",
        objects,
        states,
        log: {
            debug: (): void => {},
            info: (): void => {},
            warn: (): void => {},
            error: (): void => {},
        },
        extendObjectAsync: async (id: string, obj: Partial<ObjectDef>): Promise<void> => {
            const existing = objects.get(id) || { type: "", common: {}, native: {} };
            objects.set(id, {
                type: obj.type || existing.type,
                common: { ...existing.common, ...(obj.common || {}) },
                native: { ...existing.native, ...(obj.native || {}) },
            });
        },
        setObjectNotExistsAsync: async (id: string, obj: ObjectDef): Promise<void> => {
            if (!objects.has(id)) {
                objects.set(id, obj);
            }
        },
        setStateAsync: async (id: string, state: StateValue): Promise<void> => {
            states.set(id, state);
        },
        getObjectAsync: async (id: string): Promise<ObjectDef | null> => {
            return objects.get(id) || null;
        },
        getObjectViewAsync: async (
            _design: string,
            _search: string,
            params: { startkey: string; endkey: string },
        ): Promise<{ rows: Array<{ id: string; value: ObjectDef }> }> => {
            const rows: Array<{ id: string; value: ObjectDef }> = [];
            const prefix = params.startkey.replace("beszel.0.", "");
            for (const [key, value] of objects.entries()) {
                if (key.startsWith(prefix) && value.type === "device") {
                    rows.push({ id: `beszel.0.${key}`, value });
                }
            }
            return { rows };
        },
        delObjectAsync: async (id: string, opts?: { recursive: boolean }): Promise<void> => {
            if (opts?.recursive) {
                for (const key of [...objects.keys()]) {
                    if (key === id || key.startsWith(`${id}.`)) {
                        objects.delete(key);
                    }
                }
                for (const key of [...states.keys()]) {
                    if (key === id || key.startsWith(`${id}.`)) {
                        states.delete(key);
                    }
                }
            } else {
                objects.delete(id);
                states.delete(id);
            }
        },
    };
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

function allMetricsConfig(overrides: Partial<AdapterConfig> = {}): AdapterConfig {
    return {
        url: "http://localhost:8090",
        username: "test",
        password: "test",
        pollInterval: 60,
        metrics_uptime: true,
        metrics_agentVersion: true,
        metrics_services: true,
        metrics_cpu: true,
        metrics_loadAvg: true,
        metrics_cpuBreakdown: true,
        metrics_memory: true,
        metrics_memoryDetails: true,
        metrics_swap: true,
        metrics_disk: true,
        metrics_diskSpeed: true,
        metrics_extraFs: true,
        metrics_network: true,
        metrics_temperature: true,
        metrics_temperatureDetails: true,
        metrics_gpu: true,
        metrics_containers: true,
        metrics_battery: true,
        ...overrides,
    };
}

function noMetricsConfig(): AdapterConfig {
    return {
        url: "http://localhost:8090",
        username: "test",
        password: "test",
        pollInterval: 60,
        metrics_uptime: false,
        metrics_agentVersion: false,
        metrics_services: false,
        metrics_cpu: false,
        metrics_loadAvg: false,
        metrics_cpuBreakdown: false,
        metrics_memory: false,
        metrics_memoryDetails: false,
        metrics_swap: false,
        metrics_disk: false,
        metrics_diskSpeed: false,
        metrics_extraFs: false,
        metrics_network: false,
        metrics_temperature: false,
        metrics_temperatureDetails: false,
        metrics_gpu: false,
        metrics_containers: false,
        metrics_battery: false,
    };
}

const testSystem: BeszelSystem = {
    id: "sys001",
    name: "My Server",
    status: "up",
    host: "192.168.1.10",
    info: {
        u: 86400,
        v: "0.8.0",
        sv: [10, 1],
        la: [1.5, 2.0, 2.5],
    },
};

const testStats: SystemStats = {
    cpu: 45.2,
    mu: 4.5,
    m: 16.0,
    mp: 28.1,
    mb: 2.3,
    mz: 0.5,
    su: 0.1,
    s: 4.0,
    du: 120,
    d: 500,
    dp: 24,
    dr: 50.5,
    dw: 20.3,
    ns: 1.2,
    nr: 3.4,
    t: { "Core 0": 65, "Core 1": 70, "Core 2": 60, "SSD": 45 },
    la: [1.8, 2.1, 2.3],
    g: {
        gpu0: { n: "NVIDIA RTX 4090", u: 80, mu: 8.5, mt: 24, p: 350 },
    },
    efs: {
        "/data": { d: 1000, du: 400, r: 100, w: 50 },
    },
    bat: [85, 1],
    cpub: [30, 10, 5, 2, 53],
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("StateManager", () => {
    let adapter: MockAdapter;
    let manager: StateManager;

    beforeEach(() => {
        adapter = createMockAdapter();
        manager = new StateManager(adapter as never);
    });

    // -----------------------------------------------------------------------
    // sanitize
    // -----------------------------------------------------------------------

    describe("sanitize", () => {
        it("should lowercase the input", () => {
            expect(manager.sanitize("MyServer")).to.equal("myserver");
        });

        it("should replace non-alphanumeric characters with underscore", () => {
            expect(manager.sanitize("my server!")).to.equal("my_server");
        });

        it("should collapse multiple non-alphanumeric to single underscore", () => {
            expect(manager.sanitize("my---server")).to.equal("my_server");
        });

        it("should trim leading and trailing underscores", () => {
            expect(manager.sanitize("---server---")).to.equal("server");
        });

        it("should truncate to 50 characters", () => {
            const longName = "a".repeat(60);
            expect(manager.sanitize(longName)).to.have.lengthOf(50);
        });

        it("should handle empty string", () => {
            expect(manager.sanitize("")).to.equal("");
        });

        it("should handle special characters", () => {
            expect(manager.sanitize("Server (Rack #2)")).to.equal("server_rack_2");
        });

        it("should handle already clean names", () => {
            expect(manager.sanitize("myserver01")).to.equal("myserver01");
        });

        it("should handle dots and slashes", () => {
            expect(manager.sanitize("host.example.com/vm1")).to.equal("host_example_com_vm1");
        });

        it("should handle unicode characters", () => {
            expect(manager.sanitize("Mein-Server-Ü")).to.equal("mein_server");
        });
    });

    // -----------------------------------------------------------------------
    // updateSystem — device and basic states
    // -----------------------------------------------------------------------

    describe("updateSystem — device and basic states", () => {
        it("should create a device object with system name", async () => {
            await manager.updateSystem(testSystem, undefined, [], allMetricsConfig());
            const obj = adapter.objects.get("systems.my_server");
            expect(obj).to.not.be.undefined;
            expect(obj!.type).to.equal("device");
            expect(obj!.common.name).to.equal("My Server");
        });

        it("should store system id and host in native", async () => {
            await manager.updateSystem(testSystem, undefined, [], allMetricsConfig());
            const obj = adapter.objects.get("systems.my_server");
            expect(obj!.native.id).to.equal("sys001");
            expect(obj!.native.host).to.equal("192.168.1.10");
        });

        it("should create online state as true when status is up", async () => {
            await manager.updateSystem(testSystem, undefined, [], allMetricsConfig());
            const state = adapter.states.get("systems.my_server.info.online");
            expect(state?.val).to.be.true;
            expect(state?.ack).to.be.true;
        });

        it("should create online state as false when status is down", async () => {
            const downSystem = { ...testSystem, status: "down" as const };
            await manager.updateSystem(downSystem, undefined, [], allMetricsConfig());
            const state = adapter.states.get("systems.my_server.info.online");
            expect(state?.val).to.be.false;
        });

        it("should set online false for paused status", async () => {
            const paused = { ...testSystem, status: "paused" as const };
            await manager.updateSystem(paused, undefined, [], allMetricsConfig());
            expect(adapter.states.get("systems.my_server.info.online")?.val).to.be.false;
        });

        it("should create status state", async () => {
            await manager.updateSystem(testSystem, undefined, [], allMetricsConfig());
            const state = adapter.states.get("systems.my_server.info.status");
            expect(state?.val).to.equal("up");
        });
    });

    // -----------------------------------------------------------------------
    // updateSystem — uptime metric
    // -----------------------------------------------------------------------

    describe("updateSystem — uptime", () => {
        it("should create uptime states when metrics_uptime is enabled", async () => {
            await manager.updateSystem(testSystem, undefined, [], allMetricsConfig());
            const uptime = adapter.states.get("systems.my_server.info.uptime");
            expect(uptime?.val).to.equal(86400);

            const uptimeText = adapter.states.get("systems.my_server.info.uptime_text");
            expect(uptimeText?.val).to.equal("1d");
        });

        it("should NOT create uptime states when metrics_uptime is disabled", async () => {
            await manager.updateSystem(testSystem, undefined, [], allMetricsConfig({ metrics_uptime: false }));
            expect(adapter.states.has("systems.my_server.info.uptime")).to.be.false;
            expect(adapter.states.has("systems.my_server.info.uptime_text")).to.be.false;
        });

        it("should handle missing uptime info gracefully", async () => {
            const sys = { ...testSystem, info: {} };
            await manager.updateSystem(sys, undefined, [], allMetricsConfig());
            expect(adapter.states.get("systems.my_server.info.uptime")?.val).to.be.null;
            expect(adapter.states.get("systems.my_server.info.uptime_text")?.val).to.be.null;
        });

        it("should format uptime with days, hours and minutes", async () => {
            // 2d 3h 45m = 2*86400 + 3*3600 + 45*60 = 186300
            const sys = { ...testSystem, info: { u: 186300 } };
            await manager.updateSystem(sys, undefined, [], allMetricsConfig());
            expect(adapter.states.get("systems.my_server.info.uptime_text")?.val).to.equal("2d 3h 45m");
        });

        it("should format short uptime correctly", async () => {
            const sys = { ...testSystem, info: { u: 300 } };
            await manager.updateSystem(sys, undefined, [], allMetricsConfig());
            expect(adapter.states.get("systems.my_server.info.uptime_text")?.val).to.equal("5m");
        });

        it("should format zero uptime as 0m", async () => {
            const sys = { ...testSystem, info: { u: 0 } };
            await manager.updateSystem(sys, undefined, [], allMetricsConfig());
            expect(adapter.states.get("systems.my_server.info.uptime_text")?.val).to.equal("0m");
        });

        it("should format uptime with only hours", async () => {
            // 2h = 7200s
            const sys = { ...testSystem, info: { u: 7200 } };
            await manager.updateSystem(sys, undefined, [], allMetricsConfig());
            expect(adapter.states.get("systems.my_server.info.uptime_text")?.val).to.equal("2h");
        });
    });

    // -----------------------------------------------------------------------
    // updateSystem — agent version
    // -----------------------------------------------------------------------

    describe("updateSystem — agent version", () => {
        it("should create agent_version state when enabled", async () => {
            await manager.updateSystem(testSystem, undefined, [], allMetricsConfig());
            expect(adapter.states.get("systems.my_server.info.agent_version")?.val).to.equal("0.8.0");
        });

        it("should NOT create agent_version state when disabled", async () => {
            await manager.updateSystem(testSystem, undefined, [], allMetricsConfig({ metrics_agentVersion: false }));
            expect(adapter.states.has("systems.my_server.info.agent_version")).to.be.false;
        });

        it("should handle missing agent version", async () => {
            const sys = { ...testSystem, info: {} };
            await manager.updateSystem(sys, undefined, [], allMetricsConfig());
            expect(adapter.states.get("systems.my_server.info.agent_version")?.val).to.be.null;
        });
    });

    // -----------------------------------------------------------------------
    // updateSystem — services
    // -----------------------------------------------------------------------

    describe("updateSystem — systemd services", () => {
        it("should create service states when enabled", async () => {
            await manager.updateSystem(testSystem, undefined, [], allMetricsConfig());
            expect(adapter.states.get("systems.my_server.info.services_total")?.val).to.equal(10);
            expect(adapter.states.get("systems.my_server.info.services_failed")?.val).to.equal(1);
        });

        it("should NOT create service states when disabled", async () => {
            await manager.updateSystem(testSystem, undefined, [], allMetricsConfig({ metrics_services: false }));
            expect(adapter.states.has("systems.my_server.info.services_total")).to.be.false;
            expect(adapter.states.has("systems.my_server.info.services_failed")).to.be.false;
        });

        it("should handle missing services info", async () => {
            const sys = { ...testSystem, info: {} };
            await manager.updateSystem(sys, undefined, [], allMetricsConfig());
            expect(adapter.states.get("systems.my_server.info.services_total")?.val).to.be.null;
            expect(adapter.states.get("systems.my_server.info.services_failed")?.val).to.be.null;
        });
    });

    // -----------------------------------------------------------------------
    // updateSystem — CPU stats
    // -----------------------------------------------------------------------

    describe("updateSystem — CPU stats", () => {
        it("should create cpu_usage when metrics_cpu is enabled and stats available", async () => {
            await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
            expect(adapter.states.get("systems.my_server.cpu.usage")?.val).to.equal(45.2);
        });

        it("should NOT create cpu_usage when disabled", async () => {
            await manager.updateSystem(testSystem, testStats, [], allMetricsConfig({ metrics_cpu: false }));
            expect(adapter.states.has("systems.my_server.cpu.usage")).to.be.false;
        });

        it("should NOT create cpu_usage without stats", async () => {
            await manager.updateSystem(testSystem, undefined, [], allMetricsConfig());
            expect(adapter.states.has("systems.my_server.cpu.usage")).to.be.false;
        });

        it("should set correct role and unit for cpu_usage", async () => {
            await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
            const obj = adapter.objects.get("systems.my_server.cpu.usage");
            expect(obj?.common.role).to.equal("value");
            expect(obj?.common.unit).to.equal("%");
        });
    });

    // -----------------------------------------------------------------------
    // updateSystem — CPU breakdown
    // -----------------------------------------------------------------------

    describe("updateSystem — CPU breakdown", () => {
        it("should create all CPU breakdown states", async () => {
            await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
            expect(adapter.states.get("systems.my_server.cpu.user")?.val).to.equal(30);
            expect(adapter.states.get("systems.my_server.cpu.system")?.val).to.equal(10);
            expect(adapter.states.get("systems.my_server.cpu.iowait")?.val).to.equal(5);
            expect(adapter.states.get("systems.my_server.cpu.steal")?.val).to.equal(2);
            expect(adapter.states.get("systems.my_server.cpu.idle")?.val).to.equal(53);
        });

        it("should NOT create CPU breakdown when disabled", async () => {
            await manager.updateSystem(testSystem, testStats, [], allMetricsConfig({ metrics_cpuBreakdown: false }));
            expect(adapter.states.has("systems.my_server.cpu.user")).to.be.false;
        });

        it("should skip CPU breakdown when cpub has fewer than 5 elements", async () => {
            const partialStats = { ...testStats, cpub: [10, 20] };
            await manager.updateSystem(testSystem, partialStats, [], allMetricsConfig());
            expect(adapter.states.has("systems.my_server.cpu.user")).to.be.false;
        });

        it("should skip CPU breakdown when cpub is undefined", async () => {
            const noBreakdown = { ...testStats, cpub: undefined };
            await manager.updateSystem(testSystem, noBreakdown, [], allMetricsConfig());
            expect(adapter.states.has("systems.my_server.cpu.user")).to.be.false;
        });
    });

    // -----------------------------------------------------------------------
    // updateSystem — load average
    // -----------------------------------------------------------------------

    describe("updateSystem — load average", () => {
        it("should use stats.la when available", async () => {
            await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
            expect(adapter.states.get("systems.my_server.cpu.load_1m")?.val).to.equal(1.8);
            expect(adapter.states.get("systems.my_server.cpu.load_5m")?.val).to.equal(2.1);
            expect(adapter.states.get("systems.my_server.cpu.load_15m")?.val).to.equal(2.3);
        });

        it("should fallback to system.info.la when stats have no la", async () => {
            const statsNoLa = { ...testStats, la: undefined };
            await manager.updateSystem(testSystem, statsNoLa, [], allMetricsConfig());
            // Falls back to system.info.la = [1.5, 2.0, 2.5]
            expect(adapter.states.get("systems.my_server.cpu.load_1m")?.val).to.equal(1.5);
            expect(adapter.states.get("systems.my_server.cpu.load_5m")?.val).to.equal(2.0);
            expect(adapter.states.get("systems.my_server.cpu.load_15m")?.val).to.equal(2.5);
        });

        it("should fallback to system.info.la when no stats at all", async () => {
            await manager.updateSystem(testSystem, undefined, [], allMetricsConfig());
            expect(adapter.states.get("systems.my_server.cpu.load_1m")?.val).to.equal(1.5);
        });

        it("should set null when no la data at all", async () => {
            const sysNoLa = { ...testSystem, info: {} };
            await manager.updateSystem(sysNoLa, undefined, [], allMetricsConfig());
            expect(adapter.states.get("systems.my_server.cpu.load_1m")?.val).to.be.null;
        });

        it("should NOT create load avg states when disabled", async () => {
            await manager.updateSystem(testSystem, testStats, [], allMetricsConfig({ metrics_loadAvg: false }));
            expect(adapter.states.has("systems.my_server.cpu.load_1m")).to.be.false;
        });
    });

    // -----------------------------------------------------------------------
    // updateSystem — memory
    // -----------------------------------------------------------------------

    describe("updateSystem — memory", () => {
        it("should create memory states when enabled", async () => {
            await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
            expect(adapter.states.get("systems.my_server.memory.percent")?.val).to.equal(28.1);
            expect(adapter.states.get("systems.my_server.memory.used")?.val).to.equal(4.5);
            expect(adapter.states.get("systems.my_server.memory.total")?.val).to.equal(16.0);
        });

        it("should NOT create memory states when disabled", async () => {
            await manager.updateSystem(testSystem, testStats, [], allMetricsConfig({ metrics_memory: false }));
            expect(adapter.states.has("systems.my_server.memory.percent")).to.be.false;
        });
    });

    // -----------------------------------------------------------------------
    // updateSystem — memory details
    // -----------------------------------------------------------------------

    describe("updateSystem — memory details", () => {
        it("should create buffers and ZFS ARC states", async () => {
            await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
            expect(adapter.states.get("systems.my_server.memory.buffers")?.val).to.equal(2.3);
            expect(adapter.states.get("systems.my_server.memory.zfs_arc")?.val).to.equal(0.5);
        });

        it("should NOT create memory detail states when disabled", async () => {
            await manager.updateSystem(testSystem, testStats, [], allMetricsConfig({ metrics_memoryDetails: false }));
            expect(adapter.states.has("systems.my_server.memory.buffers")).to.be.false;
            expect(adapter.states.has("systems.my_server.memory.zfs_arc")).to.be.false;
        });
    });

    // -----------------------------------------------------------------------
    // updateSystem — swap
    // -----------------------------------------------------------------------

    describe("updateSystem — swap", () => {
        it("should create swap states when enabled", async () => {
            await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
            expect(adapter.states.get("systems.my_server.memory.swap_used")?.val).to.equal(0.1);
            expect(adapter.states.get("systems.my_server.memory.swap_total")?.val).to.equal(4.0);
        });

        it("should NOT create swap states when disabled", async () => {
            await manager.updateSystem(testSystem, testStats, [], allMetricsConfig({ metrics_swap: false }));
            expect(adapter.states.has("systems.my_server.memory.swap_used")).to.be.false;
        });
    });

    // -----------------------------------------------------------------------
    // updateSystem — disk
    // -----------------------------------------------------------------------

    describe("updateSystem — disk", () => {
        it("should create disk states when enabled", async () => {
            await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
            expect(adapter.states.get("systems.my_server.disk.percent")?.val).to.equal(24);
            expect(adapter.states.get("systems.my_server.disk.used")?.val).to.equal(120);
            expect(adapter.states.get("systems.my_server.disk.total")?.val).to.equal(500);
        });

        it("should NOT create disk states when disabled", async () => {
            await manager.updateSystem(testSystem, testStats, [], allMetricsConfig({ metrics_disk: false }));
            expect(adapter.states.has("systems.my_server.disk.percent")).to.be.false;
        });

        it("should handle null disk values", async () => {
            const stats = { ...testStats, dp: undefined, du: undefined, d: undefined };
            await manager.updateSystem(testSystem, stats, [], allMetricsConfig());
            expect(adapter.states.get("systems.my_server.disk.percent")?.val).to.be.null;
            expect(adapter.states.get("systems.my_server.disk.used")?.val).to.be.null;
            expect(adapter.states.get("systems.my_server.disk.total")?.val).to.be.null;
        });
    });

    // -----------------------------------------------------------------------
    // updateSystem — disk speed
    // -----------------------------------------------------------------------

    describe("updateSystem — disk speed", () => {
        it("should create disk speed states when enabled", async () => {
            await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
            expect(adapter.states.get("systems.my_server.disk.read")?.val).to.equal(50.5);
            expect(adapter.states.get("systems.my_server.disk.write")?.val).to.equal(20.3);
        });

        it("should NOT create disk speed states when disabled", async () => {
            await manager.updateSystem(testSystem, testStats, [], allMetricsConfig({ metrics_diskSpeed: false }));
            expect(adapter.states.has("systems.my_server.disk.read")).to.be.false;
        });

        it("should set correct unit for disk speed", async () => {
            await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
            const obj = adapter.objects.get("systems.my_server.disk.read");
            expect(obj?.common.unit).to.equal("MB/s");
        });
    });

    // -----------------------------------------------------------------------
    // updateSystem — network
    // -----------------------------------------------------------------------

    describe("updateSystem — network", () => {
        it("should create network states when enabled", async () => {
            await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
            expect(adapter.states.get("systems.my_server.network.sent")?.val).to.equal(1.2);
            expect(adapter.states.get("systems.my_server.network.recv")?.val).to.equal(3.4);
        });

        it("should NOT create network states when disabled", async () => {
            await manager.updateSystem(testSystem, testStats, [], allMetricsConfig({ metrics_network: false }));
            expect(adapter.states.has("systems.my_server.network.sent")).to.be.false;
        });

        it("should set correct unit for network", async () => {
            await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
            const obj = adapter.objects.get("systems.my_server.network.sent");
            expect(obj?.common.unit).to.equal("MB/s");
        });
    });

    // -----------------------------------------------------------------------
    // updateSystem — temperature
    // -----------------------------------------------------------------------

    describe("updateSystem — temperature (avg top 3)", () => {
        it("should compute average of top 3 temperatures", async () => {
            // Temps: Core 0=65, Core 1=70, Core 2=60, SSD=45
            // Top 3: 70, 65, 60 → avg = 65.0
            await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
            expect(adapter.states.get("systems.my_server.temperature.average")?.val).to.equal(65);
        });

        it("should handle single sensor", async () => {
            const stats = { ...testStats, t: { "CPU": 72.5 } };
            await manager.updateSystem(testSystem, stats, [], allMetricsConfig());
            expect(adapter.states.get("systems.my_server.temperature.average")?.val).to.equal(72.5);
        });

        it("should handle two sensors", async () => {
            const stats = { ...testStats, t: { "A": 80, "B": 60 } };
            await manager.updateSystem(testSystem, stats, [], allMetricsConfig());
            // avg of top 2 (only 2 available): (80+60)/2 = 70
            expect(adapter.states.get("systems.my_server.temperature.average")?.val).to.equal(70);
        });

        it("should return null when no temperatures", async () => {
            const stats = { ...testStats, t: undefined };
            await manager.updateSystem(testSystem, stats, [], allMetricsConfig());
            expect(adapter.states.get("systems.my_server.temperature.average")?.val).to.be.null;
        });

        it("should return null when temperature map is empty", async () => {
            const stats = { ...testStats, t: {} };
            await manager.updateSystem(testSystem, stats, [], allMetricsConfig());
            expect(adapter.states.get("systems.my_server.temperature.average")?.val).to.be.null;
        });

        it("should NOT create temperature when disabled", async () => {
            await manager.updateSystem(testSystem, testStats, [], allMetricsConfig({ metrics_temperature: false }));
            expect(adapter.states.has("systems.my_server.temperature.average")).to.be.false;
        });

        it("should round to one decimal place", async () => {
            // Temps: 71, 72, 73 → avg = 72.0
            const stats = { ...testStats, t: { "A": 71, "B": 72, "C": 73 } };
            await manager.updateSystem(testSystem, stats, [], allMetricsConfig());
            expect(adapter.states.get("systems.my_server.temperature.average")?.val).to.equal(72);
        });

        it("should round fractional avg to one decimal", async () => {
            // Temps: 71, 72, 74 → avg = 72.333... → 72.3
            const stats = { ...testStats, t: { "A": 71, "B": 72, "C": 74 } };
            await manager.updateSystem(testSystem, stats, [], allMetricsConfig());
            expect(adapter.states.get("systems.my_server.temperature.average")?.val).to.equal(72.3);
        });

        it("should set correct role and unit", async () => {
            await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
            const obj = adapter.objects.get("systems.my_server.temperature.average");
            expect(obj?.common.role).to.equal("value.temperature");
            expect(obj?.common.unit).to.equal("\u00b0C");
        });
    });

    // -----------------------------------------------------------------------
    // updateSystem — temperature details
    // -----------------------------------------------------------------------

    describe("updateSystem — temperature details", () => {
        it("should create per-sensor states under temperatures channel", async () => {
            await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
            expect(adapter.objects.get("systems.my_server.temperature.sensors")?.type).to.equal("channel");
            expect(adapter.states.get("systems.my_server.temperature.sensors.core_0")?.val).to.equal(65);
            expect(adapter.states.get("systems.my_server.temperature.sensors.core_1")?.val).to.equal(70);
            expect(adapter.states.get("systems.my_server.temperature.sensors.core_2")?.val).to.equal(60);
            expect(adapter.states.get("systems.my_server.temperature.sensors.ssd")?.val).to.equal(45);
        });

        it("should NOT create temperature details when disabled", async () => {
            await manager.updateSystem(testSystem, testStats, [], allMetricsConfig({ metrics_temperatureDetails: false }));
            expect(adapter.objects.has("systems.my_server.temperature.sensors")).to.be.false;
        });
    });

    // -----------------------------------------------------------------------
    // updateSystem — battery
    // -----------------------------------------------------------------------

    describe("updateSystem — battery", () => {
        it("should create battery states from stats", async () => {
            await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
            expect(adapter.states.get("systems.my_server.battery.percent")?.val).to.equal(85);
            expect(adapter.states.get("systems.my_server.battery.charging")?.val).to.be.true;
        });

        it("should fallback to system.info.bat when stats have no bat", async () => {
            const sysWithBat = { ...testSystem, info: { ...testSystem.info, bat: [50, 0] as [number, number] } };
            const statsNoBat = { ...testStats, bat: undefined };
            await manager.updateSystem(sysWithBat, statsNoBat, [], allMetricsConfig());
            expect(adapter.states.get("systems.my_server.battery.percent")?.val).to.equal(50);
            expect(adapter.states.get("systems.my_server.battery.charging")?.val).to.be.false;
        });

        it("should handle no battery data", async () => {
            const sysNoBat = { ...testSystem, info: {} };
            const statsNoBat = { ...testStats, bat: undefined };
            await manager.updateSystem(sysNoBat, statsNoBat, [], allMetricsConfig());
            expect(adapter.states.get("systems.my_server.battery.percent")?.val).to.be.null;
            expect(adapter.states.get("systems.my_server.battery.charging")?.val).to.be.null;
        });

        it("should NOT create battery states when disabled", async () => {
            await manager.updateSystem(testSystem, testStats, [], allMetricsConfig({ metrics_battery: false }));
            expect(adapter.states.has("systems.my_server.battery.percent")).to.be.false;
        });
    });

    // -----------------------------------------------------------------------
    // updateSystem — GPU
    // -----------------------------------------------------------------------

    describe("updateSystem — GPU", () => {
        it("should create GPU channel and states", async () => {
            await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
            expect(adapter.objects.get("systems.my_server.gpu")?.type).to.equal("channel");
            expect(adapter.objects.get("systems.my_server.gpu.gpu0")?.type).to.equal("channel");
            expect(adapter.states.get("systems.my_server.gpu.gpu0.usage")?.val).to.equal(80);
            expect(adapter.states.get("systems.my_server.gpu.gpu0.memory_used")?.val).to.equal(8.5);
            expect(adapter.states.get("systems.my_server.gpu.gpu0.memory_total")?.val).to.equal(24);
            expect(adapter.states.get("systems.my_server.gpu.gpu0.power")?.val).to.equal(350);
        });

        it("should NOT create GPU states when disabled", async () => {
            await manager.updateSystem(testSystem, testStats, [], allMetricsConfig({ metrics_gpu: false }));
            expect(adapter.objects.has("systems.my_server.gpu")).to.be.false;
        });

        it("should skip GPU when stats have empty gpu map", async () => {
            const stats = { ...testStats, g: {} };
            await manager.updateSystem(testSystem, stats, [], allMetricsConfig());
            // Channel should not be created for empty map
            expect(adapter.states.has("systems.my_server.gpu.gpu0.usage")).to.be.false;
        });
    });

    // -----------------------------------------------------------------------
    // updateSystem — extra filesystems
    // -----------------------------------------------------------------------

    describe("updateSystem — extra filesystems", () => {
        it("should create filesystem channel and states", async () => {
            await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
            expect(adapter.objects.get("systems.my_server.filesystems")?.type).to.equal("channel");
            expect(adapter.objects.get("systems.my_server.filesystems.data")?.type).to.equal("channel");
            expect(adapter.states.get("systems.my_server.filesystems.data.disk_used")?.val).to.equal(400);
            expect(adapter.states.get("systems.my_server.filesystems.data.disk_total")?.val).to.equal(1000);
            // percent = 400/1000 * 100 = 40
            expect(adapter.states.get("systems.my_server.filesystems.data.disk_percent")?.val).to.equal(40);
            expect(adapter.states.get("systems.my_server.filesystems.data.read_speed")?.val).to.equal(100);
            expect(adapter.states.get("systems.my_server.filesystems.data.write_speed")?.val).to.equal(50);
        });

        it("should compute filesystem percent correctly", async () => {
            const stats = { ...testStats, efs: { "/boot": { d: 200, du: 50 } } };
            await manager.updateSystem(testSystem, stats, [], allMetricsConfig());
            // 50/200 = 25%
            expect(adapter.states.get("systems.my_server.filesystems.boot.disk_percent")?.val).to.equal(25);
        });

        it("should set null percent when total is zero", async () => {
            const stats = { ...testStats, efs: { "/zero": { d: 0, du: 0 } } };
            await manager.updateSystem(testSystem, stats, [], allMetricsConfig());
            expect(adapter.states.get("systems.my_server.filesystems.zero.disk_percent")?.val).to.be.null;
        });

        it("should NOT create filesystem states when disabled", async () => {
            await manager.updateSystem(testSystem, testStats, [], allMetricsConfig({ metrics_extraFs: false }));
            expect(adapter.objects.has("systems.my_server.filesystems")).to.be.false;
        });
    });

    // -----------------------------------------------------------------------
    // updateSystem — containers
    // -----------------------------------------------------------------------

    describe("updateSystem — containers", () => {
        const containers: BeszelContainer[] = [
            {
                id: "c001",
                system: "sys001",
                name: "nginx",
                status: "running",
                health: 2,
                cpu: 5.5,
                memory: 128,
                image: "nginx:latest",
            },
            {
                id: "c002",
                system: "sys001",
                name: "postgres",
                status: "running",
                health: 2,
                cpu: 12.3,
                memory: 512,
                image: "postgres:16",
            },
            {
                id: "c003",
                system: "other_system",
                name: "redis",
                status: "running",
                health: 2,
                cpu: 1.0,
                memory: 32,
                image: "redis:7",
            },
        ];

        it("should create container channel and states for matching system", async () => {
            await manager.updateSystem(testSystem, testStats, containers, allMetricsConfig());
            expect(adapter.objects.get("systems.my_server.containers")?.type).to.equal("channel");
            expect(adapter.objects.get("systems.my_server.containers.nginx")?.type).to.equal("channel");
            expect(adapter.states.get("systems.my_server.containers.nginx.status")?.val).to.equal("running");
            expect(adapter.states.get("systems.my_server.containers.nginx.health")?.val).to.equal("healthy");
            expect(adapter.states.get("systems.my_server.containers.nginx.cpu")?.val).to.equal(5.5);
            expect(adapter.states.get("systems.my_server.containers.nginx.memory")?.val).to.equal(128);
            expect(adapter.states.get("systems.my_server.containers.nginx.image")?.val).to.equal("nginx:latest");
        });

        it("should create states for postgres container too", async () => {
            await manager.updateSystem(testSystem, testStats, containers, allMetricsConfig());
            expect(adapter.states.get("systems.my_server.containers.postgres.cpu")?.val).to.equal(12.3);
            expect(adapter.states.get("systems.my_server.containers.postgres.memory")?.val).to.equal(512);
        });

        it("should NOT create states for containers belonging to other systems", async () => {
            await manager.updateSystem(testSystem, testStats, containers, allMetricsConfig());
            expect(adapter.states.has("systems.my_server.containers.redis")).to.be.false;
        });

        it("should NOT create container channel when disabled", async () => {
            await manager.updateSystem(testSystem, testStats, containers, allMetricsConfig({ metrics_containers: false }));
            expect(adapter.objects.has("systems.my_server.containers")).to.be.false;
        });

        it("should map health codes to labels", async () => {
            const healthTests: BeszelContainer[] = [
                { id: "h0", system: "sys001", name: "h_none", status: "exited", health: 0, cpu: 0, memory: 0, image: "test" },
                { id: "h1", system: "sys001", name: "h_starting", status: "running", health: 1, cpu: 0, memory: 0, image: "test" },
                { id: "h2", system: "sys001", name: "h_healthy", status: "running", health: 2, cpu: 0, memory: 0, image: "test" },
                { id: "h3", system: "sys001", name: "h_unhealthy", status: "running", health: 3, cpu: 0, memory: 0, image: "test" },
            ];
            await manager.updateSystem(testSystem, testStats, healthTests, allMetricsConfig());
            expect(adapter.states.get("systems.my_server.containers.h_none.health")?.val).to.equal("none");
            expect(adapter.states.get("systems.my_server.containers.h_starting.health")?.val).to.equal("starting");
            expect(adapter.states.get("systems.my_server.containers.h_healthy.health")?.val).to.equal("healthy");
            expect(adapter.states.get("systems.my_server.containers.h_unhealthy.health")?.val).to.equal("unhealthy");
        });

        it("should handle unknown health code", async () => {
            const unknownHealth: BeszelContainer[] = [
                { id: "h9", system: "sys001", name: "h_unknown", status: "running", health: 9, cpu: 0, memory: 0, image: "test" },
            ];
            await manager.updateSystem(testSystem, testStats, unknownHealth, allMetricsConfig());
            expect(adapter.states.get("systems.my_server.containers.h_unknown.health")?.val).to.equal("unknown");
        });

        it("should not create containers channel when system has no containers", async () => {
            await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
            // The containers channel should not be created if no containers match
            expect(adapter.states.has("systems.my_server.containers.nginx.status")).to.be.false;
        });
    });

    // -----------------------------------------------------------------------
    // updateSystem — no stats
    // -----------------------------------------------------------------------

    describe("updateSystem — without stats", () => {
        it("should still create online, status, uptime, agent_version, services", async () => {
            await manager.updateSystem(testSystem, undefined, [], allMetricsConfig());
            expect(adapter.states.get("systems.my_server.info.online")?.val).to.be.true;
            expect(adapter.states.get("systems.my_server.info.status")?.val).to.equal("up");
            expect(adapter.states.get("systems.my_server.info.uptime")?.val).to.equal(86400);
            expect(adapter.states.get("systems.my_server.info.agent_version")?.val).to.equal("0.8.0");
            expect(adapter.states.get("systems.my_server.info.services_total")?.val).to.equal(10);
        });

        it("should not create stats-based states without stats data", async () => {
            await manager.updateSystem(testSystem, undefined, [], allMetricsConfig());
            expect(adapter.states.has("systems.my_server.cpu.usage")).to.be.false;
            expect(adapter.states.has("systems.my_server.memory.percent")).to.be.false;
            expect(adapter.states.has("systems.my_server.disk.percent")).to.be.false;
            expect(adapter.states.has("systems.my_server.network.sent")).to.be.false;
        });
    });

    // -----------------------------------------------------------------------
    // updateSystem — all metrics disabled
    // -----------------------------------------------------------------------

    describe("updateSystem — all metrics disabled", () => {
        it("should still create online and status states", async () => {
            await manager.updateSystem(testSystem, testStats, [], noMetricsConfig());
            expect(adapter.states.has("systems.my_server.info.online")).to.be.true;
            expect(adapter.states.has("systems.my_server.info.status")).to.be.true;
        });

        it("should not create any metric states", async () => {
            await manager.updateSystem(testSystem, testStats, [], noMetricsConfig());
            expect(adapter.states.has("systems.my_server.info.uptime")).to.be.false;
            expect(adapter.states.has("systems.my_server.cpu.usage")).to.be.false;
            expect(adapter.states.has("systems.my_server.memory.percent")).to.be.false;
        });
    });

    // -----------------------------------------------------------------------
    // cleanupMetrics
    // -----------------------------------------------------------------------

    describe("cleanupMetrics", () => {
        it("should delete states for disabled metrics", async () => {
            // First, create all states
            await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
            expect(adapter.states.has("systems.my_server.cpu.usage")).to.be.true;
            expect(adapter.states.has("systems.my_server.info.uptime")).to.be.true;

            // Now cleanup with everything disabled
            await manager.cleanupMetrics("my_server", noMetricsConfig());

            expect(adapter.objects.has("systems.my_server.cpu.usage")).to.be.false;
            expect(adapter.objects.has("systems.my_server.info.uptime")).to.be.false;
            expect(adapter.objects.has("systems.my_server.info.uptime_text")).to.be.false;
            expect(adapter.objects.has("systems.my_server.info.agent_version")).to.be.false;
            expect(adapter.objects.has("systems.my_server.info.services_total")).to.be.false;
            expect(adapter.objects.has("systems.my_server.info.services_failed")).to.be.false;
            expect(adapter.objects.has("systems.my_server.memory.percent")).to.be.false;
            expect(adapter.objects.has("systems.my_server.memory.used")).to.be.false;
            expect(adapter.objects.has("systems.my_server.memory.total")).to.be.false;
            expect(adapter.objects.has("systems.my_server.memory.swap_used")).to.be.false;
            expect(adapter.objects.has("systems.my_server.memory.swap_total")).to.be.false;
            expect(adapter.objects.has("systems.my_server.disk.percent")).to.be.false;
            expect(adapter.objects.has("systems.my_server.disk.read")).to.be.false;
            expect(adapter.objects.has("systems.my_server.disk.write")).to.be.false;
            expect(adapter.objects.has("systems.my_server.network.sent")).to.be.false;
            expect(adapter.objects.has("systems.my_server.network.recv")).to.be.false;
            expect(adapter.objects.has("systems.my_server.temperature")).to.be.false;
            expect(adapter.objects.has("systems.my_server.battery.percent")).to.be.false;
            expect(adapter.objects.has("systems.my_server.battery.charging")).to.be.false;
        });

        it("should NOT delete states for enabled metrics", async () => {
            await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
            await manager.cleanupMetrics("my_server", allMetricsConfig());

            // All states should still exist
            expect(adapter.objects.has("systems.my_server.cpu.usage")).to.be.true;
            expect(adapter.objects.has("systems.my_server.info.uptime")).to.be.true;
        });

        it("should delete channel objects recursively for disabled channels", async () => {
            await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
            expect(adapter.objects.has("systems.my_server.temperature.sensors")).to.be.true;
            expect(adapter.objects.has("systems.my_server.gpu")).to.be.true;
            expect(adapter.objects.has("systems.my_server.filesystems")).to.be.true;

            await manager.cleanupMetrics("my_server", noMetricsConfig());

            expect(adapter.objects.has("systems.my_server.temperature.sensors")).to.be.false;
            expect(adapter.objects.has("systems.my_server.temperature.sensors.core_0")).to.be.false;
            expect(adapter.objects.has("systems.my_server.gpu")).to.be.false;
            expect(adapter.objects.has("systems.my_server.gpu.gpu0")).to.be.false;
            expect(adapter.objects.has("systems.my_server.filesystems")).to.be.false;
        });

        it("should handle cleanup when states do not exist", async () => {
            // Should not throw when cleaning up states that were never created
            await manager.cleanupMetrics("nonexistent_system", noMetricsConfig());
        });
    });

    // -----------------------------------------------------------------------
    // cleanupSystems
    // -----------------------------------------------------------------------

    describe("cleanupSystems", () => {
        it("should remove stale system devices", async () => {
            // Create two systems
            await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
            const sys2: BeszelSystem = {
                id: "sys002",
                name: "Old Server",
                status: "up",
                host: "192.168.1.20",
                info: {},
            };
            await manager.updateSystem(sys2, undefined, [], allMetricsConfig());

            expect(adapter.objects.has("systems.my_server")).to.be.true;
            expect(adapter.objects.has("systems.old_server")).to.be.true;

            // Only My Server is active
            await manager.cleanupSystems(["My Server"]);

            expect(adapter.objects.has("systems.my_server")).to.be.true;
            expect(adapter.objects.has("systems.old_server")).to.be.false;
        });

        it("should not remove any systems when all are active", async () => {
            await manager.updateSystem(testSystem, undefined, [], allMetricsConfig());
            await manager.cleanupSystems(["My Server"]);
            expect(adapter.objects.has("systems.my_server")).to.be.true;
        });

        it("should handle empty active list", async () => {
            await manager.updateSystem(testSystem, undefined, [], allMetricsConfig());
            await manager.cleanupSystems([]);
            expect(adapter.objects.has("systems.my_server")).to.be.false;
        });

        it("should recursively delete stale system and its children", async () => {
            await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
            expect(adapter.objects.has("systems.my_server.cpu.usage")).to.be.true;
            expect(adapter.states.has("systems.my_server.cpu.usage")).to.be.true;

            await manager.cleanupSystems([]);

            expect(adapter.objects.has("systems.my_server")).to.be.false;
            expect(adapter.objects.has("systems.my_server.cpu.usage")).to.be.false;
            expect(adapter.states.has("systems.my_server.cpu.usage")).to.be.false;
        });
    });

    // -----------------------------------------------------------------------
    // migrateLegacyStates
    // -----------------------------------------------------------------------

    describe("migrateLegacyStates", () => {
        it("should delete legacy flat state objects", async () => {
            // Simulate pre-0.3.0 flat states
            adapter.objects.set("systems.my_server", {
                type: "device",
                common: { name: "My Server" },
                native: {},
            });
            const legacyStates = [
                "online", "status", "uptime", "uptime_text",
                "cpu_usage", "load_avg_1m", "load_avg_5m", "load_avg_15m",
                "memory_percent", "memory_used", "memory_total",
                "disk_percent", "disk_used", "disk_total",
                "disk_read", "disk_write",
                "network_sent", "network_recv",
                "temperature",
            ];
            for (const s of legacyStates) {
                adapter.objects.set(`systems.my_server.${s}`, {
                    type: "state",
                    common: { name: s },
                    native: {},
                });
            }

            await manager.migrateLegacyStates();

            for (const s of legacyStates) {
                expect(adapter.objects.has(`systems.my_server.${s}`)).to.be.false;
            }
            // Device itself must survive
            expect(adapter.objects.has("systems.my_server")).to.be.true;
        });

        it("should delete legacy temperatures channel", async () => {
            adapter.objects.set("systems.my_server", {
                type: "device",
                common: { name: "My Server" },
                native: {},
            });
            adapter.objects.set("systems.my_server.temperatures", {
                type: "channel",
                common: { name: "Temperatures" },
                native: {},
            });
            adapter.objects.set("systems.my_server.temperatures.core_0", {
                type: "state",
                common: { name: "core_0" },
                native: {},
            });

            await manager.migrateLegacyStates();

            expect(adapter.objects.has("systems.my_server.temperatures")).to.be.false;
            expect(adapter.objects.has("systems.my_server.temperatures.core_0")).to.be.false;
        });

        it("should do nothing when no legacy states exist", async () => {
            // Create a system with new channel-based states
            await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
            const objectCountBefore = adapter.objects.size;

            await manager.migrateLegacyStates();

            expect(adapter.objects.size).to.equal(objectCountBefore);
        });

        it("should handle empty adapter with no systems", async () => {
            // No devices at all — should not throw
            await manager.migrateLegacyStates();
        });
    });

    // -----------------------------------------------------------------------
    // Multiple systems
    // -----------------------------------------------------------------------

    describe("multiple systems", () => {
        it("should create separate state trees for different systems", async () => {
            const sys2: BeszelSystem = {
                id: "sys002",
                name: "Web Server",
                status: "down",
                host: "192.168.1.20",
                info: { u: 3600, v: "0.7.0" },
            };

            await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
            await manager.updateSystem(sys2, undefined, [], allMetricsConfig());

            expect(adapter.states.get("systems.my_server.info.online")?.val).to.be.true;
            expect(adapter.states.get("systems.web_server.info.online")?.val).to.be.false;
            expect(adapter.states.get("systems.my_server.info.agent_version")?.val).to.equal("0.8.0");
            expect(adapter.states.get("systems.web_server.info.agent_version")?.val).to.equal("0.7.0");
        });
    });

    // -----------------------------------------------------------------------
    // Defensive boundary behavior
    // -----------------------------------------------------------------------

    describe("defensive boundaries", () => {
        it("sanitize returns empty string for non-string input", () => {
            // Using unknown cast to simulate runtime drift
            const mgr = manager as unknown as { sanitize(n: unknown): string };
            expect(mgr.sanitize(null)).to.equal("");
            expect(mgr.sanitize(undefined)).to.equal("");
            expect(mgr.sanitize(42)).to.equal("");
            expect(mgr.sanitize({})).to.equal("");
            expect(mgr.sanitize([])).to.equal("");
        });

        it("sanitize collapses all-non-alphanumeric names to empty", () => {
            expect(manager.sanitize("!!!")).to.equal("");
            expect(manager.sanitize("---")).to.equal("");
        });

        it("skips system with unusable sanitized name", async () => {
            const weirdSystem: BeszelSystem = {
                id: "sys001",
                name: "!!!",
                status: "up",
                host: "192.168.1.10",
                info: {},
            };
            await manager.updateSystem(weirdSystem, undefined, [], allMetricsConfig());
            // No state should be created under any "systems." prefix
            const systemStates = [...adapter.states.keys()].filter((k) =>
                k.startsWith("systems."),
            );
            expect(systemStates).to.have.lengthOf(0);
        });

        it("writes null to state when uptime is missing from info", async () => {
            const sys: BeszelSystem = {
                id: "sys001",
                name: "Server",
                status: "up",
                host: "10.0.0.1",
                info: {},
            };
            await manager.updateSystem(sys, undefined, [], allMetricsConfig());
            expect(adapter.states.get("systems.server.info.uptime")?.val).to.be.null;
            expect(adapter.states.get("systems.server.info.uptime_text")?.val).to.be.null;
        });

        it("writes null for missing stats fields rather than NaN", async () => {
            const emptyStats: SystemStats = {};
            await manager.updateSystem(testSystem, emptyStats, [], allMetricsConfig());
            // Core stats states should exist with null values — never NaN
            expect(adapter.states.get("systems.my_server.cpu.usage")?.val).to.be.null;
            expect(adapter.states.get("systems.my_server.memory.percent")?.val).to.be.null;
            expect(adapter.states.get("systems.my_server.memory.used")?.val).to.be.null;
            expect(adapter.states.get("systems.my_server.disk.percent")?.val).to.be.null;
            expect(adapter.states.get("systems.my_server.network.sent")?.val).to.be.null;
        });

        it("falls back to system.info.la when stats.la is missing", async () => {
            const statsNoLa: SystemStats = { cpu: 45 };
            const sys: BeszelSystem = {
                id: "s",
                name: "Fallback Server",
                status: "up",
                host: "h",
                info: { la: [0.1, 0.2, 0.3] },
            };
            await manager.updateSystem(sys, statsNoLa, [], allMetricsConfig());
            expect(adapter.states.get("systems.fallback_server.cpu.load_1m")?.val).to.equal(0.1);
            expect(adapter.states.get("systems.fallback_server.cpu.load_5m")?.val).to.equal(0.2);
        });

        it("writes null for load avg states when neither stats.la nor info.la exists", async () => {
            const sys: BeszelSystem = {
                id: "s",
                name: "No LA",
                status: "up",
                host: "h",
                info: {},
            };
            await manager.updateSystem(sys, { cpu: 10 }, [], allMetricsConfig());
            expect(adapter.states.get("systems.no_la.cpu.load_1m")?.val).to.be.null;
            expect(adapter.states.get("systems.no_la.cpu.load_5m")?.val).to.be.null;
            expect(adapter.states.get("systems.no_la.cpu.load_15m")?.val).to.be.null;
        });

        it("skips cpuBreakdown when cpub is shorter than 5 elements", async () => {
            const stats: SystemStats = { cpub: [10, 20] };
            await manager.updateSystem(testSystem, stats, [], allMetricsConfig());
            expect(adapter.states.get("systems.my_server.cpu.user")).to.be.undefined;
        });

        it("uses only valid temperature readings for top-3 average", async () => {
            const stats: SystemStats = { t: { a: 60, b: 70, c: 80, d: 50 } };
            await manager.updateSystem(testSystem, stats, [], allMetricsConfig());
            // Avg of top-3: (80 + 70 + 60) / 3 = 70.0
            expect(adapter.states.get("systems.my_server.temperature.average")?.val).to.equal(70);
        });

        it("writes null for temperature average when stats.t is missing", async () => {
            await manager.updateSystem(testSystem, { cpu: 10 }, [], allMetricsConfig());
            expect(adapter.states.get("systems.my_server.temperature.average")?.val).to.be.null;
        });

        it("computes derived filesystem percent even when parts are missing", async () => {
            const stats: SystemStats = {
                efs: {
                    "/data": { d: 1000 }, // total only, no used
                    "/logs": { d: 100, du: 25 }, // normal
                },
            };
            await manager.updateSystem(testSystem, stats, [], allMetricsConfig());
            expect(
                adapter.states.get("systems.my_server.filesystems.data.disk_percent")?.val,
            ).to.be.null;
            expect(
                adapter.states.get("systems.my_server.filesystems.logs.disk_percent")?.val,
            ).to.equal(25);
        });

        it("skips containers with unusable sanitized names", async () => {
            const badContainer: BeszelContainer = {
                id: "c1",
                system: "sys001",
                name: "!!!",
                status: "running",
                health: 2,
                cpu: 5,
                memory: 128,
                image: "nginx",
            };
            await manager.updateSystem(testSystem, undefined, [badContainer], allMetricsConfig());
            const containerStates = [...adapter.states.keys()].filter((k) =>
                k.includes(".containers."),
            );
            expect(containerStates).to.have.lengthOf(0);
        });

        it("uses 'unknown' label for container health value outside known range", async () => {
            const container: BeszelContainer = {
                id: "c1",
                system: "sys001",
                name: "app",
                status: "running",
                health: 99,
                cpu: 1,
                memory: 10,
                image: "img",
            };
            await manager.updateSystem(testSystem, undefined, [container], allMetricsConfig());
            expect(adapter.states.get("systems.my_server.containers.app.health")?.val).to.equal(
                "unknown",
            );
        });

        it("handles battery as [percent, chargeState] tuple correctly", async () => {
            const stats: SystemStats = { bat: [75, 1] };
            await manager.updateSystem(testSystem, stats, [], allMetricsConfig());
            expect(adapter.states.get("systems.my_server.battery.percent")?.val).to.equal(75);
            expect(adapter.states.get("systems.my_server.battery.charging")?.val).to.be.true;
        });

        it("reports battery not charging when chargeState is 0", async () => {
            const stats: SystemStats = { bat: [45, 0] };
            await manager.updateSystem(testSystem, stats, [], allMetricsConfig());
            expect(adapter.states.get("systems.my_server.battery.charging")?.val).to.be.false;
        });

        it("writes null for battery states when no battery info", async () => {
            const sys: BeszelSystem = {
                id: "s",
                name: "No Batt",
                status: "up",
                host: "h",
                info: {},
            };
            await manager.updateSystem(sys, { cpu: 10 }, [], allMetricsConfig());
            expect(adapter.states.get("systems.no_batt.battery.percent")?.val).to.be.null;
            expect(adapter.states.get("systems.no_batt.battery.charging")?.val).to.be.null;
        });

        it("does not create GPU channel when stats.g is empty", async () => {
            const stats: SystemStats = { cpu: 10, g: {} };
            await manager.updateSystem(testSystem, stats, [], allMetricsConfig());
            expect(adapter.objects.get("systems.my_server.gpu")).to.be.undefined;
        });

        it("does not create filesystems channel when stats.efs is empty", async () => {
            const stats: SystemStats = { cpu: 10, efs: {} };
            await manager.updateSystem(testSystem, stats, [], allMetricsConfig());
            expect(adapter.objects.get("systems.my_server.filesystems")).to.be.undefined;
        });

        it("only creates temperature sensors that exist", async () => {
            const stats: SystemStats = { t: { "Core 0": 45 } };
            await manager.updateSystem(testSystem, stats, [], allMetricsConfig());
            expect(
                adapter.states.get("systems.my_server.temperature.sensors.core_0"),
            ).to.not.be.undefined;
            expect(
                adapter.states.get("systems.my_server.temperature.sensors.gpu"),
            ).to.be.undefined;
        });
    });
});
