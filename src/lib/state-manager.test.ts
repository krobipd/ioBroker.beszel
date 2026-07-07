import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@iobroker/adapter-core", () => ({
  I18n: {
    getTranslatedObject: vi.fn((key: string) => ({ en: key, de: `${key}_de` })),
  },
}));

import { StateManager } from "./state-manager";
import type { AdapterConfig, BeszelSystem, BeszelContainer, SystemStats } from "./types";

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
  setStateChangedAsync: (id: string, state: StateValue) => Promise<void>;
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
    setStateChangedAsync: async (id: string, state: StateValue): Promise<void> => {
      states.set(id, state);
    },
    getObjectAsync: async (id: string): Promise<ObjectDef | null> => {
      return objects.get(id) || null;
    },
    getObjectViewAsync: async (
      _design: string,
      search: string,
      params: { startkey: string; endkey: string },
    ): Promise<{ rows: Array<{ id: string; value: ObjectDef }> }> => {
      const rows: Array<{ id: string; value: ObjectDef }> = [];
      const prefix = params.startkey.replace("beszel.0.", "");
      // Faithfully filter by the requested object type (`search`): "device" for
      // getExistingSystemNames, "channel" for cleanupStaleContainers.
      for (const [key, value] of objects.entries()) {
        if (key.startsWith(prefix) && value.type === search) {
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
  t: { "Core 0": 65, "Core 1": 70, "Core 2": 60, SSD: 45 },
  la: [1.8, 2.1, 2.3],
  g: {
    gpu0: { n: "NVIDIA RTX 4090", u: 80, mu: 8.5, mt: 24, p: 350 },
  },
  efs: {
    "/data": { d: 1000, du: 400, r: 100, w: 50 },
  },
  bat: [85, 3], // 85 %, charge-state 3 = charging (agent/battery/battery.go enum)
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

  // SM5 v0.4.3 — name-collision disambiguation
  describe("sanitizeWithSuffix + prepareForPoll (SM5 v0.4.3)", () => {
    it("sanitizeWithSuffix appends a stable hash suffix", () => {
      const a = manager.sanitizeWithSuffix("Server A", "id001");
      const b = manager.sanitizeWithSuffix("Server A", "id002");
      // Both start with the same base name…
      expect(a.startsWith("server_a__")).to.equal(true);
      expect(b.startsWith("server_a__")).to.equal(true);
      // …but their suffix differs
      expect(a).to.not.equal(b);
      // …and the same input always yields the same suffix (stable across runs)
      expect(manager.sanitizeWithSuffix("Server A", "id001")).to.equal(a);
    });

    it("prepareForPoll keeps bare name for unique systems (back-compat)", () => {
      const sys1: BeszelSystem = { id: "alpha", name: "Server A", status: "up", host: "1.1.1.1", info: {} };
      const sys2: BeszelSystem = { id: "beta", name: "Server B", status: "up", host: "1.1.1.2", info: {} };
      manager.prepareForPoll([sys1, sys2]);
      const map = (manager as unknown as { resolvedSafeNames: Map<string, string> }).resolvedSafeNames;
      expect(map.get("alpha")).to.equal("server_a");
      expect(map.get("beta")).to.equal("server_b");
    });

    it("prepareForPoll suffixes the LATER (id-sorted) collider, keeps the FIRST bare", () => {
      const sysA: BeszelSystem = { id: "zid", name: "Server X", status: "up", host: "1.1.1.1", info: {} };
      const sysB: BeszelSystem = { id: "aid", name: "Server X", status: "up", host: "1.1.1.2", info: {} };
      manager.prepareForPoll([sysA, sysB]);
      const map = (manager as unknown as { resolvedSafeNames: Map<string, string> }).resolvedSafeNames;
      expect(map.get("aid")).to.equal("server_x");
      expect(map.get("zid")).to.match(/^server_x__[0-9a-f]{6}$/);
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
      const stats = { ...testStats, t: { CPU: 72.5 } };
      await manager.updateSystem(testSystem, stats, [], allMetricsConfig());
      expect(adapter.states.get("systems.my_server.temperature.average")?.val).to.equal(72.5);
    });

    it("should handle two sensors", async () => {
      const stats = { ...testStats, t: { A: 80, B: 60 } };
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
      const stats = { ...testStats, t: { A: 71, B: 72, C: 73 } };
      await manager.updateSystem(testSystem, stats, [], allMetricsConfig());
      expect(adapter.states.get("systems.my_server.temperature.average")?.val).to.equal(72);
    });

    it("should round fractional avg to one decimal", async () => {
      // Temps: 71, 72, 74 → avg = 72.333... → 72.3
      const stats = { ...testStats, t: { A: 71, B: 72, C: 74 } };
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
    it("should create battery states from stats (state 3 = charging → true)", async () => {
      await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
      expect(adapter.states.get("systems.my_server.battery.percent")?.val).to.equal(85);
      expect(adapter.states.get("systems.my_server.battery.charging")?.val).to.be.true;
    });

    it("reports charging=false while discharging (state 4) — not just any non-zero state", async () => {
      const onBattery = { ...testStats, bat: [60, 4] as [number, number] };
      await manager.updateSystem(testSystem, onBattery, [], allMetricsConfig());
      expect(adapter.states.get("systems.my_server.battery.percent")?.val).to.equal(60);
      expect(adapter.states.get("systems.my_server.battery.charging")?.val).to.be.false;
    });

    it("reports charging=false when full (state 2)", async () => {
      const full = { ...testStats, bat: [100, 2] as [number, number] };
      await manager.updateSystem(testSystem, full, [], allMetricsConfig());
      expect(adapter.states.get("systems.my_server.battery.charging")?.val).to.be.false;
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

    it("labels GPU memory in MB (agent reports MB, not GB)", async () => {
      await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
      expect(adapter.objects.get("systems.my_server.gpu.gpu0.memory_used")?.common.unit).to.equal("MB");
      expect(adapter.objects.get("systems.my_server.gpu.gpu0.memory_total")?.common.unit).to.equal("MB");
      expect(adapter.objects.get("systems.my_server.gpu.gpu0.power")?.common.unit).to.equal("W");
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
  // v0.6.0 — peaks, disk-IO, per-core, per-interface, GPU details
  // -----------------------------------------------------------------------

  describe("updateSystem — v0.6.0 peaks + disk-IO scalars", () => {
    const statsV2: SystemStats = {
      ...testStats,
      cpum: 92.5,
      mm: 15.2,
      drm: 130,
      dwm: 90,
      nsm: 5.5,
      nrm: 6.6,
      dios: [10, 20, 35.5, 1.2, 2.4, 50],
    };
    const v2cfg = (extra: Partial<AdapterConfig> = {}): AdapterConfig =>
      allMetricsConfig({
        metrics_cpuPeak: true,
        metrics_memoryPeak: true,
        metrics_diskPeak: true,
        metrics_networkPeak: true,
        metrics_diskIo: true,
        ...extra,
      });

    it("creates peak states from the v0.18.7 peak fields", async () => {
      await manager.updateSystem(testSystem, statsV2, [], v2cfg());
      expect(adapter.states.get("systems.my_server.cpu.peak")?.val).to.equal(92.5);
      expect(adapter.states.get("systems.my_server.memory.peak")?.val).to.equal(15.2);
      expect(adapter.states.get("systems.my_server.disk.read_peak")?.val).to.equal(130);
      expect(adapter.states.get("systems.my_server.disk.write_peak")?.val).to.equal(90);
      expect(adapter.states.get("systems.my_server.network.sent_peak")?.val).to.equal(5.5);
      expect(adapter.states.get("systems.my_server.network.recv_peak")?.val).to.equal(6.6);
    });

    it("creates disk I/O load states from dios (utilization + wait times)", async () => {
      await manager.updateSystem(testSystem, statsV2, [], v2cfg());
      expect(adapter.states.get("systems.my_server.disk.io_util")?.val).to.equal(35.5);
      expect(adapter.states.get("systems.my_server.disk.io_await_read")?.val).to.equal(1.2);
      expect(adapter.states.get("systems.my_server.disk.io_await_write")?.val).to.equal(2.4);
    });

    it("does NOT create the redundant byte-rate states (b/dio are duplicates of sent/recv and read/write)", async () => {
      await manager.updateSystem(testSystem, statsV2, [], v2cfg());
      expect(adapter.states.has("systems.my_server.network.total_sent")).to.be.false;
      expect(adapter.states.has("systems.my_server.network.total_recv")).to.be.false;
      expect(adapter.states.has("systems.my_server.disk.io_read")).to.be.false;
      expect(adapter.states.has("systems.my_server.disk.io_write")).to.be.false;
    });

    it("does NOT create peak/io states when the toggles are off", async () => {
      await manager.updateSystem(testSystem, statsV2, [], allMetricsConfig());
      expect(adapter.states.has("systems.my_server.cpu.peak")).to.be.false;
      expect(adapter.states.has("systems.my_server.disk.io_util")).to.be.false;
    });

    it("does NOT create peak/io states on an older Beszel that omits the fields", async () => {
      // testStats has no cpum/mm/drm/dios → available() gate skips them
      await manager.updateSystem(testSystem, testStats, [], v2cfg());
      expect(adapter.states.has("systems.my_server.cpu.peak")).to.be.false;
      expect(adapter.states.has("systems.my_server.memory.peak")).to.be.false;
      expect(adapter.states.has("systems.my_server.disk.io_util")).to.be.false;
    });
  });

  // -----------------------------------------------------------------------
  // Metric dependency gating (category off → detail off) — v0.6.0
  // -----------------------------------------------------------------------

  describe("updateSystem — detail toggles inherit their category base", () => {
    const statsV2: SystemStats = { ...testStats, cpum: 92.5, mm: 15.2, dios: [10, 20, 35.5, 1.2, 2.4, 50] };

    it("does NOT create a peak state when its category base is off (cpu off, cpuPeak on)", async () => {
      await manager.updateSystem(
        testSystem,
        statsV2,
        [],
        allMetricsConfig({ metrics_cpu: false, metrics_cpuPeak: true }),
      );
      expect(adapter.states.has("systems.my_server.cpu.peak")).to.be.false;
    });

    it("does NOT create per-core states when cpu base is off", async () => {
      const stats = { ...statsV2, cpus: [10, 20] };
      await manager.updateSystem(
        testSystem,
        stats,
        [],
        allMetricsConfig({ metrics_cpu: false, metrics_cpuCores: true }),
      );
      expect(adapter.objects.has("systems.my_server.cpu.cores")).to.be.false;
    });

    it("does NOT create disk I/O states when disk base is off", async () => {
      await manager.updateSystem(
        testSystem,
        statsV2,
        [],
        allMetricsConfig({ metrics_disk: false, metrics_diskIo: true }),
      );
      expect(adapter.states.has("systems.my_server.disk.io_util")).to.be.false;
    });

    it("couples load average to the CPU base (cpu off → no load states)", async () => {
      await manager.updateSystem(
        testSystem,
        statsV2,
        [],
        allMetricsConfig({ metrics_cpu: false, metrics_loadAvg: true }),
      );
      expect(adapter.states.has("systems.my_server.cpu.load_1m")).to.be.false;
    });

    it("couples disk speed to the disk base (disk off → no read/write states)", async () => {
      await manager.updateSystem(
        testSystem,
        statsV2,
        [],
        allMetricsConfig({ metrics_disk: false, metrics_diskSpeed: true }),
      );
      expect(adapter.states.has("systems.my_server.disk.read")).to.be.false;
      expect(adapter.states.has("systems.my_server.disk.write")).to.be.false;
    });

    it("still creates the detail when the category base is on", async () => {
      await manager.updateSystem(
        testSystem,
        statsV2,
        [],
        allMetricsConfig({ metrics_cpu: true, metrics_cpuPeak: true }),
      );
      expect(adapter.states.get("systems.my_server.cpu.peak")?.val).to.equal(92.5);
    });

    it("cleanupMetrics prunes a detail state when its category base is off", async () => {
      // Create cpu.peak first (cpu on + cpuPeak on)
      await manager.updateSystem(testSystem, statsV2, [], allMetricsConfig({ metrics_cpuPeak: true }));
      expect(adapter.states.has("systems.my_server.cpu.peak")).to.be.true;
      // Now the user disables the whole CPU category but leaves cpuPeak checked
      await manager.cleanupMetrics("my_server", allMetricsConfig({ metrics_cpu: false, metrics_cpuPeak: true }));
      expect(adapter.states.has("systems.my_server.cpu.peak")).to.be.false;
    });
  });

  describe("updateSystem — per-core CPU (v0.6.0)", () => {
    it("creates one state per core under cpu.cores", async () => {
      const stats = { ...testStats, cpus: [12, 34, 56, 78] };
      await manager.updateSystem(testSystem, stats, [], allMetricsConfig({ metrics_cpuCores: true }));
      expect(adapter.objects.get("systems.my_server.cpu.cores")?.type).to.equal("channel");
      expect(adapter.states.get("systems.my_server.cpu.cores.core0")?.val).to.equal(12);
      expect(adapter.states.get("systems.my_server.cpu.cores.core3")?.val).to.equal(78);
    });

    it("does NOT create per-core states when disabled", async () => {
      const stats = { ...testStats, cpus: [12, 34] };
      await manager.updateSystem(testSystem, stats, [], allMetricsConfig());
      expect(adapter.objects.has("systems.my_server.cpu.cores")).to.be.false;
    });
  });

  describe("updateSystem — per-interface network (v0.6.0)", () => {
    it("creates up/down/total states per interface", async () => {
      const stats = { ...testStats, ni: { eth0: [10, 20, 1000, 2000] as [number, number, number, number] } };
      await manager.updateSystem(testSystem, stats, [], allMetricsConfig({ metrics_networkInterfaces: true }));
      expect(adapter.objects.get("systems.my_server.network.interfaces.eth0")?.type).to.equal("channel");
      expect(adapter.states.get("systems.my_server.network.interfaces.eth0.up")?.val).to.equal(10);
      expect(adapter.states.get("systems.my_server.network.interfaces.eth0.down")?.val).to.equal(20);
      expect(adapter.states.get("systems.my_server.network.interfaces.eth0.total_up")?.val).to.equal(1000);
      expect(adapter.states.get("systems.my_server.network.interfaces.eth0.total_down")?.val).to.equal(2000);
    });

    it("does NOT create interface states when disabled", async () => {
      const stats = { ...testStats, ni: { eth0: [10, 20, 1000, 2000] as [number, number, number, number] } };
      await manager.updateSystem(testSystem, stats, [], allMetricsConfig());
      expect(adapter.objects.has("systems.my_server.network.interfaces")).to.be.false;
    });
  });

  describe("updateSystem — GPU details (v0.6.0)", () => {
    it("creates package power + per-engine states when enabled", async () => {
      const stats = {
        ...testStats,
        g: { gpu0: { n: "Intel Arc", u: 30, pp: 18.5, e: { render: 40, video: 5 } } },
      };
      await manager.updateSystem(testSystem, stats, [], allMetricsConfig({ metrics_gpuDetails: true }));
      expect(adapter.states.get("systems.my_server.gpu.gpu0.power_package")?.val).to.equal(18.5);
      expect(adapter.objects.get("systems.my_server.gpu.gpu0.engines")?.type).to.equal("channel");
      expect(adapter.states.get("systems.my_server.gpu.gpu0.engines.render")?.val).to.equal(40);
      expect(adapter.states.get("systems.my_server.gpu.gpu0.engines.video")?.val).to.equal(5);
    });

    it("does NOT create GPU detail states when the detail toggle is off", async () => {
      const stats = {
        ...testStats,
        g: { gpu0: { n: "Intel Arc", u: 30, pp: 18.5, e: { render: 40 } } },
      };
      await manager.updateSystem(testSystem, stats, [], allMetricsConfig({ metrics_gpuDetails: false }));
      expect(adapter.states.has("systems.my_server.gpu.gpu0.power_package")).to.be.false;
      expect(adapter.objects.has("systems.my_server.gpu.gpu0.engines")).to.be.false;
    });
  });

  // -----------------------------------------------------------------------
  // updateSystem — temperature max (F7 v0.6.0)
  // -----------------------------------------------------------------------

  describe("updateSystem — temperature max (F7)", () => {
    it("creates the hottest-sensor state alongside the average", async () => {
      // testStats.t = Core0=65, Core1=70, Core2=60, SSD=45 → max 70
      await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
      expect(adapter.states.get("systems.my_server.temperature.max")?.val).to.equal(70);
    });

    it("rounds the max to one decimal", async () => {
      const stats = { ...testStats, t: { A: 71.25, B: 50 } };
      await manager.updateSystem(testSystem, stats, [], allMetricsConfig());
      expect(adapter.states.get("systems.my_server.temperature.max")?.val).to.equal(71.3);
    });

    it("is null when there are no temperatures", async () => {
      const stats = { ...testStats, t: {} };
      await manager.updateSystem(testSystem, stats, [], allMetricsConfig());
      expect(adapter.states.get("systems.my_server.temperature.max")?.val).to.be.null;
    });

    it("is gated on the temperature toggle", async () => {
      await manager.updateSystem(testSystem, testStats, [], allMetricsConfig({ metrics_temperature: false }));
      expect(adapter.states.has("systems.my_server.temperature.max")).to.be.false;
    });
  });

  // -----------------------------------------------------------------------
  // updateSystem — system info / hardware (F2 v0.6.0)
  // -----------------------------------------------------------------------

  describe("updateSystem — system info hardware (F2)", () => {
    const sysWithDetails: BeszelSystem = {
      ...testSystem,
      details: {
        hostname: "server-a",
        os: 1,
        os_name: "macOS 14.1",
        kernel: "23.1.0",
        cpu: "Apple M2",
        arch: "arm64",
        cores: 8,
        threads: 8,
        podman: false,
      },
    };

    it("creates hardware states from system.details when System info is enabled", async () => {
      await manager.updateSystem(sysWithDetails, undefined, [], allMetricsConfig());
      expect(adapter.states.get("systems.my_server.info.hostname")?.val).to.equal("server-a");
      expect(adapter.states.get("systems.my_server.info.os")?.val).to.equal("macOS"); // enum 1 → label
      expect(adapter.states.get("systems.my_server.info.os_name")?.val).to.equal("macOS 14.1");
      expect(adapter.states.get("systems.my_server.info.kernel")?.val).to.equal("23.1.0");
      expect(adapter.states.get("systems.my_server.info.cpu_model")?.val).to.equal("Apple M2");
      expect(adapter.states.get("systems.my_server.info.arch")?.val).to.equal("arm64");
      expect(adapter.states.get("systems.my_server.info.cores")?.val).to.equal(8);
      expect(adapter.states.get("systems.my_server.info.threads")?.val).to.equal(8);
      expect(adapter.states.get("systems.my_server.info.podman")?.val).to.equal(false);
    });

    it("maps the OS enum to a readable label", async () => {
      for (const [os, label] of [
        [0, "Linux"],
        [1, "macOS"],
        [2, "Windows"],
        [3, "FreeBSD"],
      ] as Array<[number, string]>) {
        const a = createMockAdapter();
        const m = new StateManager(a as never);
        const sys = { ...testSystem, details: { os } };
        await m.updateSystem(sys, undefined, [], allMetricsConfig());
        expect(a.states.get("systems.my_server.info.os")?.val).to.equal(label);
      }
    });

    it("creates NO hardware states when details are absent (older Beszel / not fetched)", async () => {
      await manager.updateSystem(testSystem, undefined, [], allMetricsConfig());
      expect(adapter.states.has("systems.my_server.info.hostname")).to.be.false;
      expect(adapter.states.has("systems.my_server.info.cpu_model")).to.be.false;
      // agent_version (from info.v, not details) is still created
      expect(adapter.states.get("systems.my_server.info.agent_version")?.val).to.equal("0.8.0");
    });

    it("creates only the fields present in details", async () => {
      const sys = { ...testSystem, details: { hostname: "partial", cores: 4 } };
      await manager.updateSystem(sys, undefined, [], allMetricsConfig());
      expect(adapter.states.get("systems.my_server.info.hostname")?.val).to.equal("partial");
      expect(adapter.states.get("systems.my_server.info.cores")?.val).to.equal(4);
      expect(adapter.states.has("systems.my_server.info.kernel")).to.be.false;
      expect(adapter.states.has("systems.my_server.info.arch")).to.be.false;
    });

    it("creates NO hardware states when System info is disabled", async () => {
      await manager.updateSystem(sysWithDetails, undefined, [], allMetricsConfig({ metrics_agentVersion: false }));
      expect(adapter.states.has("systems.my_server.info.hostname")).to.be.false;
      expect(adapter.states.has("systems.my_server.info.cpu_model")).to.be.false;
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

    it("F1: removes container channels that disappeared from the host", async () => {
      const two: BeszelContainer[] = [
        {
          id: "c1",
          system: testSystem.id,
          name: "nginx",
          status: "running",
          health: 2,
          cpu: 1,
          memory: 10,
          image: "nginx",
        },
        {
          id: "c2",
          system: testSystem.id,
          name: "postgres",
          status: "running",
          health: 2,
          cpu: 1,
          memory: 10,
          image: "pg",
        },
      ];
      await manager.updateSystem(testSystem, testStats, two, allMetricsConfig());
      expect(adapter.objects.has("systems.my_server.containers.nginx")).to.be.true;
      expect(adapter.objects.has("systems.my_server.containers.postgres")).to.be.true;

      // postgres is removed on the host → only nginx reported next poll
      await manager.updateSystem(testSystem, testStats, two.slice(0, 1), allMetricsConfig());
      expect(adapter.objects.has("systems.my_server.containers.nginx")).to.be.true;
      expect(adapter.objects.has("systems.my_server.containers.postgres")).to.be.false;
      expect(adapter.states.has("systems.my_server.containers.postgres.cpu")).to.be.false;
    });

    it("H2: removes container channels only after the system drops to zero for two consecutive polls", async () => {
      const one: BeszelContainer[] = [
        {
          id: "c1",
          system: testSystem.id,
          name: "nginx",
          status: "running",
          health: 2,
          cpu: 1,
          memory: 10,
          image: "nginx",
        },
      ];
      await manager.updateSystem(testSystem, testStats, one, allMetricsConfig());
      expect(adapter.objects.has("systems.my_server.containers.nginx")).to.be.true;

      // First empty poll → debounced: a single transient empty getContainers() must not wipe.
      await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
      expect(adapter.objects.has("systems.my_server.containers.nginx")).to.be.true;

      // Second consecutive empty poll → confirmed removal.
      await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
      expect(adapter.objects.has("systems.my_server.containers.nginx")).to.be.false;
    });

    it("should map health codes to labels", async () => {
      const healthTests: BeszelContainer[] = [
        { id: "h0", system: "sys001", name: "h_none", status: "exited", health: 0, cpu: 0, memory: 0, image: "test" },
        {
          id: "h1",
          system: "sys001",
          name: "h_starting",
          status: "running",
          health: 1,
          cpu: 0,
          memory: 0,
          image: "test",
        },
        {
          id: "h2",
          system: "sys001",
          name: "h_healthy",
          status: "running",
          health: 2,
          cpu: 0,
          memory: 0,
          image: "test",
        },
        {
          id: "h3",
          system: "sys001",
          name: "h_unhealthy",
          status: "running",
          health: 3,
          cpu: 0,
          memory: 0,
          image: "test",
        },
      ];
      await manager.updateSystem(testSystem, testStats, healthTests, allMetricsConfig());
      expect(adapter.states.get("systems.my_server.containers.h_none.health")?.val).to.equal("none");
      expect(adapter.states.get("systems.my_server.containers.h_starting.health")?.val).to.equal("starting");
      expect(adapter.states.get("systems.my_server.containers.h_healthy.health")?.val).to.equal("healthy");
      expect(adapter.states.get("systems.my_server.containers.h_unhealthy.health")?.val).to.equal("unhealthy");
    });

    it("should handle unknown health code", async () => {
      const unknownHealth: BeszelContainer[] = [
        {
          id: "h9",
          system: "sys001",
          name: "h_unknown",
          status: "running",
          health: 9,
          cpu: 0,
          memory: 0,
          image: "test",
        },
      ];
      await manager.updateSystem(testSystem, testStats, unknownHealth, allMetricsConfig());
      expect(adapter.states.get("systems.my_server.containers.h_unknown.health")?.val).to.equal("unknown");
    });

    it("should not create containers channel when system has no containers", async () => {
      await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
      // The containers channel should not be created if no containers match
      expect(adapter.states.has("systems.my_server.containers.nginx.status")).to.be.false;
    });

    it("v0.6.0: creates a network state when the container reports net (bytes/s)", async () => {
      const withNet: BeszelContainer[] = [
        {
          id: "c1",
          system: "sys001",
          name: "nginx",
          status: "running",
          health: 2,
          cpu: 1,
          memory: 10,
          image: "nginx",
          net: 123456,
        },
      ];
      await manager.updateSystem(testSystem, testStats, withNet, allMetricsConfig());
      expect(adapter.states.get("systems.my_server.containers.nginx.network")?.val).to.equal(123456);
      expect(adapter.objects.get("systems.my_server.containers.nginx.network")?.common.unit).to.equal("B/s");
    });

    it("v0.6.0: creates NO network state when the container omits net (older Hub)", async () => {
      const noNet: BeszelContainer[] = [
        { id: "c1", system: "sys001", name: "nginx", status: "running", health: 2, cpu: 1, memory: 10, image: "nginx" },
      ];
      await manager.updateSystem(testSystem, testStats, noNet, allMetricsConfig());
      expect(adapter.states.has("systems.my_server.containers.nginx.network")).to.be.false;
    });
  });

  // -----------------------------------------------------------------------
  // H2 — drop-to-zero prune debounce (dynamic groups)
  // -----------------------------------------------------------------------

  describe("updateSystem — H2 drop-to-zero prune debounce", () => {
    // On the wire the g/efs/t/ni maps are omitempty, so a vanished group arrives
    // as an absent key; an empty `{}` is equivalent for our guard (entries → []).
    it("H2: a GPU that drops to zero is kept for ONE poll, then pruned on the second empty", async () => {
      await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
      expect(adapter.objects.has("systems.my_server.gpu.gpu0")).to.be.true;

      // First empty poll → transient guard: a single glitch must NOT wipe the states.
      await manager.updateSystem(testSystem, { ...testStats, g: {} }, [], allMetricsConfig());
      expect(adapter.objects.has("systems.my_server.gpu.gpu0")).to.be.true;

      // Second consecutive empty poll → confirmed removal, pruned.
      await manager.updateSystem(testSystem, { ...testStats, g: {} }, [], allMetricsConfig());
      expect(adapter.objects.has("systems.my_server.gpu.gpu0")).to.be.false;
      // H2d: the now-empty parent `gpu` channel is removed too (no lingering empty folder).
      expect(adapter.objects.has("systems.my_server.gpu")).to.be.false;
    });

    it("H2: a transient empty GPU response recovers on the next poll without wiping states", async () => {
      await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
      // One empty poll (transient) …
      await manager.updateSystem(testSystem, { ...testStats, g: {} }, [], allMetricsConfig());
      // … then the GPU is back → never pruned, and the debounce counter resets.
      await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
      expect(adapter.objects.has("systems.my_server.gpu.gpu0")).to.be.true;
    });

    it("H2: an extra filesystem dropping to zero is pruned after two empty polls (not one)", async () => {
      const withFs: SystemStats = { ...testStats, efs: { "/mnt/backup": { d: 100, du: 80, r: 1, w: 2 } } };
      await manager.updateSystem(testSystem, withFs, [], allMetricsConfig());
      expect(adapter.objects.has("systems.my_server.filesystems.mnt_backup")).to.be.true;

      await manager.updateSystem(testSystem, { ...testStats, efs: {} }, [], allMetricsConfig());
      expect(adapter.objects.has("systems.my_server.filesystems.mnt_backup")).to.be.true; // debounced

      await manager.updateSystem(testSystem, { ...testStats, efs: {} }, [], allMetricsConfig());
      expect(adapter.objects.has("systems.my_server.filesystems.mnt_backup")).to.be.false; // pruned
    });

    it("H2b: a presence-gated scalar (disk I/O) that goes absent is reset to null, not frozen", async () => {
      const cfg = allMetricsConfig({ metrics_diskIo: true });
      await manager.updateSystem(testSystem, { ...testStats, dios: [10, 20, 35, 1, 2, 50] }, [], cfg);
      expect(adapter.states.get("systems.my_server.disk.io_util")?.val).to.equal(35);

      // Disk goes fully idle → `dios` is omitted on the wire (omitzero). The state
      // must reset to null, not keep showing the last busy value.
      await manager.updateSystem(testSystem, { ...testStats, dios: undefined }, [], cfg);
      expect(adapter.states.get("systems.my_server.disk.io_util")?.val).to.equal(null);
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
        "online",
        "status",
        "uptime",
        "uptime_text",
        "cpu_usage",
        "load_avg_1m",
        "load_avg_5m",
        "load_avg_15m",
        "memory_percent",
        "memory_used",
        "memory_total",
        "disk_percent",
        "disk_used",
        "disk_total",
        "disk_read",
        "disk_write",
        "network_sent",
        "network_recv",
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
      const systemStates = [...adapter.states.keys()].filter(k => k.startsWith("systems."));
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
      expect(adapter.states.get("systems.my_server.filesystems.data.disk_percent")?.val).to.be.null;
      expect(adapter.states.get("systems.my_server.filesystems.logs.disk_percent")?.val).to.equal(25);
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
      const containerStates = [...adapter.states.keys()].filter(k => k.includes(".containers."));
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
      expect(adapter.states.get("systems.my_server.containers.app.health")?.val).to.equal("unknown");
    });

    it("handles battery as [percent, chargeState] tuple correctly", async () => {
      const stats: SystemStats = { bat: [75, 3] }; // state 3 = charging
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
      expect(adapter.states.get("systems.my_server.temperature.sensors.core_0")).to.not.be.undefined;
      expect(adapter.states.get("systems.my_server.temperature.sensors.gpu")).to.be.undefined;
    });
  });

  // -----------------------------------------------------------------------
  // Multi-language: state and channel names use translation objects
  // -----------------------------------------------------------------------

  describe("translation objects (Multi-Language)", () => {
    it("info channel common.name is a translation object from I18n", async () => {
      await manager.updateSystem(testSystem, undefined, [], allMetricsConfig());
      const obj = adapter.objects.get("systems.my_server.info");
      const name = obj?.common.name as Record<string, string>;
      expect(name).to.be.an("object");
      expect(name.en).to.equal("channelInfo");
      expect(name.de).to.equal("channelInfo_de");
    });

    it("online state common.name is a translation object from I18n", async () => {
      await manager.updateSystem(testSystem, undefined, [], allMetricsConfig());
      const obj = adapter.objects.get("systems.my_server.info.online");
      const name = obj?.common.name as Record<string, string>;
      expect(name).to.be.an("object");
      expect(name.en).to.equal("online");
    });

    it("CPU channel + usage state common.name are translation objects from I18n", async () => {
      await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
      const ch = adapter.objects.get("systems.my_server.cpu");
      const st = adapter.objects.get("systems.my_server.cpu.usage");
      const chName = ch?.common.name as Record<string, string>;
      const stName = st?.common.name as Record<string, string>;
      expect(chName.en).to.equal("channelCpu");
      expect(stName.en).to.equal("cpuUsage");
    });

    it("state common.name has en and de keys from I18n mock", async () => {
      await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
      const obj = adapter.objects.get("systems.my_server.memory.percent");
      const name = obj?.common.name as Record<string, string>;
      expect(name).to.have.property("en");
      expect(name).to.have.property("de");
      expect(name.en).to.be.a("string").and.not.empty;
    });

    it("device common.name keeps the raw system name from the API", async () => {
      await manager.updateSystem(testSystem, undefined, [], allMetricsConfig());
      const dev = adapter.objects.get("systems.my_server");
      expect(dev?.common.name).to.equal("My Server");
    });

    it("temperature sensor child uses the raw vendor key (not translated)", async () => {
      const stats: SystemStats = { t: { "Core 0": 45 } };
      await manager.updateSystem(testSystem, stats, [], allMetricsConfig());
      const obj = adapter.objects.get("systems.my_server.temperature.sensors.core_0");
      // Sensor names are agent-defined, kept as plain string
      expect(obj?.common.name).to.equal("Core 0");
    });
  });

  // -----------------------------------------------------------------------
  // createdIds cache: avoid repeated setObjectNotExistsAsync per poll
  // -----------------------------------------------------------------------

  describe("createdIds cache", () => {
    it("does not call setObjectNotExistsAsync again on a second poll", async () => {
      let createCalls = 0;
      const original = adapter.setObjectNotExistsAsync;
      adapter.setObjectNotExistsAsync = async (id, obj): Promise<void> => {
        createCalls++;
        return original(id, obj);
      };

      await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
      const firstCalls = createCalls;
      expect(firstCalls).to.be.greaterThan(0);

      await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
      expect(createCalls).to.equal(firstCalls);
    });

    it("re-creates objects after cleanupSystems removes them", async () => {
      await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
      await manager.cleanupSystems([]); // remove my_server

      let createCalls = 0;
      const original = adapter.setObjectNotExistsAsync;
      adapter.setObjectNotExistsAsync = async (id, obj): Promise<void> => {
        createCalls++;
        return original(id, obj);
      };

      await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
      expect(createCalls).to.be.greaterThan(0);
    });

    it("re-creates objects after cleanupMetrics deletes them", async () => {
      await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
      // Disable cpu metrics → cleanupMetrics deletes systems.my_server.cpu.usage
      await manager.cleanupMetrics("my_server", allMetricsConfig({ metrics_cpu: false }));

      let createCalls = 0;
      const original = adapter.setObjectNotExistsAsync;
      adapter.setObjectNotExistsAsync = async (id, obj): Promise<void> => {
        createCalls++;
        return original(id, obj);
      };

      await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
      // cpu.usage was deleted from cache, so it gets re-created on next poll
      const recreated = [...adapter.objects.keys()].filter(k => k === "systems.my_server.cpu.usage");
      expect(recreated).to.have.lengthOf(1);
      expect(createCalls).to.be.greaterThan(0);
    });

    it("still updates state values on subsequent polls (cache only skips object creation)", async () => {
      await manager.updateSystem(testSystem, { cpu: 10 }, [], allMetricsConfig());
      expect(adapter.states.get("systems.my_server.cpu.usage")?.val).to.equal(10);

      await manager.updateSystem(testSystem, { cpu: 80 }, [], allMetricsConfig());
      expect(adapter.states.get("systems.my_server.cpu.usage")?.val).to.equal(80);
    });
  });

  // -----------------------------------------------------------------------
  // v0.7.2 — device-object write cache
  // -----------------------------------------------------------------------

  describe("device-object write cache (v0.7.2)", () => {
    it("writes the device object only once while id/host/name are unchanged", async () => {
      let extendCalls = 0;
      const origExtend = adapter.extendObjectAsync;
      adapter.extendObjectAsync = async (...args): Promise<void> => {
        extendCalls++;
        return origExtend(...args);
      };
      await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
      const afterFirst = extendCalls;
      await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
      expect(extendCalls).to.equal(afterFirst); // poll 2: no device re-write
    });

    it("re-writes the device object when host data changed on the Hub", async () => {
      await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
      const moved = { ...testSystem, host: "192.168.1.99" };
      let extendCalls = 0;
      const origExtend = adapter.extendObjectAsync;
      adapter.extendObjectAsync = async (...args): Promise<void> => {
        extendCalls++;
        return origExtend(...args);
      };
      await manager.updateSystem(moved, testStats, [], allMetricsConfig());
      expect(extendCalls).to.equal(1);
      expect(adapter.objects.get("systems.my_server")!.native.host).to.equal("192.168.1.99");
    });

    it("re-writes after the system was removed and re-added (cache follows lifecycle)", async () => {
      await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
      await manager.cleanupSystems([]); // removes systems.my_server
      let extendCalls = 0;
      const origExtend = adapter.extendObjectAsync;
      adapter.extendObjectAsync = async (...args): Promise<void> => {
        extendCalls++;
        return origExtend(...args);
      };
      await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
      expect(extendCalls).to.equal(1);
    });
  });

  // -----------------------------------------------------------------------
  // v0.7.2 — stale-pruning for dynamic groups (generalised F1)
  // -----------------------------------------------------------------------

  describe("dynamic-group pruning (v0.7.2)", () => {
    it("prunes a sensor state when the sensor disappears", async () => {
      await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
      expect(adapter.states.has("systems.my_server.temperature.sensors.ssd")).to.be.true;

      const withoutSsd = { ...testStats, t: { "Core 0": 65, "Core 1": 70, "Core 2": 60 } };
      await manager.updateSystem(testSystem, withoutSsd, [], allMetricsConfig());
      expect(adapter.objects.has("systems.my_server.temperature.sensors.ssd")).to.be.false;
      expect(adapter.states.has("systems.my_server.temperature.sensors.core_0")).to.be.true;
    });

    it("prunes a renamed network interface channel", async () => {
      const eth0 = { ...testStats, ni: { eth0: [1, 2, 3, 4] as [number, number, number, number] } };
      await manager.updateSystem(testSystem, eth0, [], allMetricsConfig({ metrics_networkInterfaces: true }));
      expect(adapter.objects.has("systems.my_server.network.interfaces.eth0")).to.be.true;

      const enp = { ...testStats, ni: { enp3s0: [1, 2, 3, 4] as [number, number, number, number] } };
      await manager.updateSystem(testSystem, enp, [], allMetricsConfig({ metrics_networkInterfaces: true }));
      expect(adapter.objects.has("systems.my_server.network.interfaces.eth0")).to.be.false;
      expect(adapter.states.has("systems.my_server.network.interfaces.eth0.up")).to.be.false;
      expect(adapter.objects.has("systems.my_server.network.interfaces.enp3s0")).to.be.true;
    });

    it("prunes a GPU channel when the GPU disappears from the host", async () => {
      await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
      expect(adapter.objects.has("systems.my_server.gpu.gpu0")).to.be.true;

      const otherGpu = { ...testStats, g: { gpu1: { n: "Other", u: 1 } } };
      await manager.updateSystem(testSystem, otherGpu, [], allMetricsConfig());
      expect(adapter.objects.has("systems.my_server.gpu.gpu0")).to.be.false;
      expect(adapter.states.has("systems.my_server.gpu.gpu0.usage")).to.be.false;
      expect(adapter.objects.has("systems.my_server.gpu.gpu1")).to.be.true;
    });

    it("prunes engine states the driver stopped reporting", async () => {
      const twoEngines = { ...testStats, g: { gpu0: { n: "Intel", pp: 10, e: { render: 40, video: 5 } } } };
      await manager.updateSystem(testSystem, twoEngines, [], allMetricsConfig({ metrics_gpuDetails: true }));
      expect(adapter.states.has("systems.my_server.gpu.gpu0.engines.video")).to.be.true;

      const oneEngine = { ...testStats, g: { gpu0: { n: "Intel", pp: 10, e: { render: 41 } } } };
      await manager.updateSystem(testSystem, oneEngine, [], allMetricsConfig({ metrics_gpuDetails: true }));
      expect(adapter.objects.has("systems.my_server.gpu.gpu0.engines.video")).to.be.false;
      expect(adapter.states.has("systems.my_server.gpu.gpu0.engines.render")).to.be.true;
    });

    it("prunes an unmounted extra filesystem channel", async () => {
      await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
      expect(adapter.objects.has("systems.my_server.filesystems.data")).to.be.true;

      const otherFs = { ...testStats, efs: { "/backup": { d: 10, du: 1 } } };
      await manager.updateSystem(testSystem, otherFs, [], allMetricsConfig());
      expect(adapter.objects.has("systems.my_server.filesystems.data")).to.be.false;
      expect(adapter.objects.has("systems.my_server.filesystems.backup")).to.be.true;
    });

    it("prunes core states beyond a shrunk core count", async () => {
      const fourCores = { ...testStats, cpus: [10, 20, 30, 40] };
      await manager.updateSystem(testSystem, fourCores, [], allMetricsConfig({ metrics_cpuCores: true }));
      expect(adapter.states.has("systems.my_server.cpu.cores.core3")).to.be.true;

      const twoCores = { ...testStats, cpus: [10, 20] };
      await manager.updateSystem(testSystem, twoCores, [], allMetricsConfig({ metrics_cpuCores: true }));
      expect(adapter.objects.has("systems.my_server.cpu.cores.core3")).to.be.false;
      expect(adapter.states.has("systems.my_server.cpu.cores.core1")).to.be.true;
    });

    it("reconciles zombies from a previous run on the first poll (view fallback)", async () => {
      // Simulate a leftover container channel from before this adapter start.
      adapter.objects.set("systems.my_server.containers.ghost", {
        type: "channel",
        common: { name: "ghost" },
        native: {},
      });
      adapter.objects.set("systems.my_server.containers.ghost.cpu", {
        type: "state",
        common: { name: "cpu" },
        native: {},
      });
      const live: BeszelContainer[] = [
        { id: "c1", system: testSystem.id, name: "nginx", status: "running", health: 2, cpu: 1, memory: 1, image: "n" },
      ];
      await manager.updateSystem(testSystem, testStats, live, allMetricsConfig());
      expect(adapter.objects.has("systems.my_server.containers.ghost")).to.be.false;
      expect(adapter.objects.has("systems.my_server.containers.ghost.cpu")).to.be.false;
      expect(adapter.objects.has("systems.my_server.containers.nginx")).to.be.true;
    });

    it("does not touch dynamic groups when the system has no stats (offline)", async () => {
      await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
      expect(adapter.states.has("systems.my_server.temperature.sensors.ssd")).to.be.true;
      await manager.updateSystem(testSystem, undefined, [], allMetricsConfig());
      expect(adapter.states.has("systems.my_server.temperature.sensors.ssd")).to.be.true;
    });
  });

  // -----------------------------------------------------------------------
  // v0.7.2 — gpuDetails-off start cleanup
  // -----------------------------------------------------------------------

  describe("cleanupMetrics — gpuDetails toggle (v0.7.2)", () => {
    it("prunes power_package + engines of every GPU when gpuDetails is turned off", async () => {
      const stats = { ...testStats, g: { gpu0: { n: "Intel", u: 30, pp: 18.5, e: { render: 40 } } } };
      await manager.updateSystem(testSystem, stats, [], allMetricsConfig({ metrics_gpuDetails: true }));
      expect(adapter.states.has("systems.my_server.gpu.gpu0.power_package")).to.be.true;
      expect(adapter.objects.has("systems.my_server.gpu.gpu0.engines")).to.be.true;

      await manager.cleanupMetrics("my_server", allMetricsConfig({ metrics_gpuDetails: false }));
      expect(adapter.objects.has("systems.my_server.gpu.gpu0.power_package")).to.be.false;
      expect(adapter.objects.has("systems.my_server.gpu.gpu0.engines")).to.be.false;
      // The GPU itself (category on) survives.
      expect(adapter.objects.has("systems.my_server.gpu.gpu0")).to.be.true;
      expect(adapter.states.has("systems.my_server.gpu.gpu0.usage")).to.be.true;
    });
  });

  // -----------------------------------------------------------------------
  // Invariant lock: METRIC_DEPENDENCIES ↔ admin/jsonConfig.json `disabled`
  // -----------------------------------------------------------------------

  describe("METRIC_DEPENDENCIES ↔ jsonConfig disabled invariant", () => {
    interface JsonConfigField {
      disabled?: string;
    }

    function collectFields(node: unknown, out: Map<string, JsonConfigField>): void {
      if (typeof node !== "object" || node === null) {
        return;
      }
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (key.startsWith("metrics_") && typeof value === "object" && value !== null) {
          out.set(key, value as JsonConfigField);
        }
        collectFields(value, out);
      }
    }

    const jsonConfig = JSON.parse(readFileSync(join(__dirname, "../../admin/jsonConfig.json"), "utf8")) as unknown;
    const fields = new Map<string, JsonConfigField>();
    collectFields(jsonConfig, fields);
    const deps = (StateManager as unknown as { METRIC_DEPENDENCIES: Record<string, string> }).METRIC_DEPENDENCIES;

    it("every dependency in code is greyed out in the admin UI (and on the right base)", () => {
      expect(Object.keys(deps).length).to.be.greaterThan(0);
      for (const [detail, base] of Object.entries(deps)) {
        const field = fields.get(detail);
        expect(field, `jsonConfig has no field for ${detail}`).to.not.be.undefined;
        expect(field!.disabled, `${detail} must grey out on !data.${base}`).to.equal(`!data.${base}`);
      }
    });

    it("every greyed-out admin field is enforced in the data logic too", () => {
      let checked = 0;
      for (const [name, field] of fields) {
        if (!field.disabled) {
          continue;
        }
        const m = /^!data\.(metrics_\w+)$/.exec(field.disabled);
        expect(m, `unexpected disabled expression on ${name}: ${field.disabled}`).to.not.be.null;
        expect(deps[name], `${name} is greyed out in admin but missing from METRIC_DEPENDENCIES`).to.equal(m![1]);
        checked++;
      }
      expect(checked).to.be.greaterThan(0);
    });
  });

  describe("preserve option", () => {
    it("extendObjectAsync passes preserve option for devices", async () => {
      const adapter = createMockAdapter();
      const calls: any[][] = [];
      const origExtend = adapter.extendObjectAsync;
      adapter.extendObjectAsync = async (...args: any[]): Promise<void> => {
        calls.push(args);
        return origExtend(args[0], args[1]);
      };
      const manager = new StateManager(adapter as any);
      manager.prepareForPoll([testSystem]);

      await manager.updateSystem(testSystem, { cpu: 50 }, [], allMetricsConfig());

      const deviceCall = calls.find(c => c[0] === "systems.my_server");
      expect(deviceCall).to.not.be.undefined;
      expect(deviceCall![2]).to.deep.equal({ preserve: { common: ["name"] } });
    });
  });

  // -----------------------------------------------------------------------
  // SEC-6 — dynamic-group id collision disambiguation
  // -----------------------------------------------------------------------

  describe("SEC-6: dynamic-group id collision", () => {
    it("disambiguates two members whose names sanitize to the same id (no overwrite)", async () => {
      const stats = { ...testStats, efs: { "/mnt/data": { d: 100, du: 10 }, "/mnt-data": { d: 200, du: 20 } } };
      await manager.updateSystem(testSystem, stats, [], allMetricsConfig());
      const prefix = "systems.my_server.filesystems.";
      const fsIds = new Set(
        [...adapter.objects.keys()].filter(k => k.startsWith(prefix)).map(k => k.slice(prefix.length).split(".")[0]),
      );
      // "/mnt/data" → "mnt_data" (first, bare); "/mnt-data" → "mnt_data__<hash>"
      expect(fsIds.has("mnt_data")).to.equal(true);
      expect([...fsIds].some(id => /^mnt_data__[0-9a-f]{6}$/.test(id))).to.equal(true);
      expect(fsIds.size).to.equal(2); // both members present — neither overwrote the other
    });
  });

  // -----------------------------------------------------------------------
  // SEC-5 — oversized member display name is capped (common.name)
  // -----------------------------------------------------------------------

  describe("SEC-5: oversized member display name", () => {
    it("caps a huge filesystem display name in common.name", async () => {
      const longName = `/${"a".repeat(5000)}`;
      const stats = { ...testStats, efs: { [longName]: { d: 100, du: 10 } } };
      await manager.updateSystem(testSystem, stats, [], allMetricsConfig());
      const safeId = manager.sanitize(longName);
      const obj = adapter.objects.get(`systems.my_server.filesystems.${safeId}`);
      const name = obj?.common.name as string;
      expect(name.length).to.be.lessThanOrEqual(201); // 200 + ellipsis, not 5001
    });
  });

  // -----------------------------------------------------------------------
  // H2 — container partial-shrink prunes immediately; only drop-to-zero debounces
  // -----------------------------------------------------------------------

  describe("H2: container partial-shrink prunes immediately (not debounced)", () => {
    const two: BeszelContainer[] = [
      { id: "c1", system: "sys001", name: "nginx", status: "running", health: 2, cpu: 1, memory: 1, image: "n" },
      { id: "c2", system: "sys001", name: "postgres", status: "running", health: 2, cpu: 1, memory: 1, image: "pg" },
    ];

    it("removes one container among others on the same poll (the debounce only guards drop-to-zero)", async () => {
      await manager.updateSystem(testSystem, testStats, two, allMetricsConfig());
      expect(adapter.objects.has("systems.my_server.containers.postgres")).to.be.true;

      // postgres gone but nginx remains → the group is non-empty → pruned at once.
      await manager.updateSystem(testSystem, testStats, two.slice(0, 1), allMetricsConfig());
      expect(adapter.objects.has("systems.my_server.containers.postgres")).to.be.false;
      expect(adapter.objects.has("systems.my_server.containers.nginx")).to.be.true;
    });
  });
});
