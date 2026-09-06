import { readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@iobroker/adapter-core", () => ({
  I18n: {
    getTranslatedObject: vi.fn((key: string) => ({ en: key, de: `${key}_de` })),
    // `common.states` labels go through the plain-string path, not the object one.
    translate: vi.fn((key: string) => key),
  },
}));

import {
  buildMetricDefs,
  bytesToGib,
  bytesToMib,
  containerHealthLabel,
  containerHealthStates,
  systemStatusStates,
  zfsHealthStates,
  CONTAINER_HEALTH_LABELS,
  CONTAINER_HEALTH_UNKNOWN,
  DYNAMIC_CHANNEL_TOGGLES,
  DYNAMIC_LEAF_PATTERNS,
  DYNAMIC_SUBCHANNEL_TOGGLES,
  LEAF_COMMONS,
  leafCommon,
  METRIC_DEPENDENCIES,
} from "./metric-registry";
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
  extendObject: (id: string, obj: Partial<ObjectDef>) => Promise<void>;
  setObjectNotExistsAsync: (id: string, obj: ObjectDef) => Promise<void>;
  setStateAsync: (id: string, state: StateValue) => Promise<void>;
  setStateChangedAsync: (id: string, state: StateValue) => Promise<void>;
  getObjectAsync: (id: string) => Promise<ObjectDef | null>;
  getStateAsync: (id: string) => Promise<StateValue | null>;
  getObjectViewAsync: (
    design: string,
    search: string,
    params: { startkey: string; endkey: string },
  ) => Promise<{ rows: Array<{ id: string; value: ObjectDef }> } | null>;
  getObjectListAsync: (params: {
    startkey: string;
    endkey: string;
  }) => Promise<{ rows: Array<{ id: string; value: ObjectDef }> } | null>;
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
    extendObject: (id: string, obj: Partial<ObjectDef>): Promise<void> => {
      const existing = objects.get(id) || { type: "", common: {}, native: {} };
      objects.set(id, {
        type: obj.type || existing.type,
        common: { ...existing.common, ...(obj.common || {}) },
        native: { ...existing.native, ...(obj.native || {}) },
      });
      return Promise.resolve();
    },
    setObjectNotExistsAsync: (id: string, obj: ObjectDef): Promise<void> => {
      if (!objects.has(id)) {
        objects.set(id, obj);
      }
      return Promise.resolve();
    },
    setStateAsync: (id: string, state: StateValue): Promise<void> => {
      states.set(id, state);
      return Promise.resolve();
    },
    setStateChangedAsync: (id: string, state: StateValue): Promise<void> => {
      states.set(id, state);
      return Promise.resolve();
    },
    getObjectAsync: (id: string): Promise<ObjectDef | null> => {
      return Promise.resolve(objects.get(id) || null);
    },
    getStateAsync: (id: string): Promise<StateValue | null> => {
      return Promise.resolve(states.get(id) ?? null);
    },
    getObjectViewAsync: (
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
      return Promise.resolve({ rows });
    },
    // Object LIST: every type in one call, unlike the per-type view above.
    getObjectListAsync: (params: {
      startkey: string;
      endkey: string;
    }): Promise<{ rows: Array<{ id: string; value: ObjectDef }> }> => {
      const rows: Array<{ id: string; value: ObjectDef }> = [];
      const prefix = params.startkey.replace("beszel.0.", "");
      for (const [key, value] of objects.entries()) {
        if (key.startsWith(prefix)) {
          rows.push({ id: `beszel.0.${key}`, value });
        }
      }
      return Promise.resolve({ rows });
    },
    delObjectAsync: (id: string, opts?: { recursive: boolean }): Promise<void> => {
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
      return Promise.resolve();
    },
  };
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

/**
 * `sanitize` / `sanitizeWithSuffix` are internals of the manager (nothing outside the
 * class calls them). The tests still pin their behaviour, and reach them through this
 * single shim instead of widening the class's public surface for the test's sake.
 *
 * @param m The manager under test.
 */
function internals(m: StateManager): {
  sanitize(name: unknown): string;
  sanitizeWithSuffix(name: unknown, uniqueKey: string): string;
} {
  return m as unknown as {
    sanitize(name: unknown): string;
    sanitizeWithSuffix(name: unknown, uniqueKey: string): string;
  };
}

/**
 * Every metric toggle the adapter acts on, DERIVED from the registry and the two cleanup
 * tables instead of listed by hand. The hand-written list is what let `metrics_diskIo`
 * slip past the fixtures when it was added (2026-09-05): the helper simply did not know
 * the switch, so "all metrics on" quietly meant "all but that one".
 */
const ALL_TOGGLES: (keyof AdapterConfig)[] = [
  ...new Set<keyof AdapterConfig>([
    ...buildMetricDefs().map(d => d.toggle),
    ...(Object.keys(METRIC_DEPENDENCIES) as (keyof AdapterConfig)[]),
    ...Object.values(DYNAMIC_CHANNEL_TOGGLES).flat(),
    ...Object.values(DYNAMIC_SUBCHANNEL_TOGGLES),
  ]),
];

/**
 * Config with every metric toggle set to the same value.
 *
 * @param value What all toggles get.
 * @param overrides Individual toggles (or connection fields) to differ.
 */
function metricsConfig(value: boolean, overrides: Partial<AdapterConfig> = {}): AdapterConfig {
  const cfg: Record<string, unknown> = {
    url: "http://localhost:8090",
    username: "test",
    password: "test",
    pollInterval: 60,
  };
  for (const toggle of ALL_TOGGLES) {
    cfg[toggle] = value;
  }
  return { ...(cfg as unknown as AdapterConfig), ...overrides };
}

/**
 * @param overrides Toggles to differ from "everything on".
 */
function allMetricsConfig(overrides: Partial<AdapterConfig> = {}): AdapterConfig {
  return metricsConfig(true, overrides);
}

function noMetricsConfig(): AdapterConfig {
  return metricsConfig(false);
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

/** Every dynamic group populated at once — used by the refresh-table invariant test. */
function richStats(): SystemStats {
  return {
    ...testStats,
    cpus: [10, 20],
    ni: { eth0: [10, 20, 1000, 2000] as [number, number, number, number] },
    f: { cpu_fan: 950 },
    bats: { bat0: 88 },
    g: { gpu0: { n: "NVIDIA RTX 4090", u: 80, mu: 8.5, mt: 24, p: 350, pp: 380, e: { render: 40 } } },
  };
}

const testContainers: BeszelContainer[] = [
  {
    id: "c1",
    system: "sys001",
    name: "nginx",
    status: "running",
    health: 2,
    cpu: 1.5,
    memory: 128,
    image: "nginx:latest",
    net: 2048,
  },
];

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
      expect(internals(manager).sanitize("MyServer")).to.equal("myserver");
    });

    it("should replace non-alphanumeric characters with underscore", () => {
      expect(internals(manager).sanitize("my server!")).to.equal("my_server");
    });

    it("should collapse multiple non-alphanumeric to single underscore", () => {
      expect(internals(manager).sanitize("my---server")).to.equal("my_server");
    });

    it("should trim leading and trailing underscores", () => {
      expect(internals(manager).sanitize("---server---")).to.equal("server");
    });

    it("should truncate to 50 characters", () => {
      const longName = "a".repeat(60);
      expect(internals(manager).sanitize(longName)).to.have.lengthOf(50);
    });

    it("should handle empty string", () => {
      expect(internals(manager).sanitize("")).to.equal("");
    });

    it("should handle special characters", () => {
      expect(internals(manager).sanitize("Server (Rack #2)")).to.equal("server_rack_2");
    });

    it("should handle already clean names", () => {
      expect(internals(manager).sanitize("myserver01")).to.equal("myserver01");
    });

    it("should handle dots and slashes", () => {
      expect(internals(manager).sanitize("host.example.com/vm1")).to.equal("host_example_com_vm1");
    });

    it("should handle unicode characters", () => {
      expect(internals(manager).sanitize("Mein-Server-Ü")).to.equal("mein_server");
    });
  });

  // SM5 v0.4.3 — name-collision disambiguation
  describe("sanitizeWithSuffix + prepareForPoll (SM5 v0.4.3)", () => {
    it("sanitizeWithSuffix appends a stable hash suffix", () => {
      const a = internals(manager).sanitizeWithSuffix("Server A", "id001");
      const b = internals(manager).sanitizeWithSuffix("Server A", "id002");
      // Both start with the same base name…
      expect(a.startsWith("server_a__")).to.equal(true);
      expect(b.startsWith("server_a__")).to.equal(true);
      // …but their suffix differs
      expect(a).to.not.equal(b);
      // …and the same input always yields the same suffix (stable across runs)
      expect(internals(manager).sanitizeWithSuffix("Server A", "id001")).to.equal(a);
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

    it("sanitizeWithSuffix returns empty when the base name is unusable", () => {
      expect(internals(manager).sanitizeWithSuffix("!!!", "id001")).to.equal("");
      expect(internals(manager).sanitizeWithSuffix(42, "id001")).to.equal("");
    });

    it("prepareForPoll records an empty safeName for an unusable system name", () => {
      const bad: BeszelSystem = { id: "b1", name: "!!!", status: "up", host: "h", info: {} };
      const good: BeszelSystem = { id: "g1", name: "Server", status: "up", host: "h", info: {} };
      manager.prepareForPoll([bad, good]);
      const map = (manager as unknown as { resolvedSafeNames: Map<string, string> }).resolvedSafeNames;
      expect(map.get("b1")).to.equal("");
      expect(map.get("g1")).to.equal("server");
    });

    it("L5: warns once per collision base, not on every poll", () => {
      const warns: string[] = [];
      adapter.log.warn = (msg: string): void => {
        warns.push(msg);
      };
      const dupes: BeszelSystem[] = [
        { id: "aid", name: "Server X", status: "up", host: "1.1.1.1", info: {} },
        { id: "zid", name: "Server X", status: "up", host: "1.1.1.2", info: {} },
      ];
      manager.prepareForPoll(dupes);
      manager.prepareForPoll(dupes);
      manager.prepareForPoll(dupes);
      expect(warns.filter(w => w.includes("sanitize to 'server_x'"))).to.have.lengthOf(1);
    });

    it("cleanupSystems keeps a suffixed collision system alive", async () => {
      // The suffixed name is NOT `sanitize(system.name)`, so without the explicit
      // carry-over of resolvedSafeNames the second collider looks stale and its
      // whole device tree gets deleted every poll (audit 2026-08-22: unguarded).
      const a: BeszelSystem = { id: "aid", name: "Server X", status: "up", host: "1.1.1.1", info: {} };
      const b: BeszelSystem = { id: "zid", name: "Server X", status: "up", host: "1.1.1.2", info: {} };
      manager.prepareForPoll([a, b]);
      await manager.updateSystem(a, undefined, [], allMetricsConfig());
      await manager.updateSystem(b, undefined, [], allMetricsConfig());
      const suffixed = [...adapter.objects.keys()].find(k => /^systems\.server_x__[0-9a-f]{6}$/.test(k));
      expect(suffixed, "the suffixed collider device must exist").to.not.be.undefined;

      await manager.cleanupSystems([a.name, b.name]);

      expect(adapter.objects.has("systems.server_x")).to.be.true;
      expect(adapter.objects.has(suffixed!)).to.be.true;
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
      // US5: services are now available-gated — a system without `sv` creates no
      // (perpetually-null) service states at all.
      expect(adapter.states.has("systems.my_server.info.services_total")).to.be.false;
      expect(adapter.states.has("systems.my_server.info.services_failed")).to.be.false;
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

    it("should clamp an out-of-range percent to [0, 100] (INFO hardening)", async () => {
      await manager.updateSystem(testSystem, { ...testStats, cpu: 150 }, [], allMetricsConfig());
      expect(adapter.states.get("systems.my_server.cpu.usage")?.val).to.equal(100);
      await manager.updateSystem(testSystem, { ...testStats, cpu: -5 }, [], allMetricsConfig());
      expect(adapter.states.get("systems.my_server.cpu.usage")?.val).to.equal(0);
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
  // updateSystem — ZFS pools (v0.15.0, Beszel 0.19.0)
  describe("updateSystem — ZFS pools (v0.15.0, Beszel 0.19.0)", () => {
    // Shape as the Hub stores it (system_stats.stats.z, beszel v0.19.0 system.go ZfsPool):
    // GiB capacities, bytes/s throughput (omitzero → absent when idle), zpool health word.
    const zfsStats: SystemStats = {
      ...testStats,
      z: {
        tank: { d: 7452, du: 3100.25, rb: 5242880, wb: 1048576, h: "ONLINE" },
        "backup pool": { d: 1863, du: 1700, h: "DEGRADED" },
      },
    };

    it("creates one channel per pool with usage, throughput and health", async () => {
      await manager.updateSystem(testSystem, zfsStats, [], allMetricsConfig());
      expect(adapter.objects.get("systems.my_server.zfs")?.type).to.equal("channel");
      expect(adapter.objects.get("systems.my_server.zfs.tank")?.type).to.equal("channel");
      expect(adapter.states.get("systems.my_server.zfs.tank.disk_total")?.val).to.equal(7452);
      expect(adapter.states.get("systems.my_server.zfs.tank.disk_used")?.val).to.equal(3100.25);
      expect(adapter.states.get("systems.my_server.zfs.tank.disk_percent")?.val).to.equal(42);
      expect(adapter.states.get("systems.my_server.zfs.tank.read_speed")?.val).to.equal(5);
      expect(adapter.states.get("systems.my_server.zfs.tank.write_speed")?.val).to.equal(1);
      expect(adapter.states.get("systems.my_server.zfs.tank.health")?.val).to.equal("ONLINE");
      expect(adapter.objects.get("systems.my_server.zfs.tank.read_speed")?.common.unit).to.equal("MB/s");
      expect(adapter.objects.get("systems.my_server.zfs.tank.disk_total")?.common.unit).to.equal("GB");
    });

    it("keeps the pool name from zpool as the channel name and marks it API-named", async () => {
      await manager.updateSystem(testSystem, zfsStats, [], allMetricsConfig());
      const ch = adapter.objects.get("systems.my_server.zfs.backup_pool");
      expect(ch?.common.name).to.equal("backup pool");
      expect(ch?.native).to.deep.equal({ nameSource: "api" });
    });

    it("reads an idle pool as 0 MB/s (the Hub omits zero throughput) and passes DEGRADED through", async () => {
      await manager.updateSystem(testSystem, zfsStats, [], allMetricsConfig());
      expect(adapter.states.get("systems.my_server.zfs.backup_pool.read_speed")?.val).to.equal(0);
      expect(adapter.states.get("systems.my_server.zfs.backup_pool.write_speed")?.val).to.equal(0);
      expect(adapter.states.get("systems.my_server.zfs.backup_pool.health")?.val).to.equal("DEGRADED");
      expect(adapter.states.get("systems.my_server.zfs.backup_pool.disk_percent")?.val).to.equal(91);
    });

    it("gives the health state zpool's words as a states hint with role info.status", async () => {
      await manager.updateSystem(testSystem, zfsStats, [], allMetricsConfig());
      const common = adapter.objects.get("systems.my_server.zfs.tank.health")?.common;
      expect(common?.role).to.equal("info.status");
      expect(common?.type).to.equal("string");
      // v0.16.0: the LABEL is translated (the mock answers with the key); the KEY stays
      // zpool's own word, which is what the state carries.
      expect((common as { states?: Record<string, string> } | undefined)?.states?.DEGRADED).to.equal("zfsDegraded");
    });

    it("does not create the group when the toggle is off", async () => {
      await manager.updateSystem(testSystem, zfsStats, [], allMetricsConfig({ metrics_zfs: false }));
      expect(adapter.objects.has("systems.my_server.zfs")).to.be.false;
    });

    it("creates nothing on an older Beszel that never sends pools", async () => {
      await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
      expect(adapter.objects.has("systems.my_server.zfs")).to.be.false;
    });

    it("prunes a pool that disappeared while another remains", async () => {
      await manager.updateSystem(testSystem, zfsStats, [], allMetricsConfig());
      expect(adapter.objects.has("systems.my_server.zfs.backup_pool")).to.be.true;
      await manager.updateSystem(testSystem, { ...zfsStats, z: { tank: zfsStats.z!.tank } }, [], allMetricsConfig());
      expect(adapter.objects.has("systems.my_server.zfs.backup_pool")).to.be.false;
      expect(adapter.objects.has("systems.my_server.zfs.tank")).to.be.true;
    });
  });

  describe("updateSystem — Beszel 0.19.0 disk additions (v0.15.0)", () => {
    it("creates cumulative disk totals in GB from the device counters when the Hub sends them", async () => {
      await manager.updateSystem(
        testSystem,
        { ...testStats, diot: [53687091200, 10737418240] },
        [],
        allMetricsConfig({ metrics_diskIo: true }),
      );
      expect(adapter.states.get("systems.my_server.disk.total_read")?.val).to.equal(50);
      expect(adapter.states.get("systems.my_server.disk.total_write")?.val).to.equal(10);
      expect(adapter.objects.get("systems.my_server.disk.total_read")?.common.unit).to.equal("GB");
    });

    it("creates no totals on an older Beszel (field absent)", async () => {
      await manager.updateSystem(testSystem, testStats, [], allMetricsConfig({ metrics_diskIo: true }));
      expect(adapter.states.has("systems.my_server.disk.total_read")).to.be.false;
      expect(adapter.states.has("systems.my_server.disk.total_write")).to.be.false;
    });

    it("adds per-filesystem totals only when the Hub sends the counters", async () => {
      const efs = { data: { d: 100, du: 50, r: 1, w: 2, tr: 3221225472, tw: 1073741824 } };
      await manager.updateSystem(testSystem, { ...testStats, efs }, [], allMetricsConfig());
      expect(adapter.states.get("systems.my_server.filesystems.data.total_read")?.val).to.equal(3);
      expect(adapter.states.get("systems.my_server.filesystems.data.total_write")?.val).to.equal(1);
      const older = { old: { d: 100, du: 50, r: 1, w: 2 } };
      await manager.updateSystem(testSystem, { ...testStats, efs: older }, [], allMetricsConfig());
      expect(adapter.states.has("systems.my_server.filesystems.old.total_read")).to.be.false;
    });

    it("shows the root disk's custom name when the agent reports one", async () => {
      const system = { ...testSystem, info: { ...testSystem.info, rdn: "nvme0n1" } };
      await manager.updateSystem(system, testStats, [], allMetricsConfig());
      expect(adapter.states.get("systems.my_server.disk.name")?.val).to.equal("nvme0n1");
      expect(adapter.objects.get("systems.my_server.disk.name")?.common.role).to.equal("text");
    });

    it("creates no name state when the agent has no custom root disk name", async () => {
      await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
      expect(adapter.states.has("systems.my_server.disk.name")).to.be.false;
    });
  });

  // updateSystem — fan speeds (v0.11.0, Beszel 0.18.8)
  // -----------------------------------------------------------------------

  describe("updateSystem — fan speeds (v0.11.0)", () => {
    // Keys as the agent builds them: `<chip>_<label-or-fanN>`, label may contain
    // spaces (beszel v0.18.8 agent/fans.go discoverHwmonFans).
    const fanStats: SystemStats = {
      ...testStats,
      f: { "nct6798_CPU Fan": 1250, nct6798_fan2: 800, coretemp_pump: 2100 },
    };

    it("creates a fans channel with one state per fan, in rpm", async () => {
      await manager.updateSystem(testSystem, fanStats, [], allMetricsConfig());
      expect(adapter.objects.get("systems.my_server.fans")?.type).to.equal("channel");
      expect(adapter.states.get("systems.my_server.fans.nct6798_cpu_fan")?.val).to.equal(1250);
      expect(adapter.states.get("systems.my_server.fans.nct6798_fan2")?.val).to.equal(800);
      expect(adapter.states.get("systems.my_server.fans.coretemp_pump")?.val).to.equal(2100);
      const common = adapter.objects.get("systems.my_server.fans.nct6798_cpu_fan")?.common;
      expect(common?.unit).to.equal("rpm");
      expect(common?.type).to.equal("number");
      expect(common?.write).to.be.false;
    });

    it("keeps the agent's fan label as the display name", async () => {
      await manager.updateSystem(testSystem, fanStats, [], allMetricsConfig());
      expect(adapter.objects.get("systems.my_server.fans.nct6798_cpu_fan")?.common.name).to.equal("nct6798_CPU Fan");
    });

    it("keeps a 0 rpm reading — a stopped fan is data, not a missing value", async () => {
      await manager.updateSystem(testSystem, { ...testStats, f: { case_fan: 0 } }, [], allMetricsConfig());
      expect(adapter.states.get("systems.my_server.fans.case_fan")?.val).to.equal(0);
    });

    it("does not create fan states when the toggle is off", async () => {
      await manager.updateSystem(testSystem, fanStats, [], allMetricsConfig({ metrics_fans: false }));
      expect(adapter.objects.has("systems.my_server.fans")).to.be.false;
    });

    it("creates nothing on an older Beszel that never sends the field", async () => {
      await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
      expect(adapter.objects.has("systems.my_server.fans")).to.be.false;
    });

    it("prunes a fan that disappeared while others remain (no debounce needed)", async () => {
      await manager.updateSystem(testSystem, fanStats, [], allMetricsConfig());
      expect(adapter.states.has("systems.my_server.fans.coretemp_pump")).to.be.true;
      await manager.updateSystem(testSystem, { ...testStats, f: { "nct6798_CPU Fan": 1300 } }, [], allMetricsConfig());
      expect(adapter.states.has("systems.my_server.fans.coretemp_pump")).to.be.false;
      expect(adapter.states.get("systems.my_server.fans.nct6798_cpu_fan")?.val).to.equal(1300);
    });

    it("H2: all fans vanishing is debounced — pruned only on the second empty poll", async () => {
      await manager.updateSystem(testSystem, fanStats, [], allMetricsConfig());
      await manager.updateSystem(testSystem, { ...testStats, f: {} }, [], allMetricsConfig());
      expect(adapter.states.has("systems.my_server.fans.nct6798_cpu_fan")).to.be.true; // debounced
      await manager.updateSystem(testSystem, { ...testStats, f: {} }, [], allMetricsConfig());
      expect(adapter.states.has("systems.my_server.fans.nct6798_cpu_fan")).to.be.false; // pruned
      expect(adapter.objects.has("systems.my_server.fans")).to.be.false; // empty parent gone too
    });
  });

  // -----------------------------------------------------------------------
  // updateSystem — per-battery charge (v0.11.0, Beszel 0.18.8)
  // -----------------------------------------------------------------------

  describe("updateSystem — per-battery charge (v0.11.0)", () => {
    const multiBat: SystemStats = { ...testStats, bats: { BAT0: 85, BAT1: 42 } };

    it("creates one percent state per battery under the battery channel", async () => {
      await manager.updateSystem(testSystem, multiBat, [], allMetricsConfig());
      expect(adapter.objects.get("systems.my_server.battery.batteries")?.type).to.equal("channel");
      expect(adapter.states.get("systems.my_server.battery.batteries.bat0")?.val).to.equal(85);
      expect(adapter.states.get("systems.my_server.battery.batteries.bat1")?.val).to.equal(42);
      const common = adapter.objects.get("systems.my_server.battery.batteries.bat0")?.common;
      expect(common?.unit).to.equal("%");
      expect(common?.role).to.equal("value.battery");
    });

    it("keeps the aggregate battery states alongside the per-battery ones", async () => {
      await manager.updateSystem(testSystem, multiBat, [], allMetricsConfig());
      expect(adapter.states.get("systems.my_server.battery.percent")?.val).to.equal(85);
      expect(adapter.states.get("systems.my_server.battery.charging")?.val).to.be.true;
    });

    it("also creates the state for a SINGLE battery — no threshold that would delete it later", async () => {
      await manager.updateSystem(testSystem, { ...testStats, bats: { BAT0: 90 } }, [], allMetricsConfig());
      expect(adapter.states.get("systems.my_server.battery.batteries.bat0")?.val).to.equal(90);
    });

    it("does not create per-battery states when the battery toggle is off", async () => {
      await manager.updateSystem(testSystem, multiBat, [], allMetricsConfig({ metrics_battery: false }));
      expect(adapter.objects.has("systems.my_server.battery.batteries")).to.be.false;
    });

    it("creates nothing on an older Beszel that never sends the field", async () => {
      await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
      expect(adapter.objects.has("systems.my_server.battery.batteries")).to.be.false;
    });

    it("clamps an out-of-range percentage", async () => {
      await manager.updateSystem(testSystem, { ...testStats, bats: { BAT0: 140 } }, [], allMetricsConfig());
      expect(adapter.states.get("systems.my_server.battery.batteries.bat0")?.val).to.equal(100);
    });

    it("prunes a battery that was removed while another remains", async () => {
      await manager.updateSystem(testSystem, multiBat, [], allMetricsConfig());
      await manager.updateSystem(testSystem, { ...testStats, bats: { BAT0: 80 } }, [], allMetricsConfig());
      expect(adapter.states.has("systems.my_server.battery.batteries.bat1")).to.be.false;
      expect(adapter.states.get("systems.my_server.battery.batteries.bat0")?.val).to.equal(80);
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
    // (An empty gpu map is covered by "does not create GPU channel when stats.g
    // is empty" further down — that one also asserts the CHANNEL stays absent,
    // which this weaker state-only variant did not.)
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
      // v0.16.0: the toggles are named explicitly. They used to be MISSING from the
      // fixture helper, so this asserted nothing but "a switch the helper forgot creates
      // nothing" — three tests were passing on that accident.
      await manager.updateSystem(
        testSystem,
        statsV2,
        [],
        allMetricsConfig({
          metrics_cpuPeak: false,
          metrics_memoryPeak: false,
          metrics_diskPeak: false,
          metrics_networkPeak: false,
          metrics_diskIo: false,
        }),
      );
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
      await manager.updateSystem(testSystem, stats, [], allMetricsConfig({ metrics_cpuCores: false }));
      expect(adapter.objects.has("systems.my_server.cpu.cores")).to.be.false;
    });
  });

  describe("updateSystem — per-interface network (v0.6.0)", () => {
    it("creates up/down/total states per interface, normalized to MB/s + GB (US7)", async () => {
      // Raw bytes (ni = [4]uint64) → MiB/GiB: 10 MiB/s up, 5 MiB/s down, 2 GiB + 3 GiB totals.
      const stats = {
        ...testStats,
        ni: {
          eth0: [10 * 1024 * 1024, 5 * 1024 * 1024, 2 * 1024 ** 3, 3 * 1024 ** 3] as [number, number, number, number],
        },
      };
      await manager.updateSystem(testSystem, stats, [], allMetricsConfig({ metrics_networkInterfaces: true }));
      expect(adapter.objects.get("systems.my_server.network.interfaces.eth0")?.type).to.equal("channel");
      expect(adapter.states.get("systems.my_server.network.interfaces.eth0.up")?.val).to.equal(10);
      expect(adapter.states.get("systems.my_server.network.interfaces.eth0.down")?.val).to.equal(5);
      expect(adapter.states.get("systems.my_server.network.interfaces.eth0.total_up")?.val).to.equal(2);
      expect(adapter.states.get("systems.my_server.network.interfaces.eth0.total_down")?.val).to.equal(3);
      expect(adapter.objects.get("systems.my_server.network.interfaces.eth0.up")?.common.unit).to.equal("MB/s");
      expect(adapter.objects.get("systems.my_server.network.interfaces.eth0.total_up")?.common.unit).to.equal("GB");
    });

    it("does NOT create interface states when disabled", async () => {
      const stats = { ...testStats, ni: { eth0: [10, 20, 1000, 2000] as [number, number, number, number] } };
      await manager.updateSystem(testSystem, stats, [], allMetricsConfig({ metrics_networkInterfaces: false }));
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

    it("F1: a container fetch FAILURE (containersAvailable=false) never deletes existing states", async () => {
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
      // Containers fetched fine → nginx state exists.
      await manager.updateSystem(testSystem, testStats, one, allMetricsConfig());
      expect(adapter.objects.has("systems.my_server.containers.nginx")).to.be.true;

      // Two consecutive polls where the container fetch FAILED (e.g. persistent
      // 403): the poll passes containersAvailable=false + an empty list. Unlike a
      // genuine empty result (H2 above), a failure must NEVER prune — the states
      // freeze, not delete. This is the failure-vs-empty distinction (F1).
      await manager.updateSystem(testSystem, testStats, [], allMetricsConfig(), false);
      await manager.updateSystem(testSystem, testStats, [], allMetricsConfig(), false);
      expect(adapter.objects.has("systems.my_server.containers.nginx")).to.be.true;
      expect(adapter.states.get("systems.my_server.containers.nginx.status")?.val).to.equal("running");
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

    it("SM7: floors a fractional health value instead of yielding 'unknown'", async () => {
      // API drift could send 2.5; healthLabels[2.5] is undefined, so without the
      // floor a healthy container would report "unknown" (audit 2026-08-22 — the
      // floor was unguarded).
      const fractional: BeszelContainer[] = [
        { id: "f1", system: "sys001", name: "frac", status: "running", health: 2.5, cpu: 0, memory: 0, image: "t" },
      ];
      await manager.updateSystem(testSystem, testStats, fractional, allMetricsConfig());
      expect(adapter.states.get("systems.my_server.containers.frac.health")?.val).to.equal("healthy");
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

    it("a datapoint whose meaning is not obvious carries an explanation", async () => {
      // Fleet standard: `common.desc` is a readable sentence, and exactly for the
      // values a user cannot guess — the average is over the three HOTTEST sensors.
      await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
      expect(adapter.objects.get("systems.my_server.temperature.average")?.common.desc).to.deep.equal({
        en: "descTemperatureAvg",
        de: "descTemperatureAvg_de",
      });
    });

    it("a self-explanatory datapoint carries NO explanation", async () => {
      // The same standard: an invented sentence is worse than none.
      await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
      expect(adapter.objects.get("systems.my_server.memory.used")?.common.desc).to.be.undefined;
    });

    it("the per-core label is a translation object, not a hard-coded string", async () => {
      await manager.updateSystem(
        testSystem,
        { ...testStats, cpus: [10, 20] },
        [],
        allMetricsConfig({ metrics_cpuCores: true }),
      );
      expect(adapter.objects.get("systems.my_server.cpu.cores.core0")?.common.name).to.deep.equal({
        en: "cpuCore",
        de: "cpuCore_de",
      });
    });

    it("H2b survives a restart: a field that vanished is still reset to null", async () => {
      // The reset used to hang off `createdIds`, which is empty in a fresh process —
      // so after an adapter restart the state kept the last busy value forever
      // (v0.14.0). The startup snapshot is what makes it work across restarts.
      const cfg = allMetricsConfig({ metrics_diskIo: true });
      await manager.snapshotExistingStates();
      await manager.updateSystem(testSystem, { ...testStats, dios: [10, 20, 35, 1, 2, 50] }, [], cfg);
      expect(adapter.states.get("systems.my_server.disk.io_util")?.val).to.equal(35);

      // Restart: fresh manager over the same object store, `createdIds` empty.
      const fresh = new StateManager(adapter as never);
      await fresh.snapshotExistingStates();
      await fresh.updateSystem(testSystem, { ...testStats, dios: undefined }, [], cfg);

      expect(adapter.states.get("systems.my_server.disk.io_util")?.val).to.equal(null);
    });

    it("the dynamic groups also get corrected names when the system has no stats", async () => {
      // Same defect one level down: updateDynamicStats only runs with live data, so a
      // system that is down kept the old wording on its container / GPU / interface /
      // filesystem datapoints (v0.14.1).
      const cfg = allMetricsConfig({ metrics_containers: true, metrics_gpu: true });
      await manager.snapshotExistingStates();
      await manager.updateSystem(testSystem, testStats, testContainers, cfg);
      // Pretend an older version had created them with different wording.
      for (const id of [...adapter.objects.keys()].filter(k => k.includes(".containers."))) {
        const o = adapter.objects.get(id)!;
        adapter.objects.set(id, { ...o, common: { ...o.common, name: { en: "old wording" } } });
      }

      const fresh = new StateManager(adapter as never);
      await fresh.snapshotExistingStates();
      await fresh.updateSystem({ ...testSystem, status: "down" }, undefined, [], cfg);

      const statusId = [...adapter.objects.keys()].find(k => /\.containers\.[^.]+\.status$/.test(k));
      expect(statusId, "the test fixture must produce a container status datapoint").to.not.be.undefined;
      expect(adapter.objects.get(statusId!)?.common.name).to.deep.equal({ en: "status", de: "status_de" });
    });

    it("the group CHANNELS are refreshed too when the system has no stats", async () => {
      // The channels the adapter names itself (containers, sensors, cores, …) ride the
      // same path — without this they keep the name they were created with.
      const cfg = allMetricsConfig({ metrics_containers: true });
      await manager.snapshotExistingStates();
      await manager.updateSystem(testSystem, testStats, testContainers, cfg);
      const chan = adapter.objects.get("systems.my_server.containers")!;
      adapter.objects.set("systems.my_server.containers", {
        ...chan,
        common: { ...chan.common, name: { en: "old channel wording" } },
      });

      const fresh = new StateManager(adapter as never);
      await fresh.snapshotExistingStates();
      await fresh.updateSystem({ ...testSystem, status: "down" }, undefined, [], cfg);

      expect(adapter.objects.get("systems.my_server.containers")?.common.name).to.deep.equal({
        en: "channelContainers",
        de: "channelContainers_de",
      });
    });

    it("every adapter-named dynamic datapoint is covered by the shared leaf table", async () => {
      // The table drives BOTH paths, so a new metric that is forgotten in it fails here
      // and not on a user's tree. This walks a fully populated system and demands that
      // each datapoint the ADAPTER names (the mock marks those with a `_de` suffix) is
      // matched by a pattern.
      const cfg = allMetricsConfig({
        metrics_containers: true,
        metrics_gpu: true,
        metrics_gpuDetails: true,
        metrics_extraFs: true,
        metrics_networkInterfaces: true,
        metrics_cpuCores: true,
        metrics_zfs: true,
      });
      await manager.snapshotExistingStates();
      await manager.updateSystem(
        testSystem,
        { ...richStats(), z: { tank: { d: 100, du: 50, rb: 1048576, wb: 0, h: "ONLINE" } } },
        testContainers,
        cfg,
      );

      const prefix = "systems.my_server.";
      const groups =
        /^(temperature\.sensors|fans|battery\.batteries|cpu\.cores|network\.interfaces|gpu|filesystems|zfs|containers)\./;
      const missed: string[] = [];
      for (const [id, obj] of adapter.objects) {
        if (obj.type !== "state" || !id.startsWith(prefix)) {
          continue;
        }
        const rel = id.slice(prefix.length);
        if (!groups.test(rel)) {
          continue; // scalar metric — covered by applyMetrics, not by this table
        }
        const name = obj.common.name as { de?: string } | undefined;
        const adapterNamed = typeof name?.de === "string" && name.de.endsWith("_de");
        if (adapterNamed && !DYNAMIC_LEAF_PATTERNS.some(e => e.match.test(rel))) {
          missed.push(rel);
        }
      }
      expect(missed, "adapter-named dynamic datapoints missing from DYNAMIC_LEAF_PATTERNS").to.deep.equal([]);
    });

    it("every leaf definition is reachable through a pattern", async () => {
      // The other direction: a `common` nobody can match is dead weight, and it hides a
      // leaf whose refresh silently never happens.
      const patterned = new Set(DYNAMIC_LEAF_PATTERNS.map(e => e.id));
      const unreachable = Object.keys(LEAF_COMMONS).filter(id => !patterned.has(id as keyof typeof LEAF_COMMONS));
      expect(unreachable, "leaf definitions without a path pattern").to.deep.equal([]);
      const unknown = DYNAMIC_LEAF_PATTERNS.filter(e => !(e.id in LEAF_COMMONS)).map(e => e.id);
      expect(unknown, "patterns pointing at a leaf definition that does not exist").to.deep.equal([]);
      await Promise.resolve();
    });

    it("BOTH the creation path and the refresh path read the shared leaf table", async () => {
      // A table can be complete while a caller quietly stopped reading it — dropping a
      // single call line left gate, linter and type check green on fakeroku. So this
      // does not compare the two commons with each other (they could both be wrong in
      // the same way); it REPLACES one entry of the table and demands that each path
      // hands out the replacement.
      const cfg = allMetricsConfig({ metrics_networkInterfaces: true });
      const original = LEAF_COMMONS.ifaceUp;
      const sentinel = (): ioBroker.StateCommon => ({
        name: { en: "SENTINEL", de: "SENTINEL_de" },
        type: "number",
        role: "value",
        unit: "sentinel/s",
        read: true,
        write: false,
      });
      try {
        LEAF_COMMONS.ifaceUp = sentinel;

        // (a) creation path — updateDynamicStats builds the leaf with a value
        await manager.snapshotExistingStates();
        await manager.updateSystem(testSystem, richStats(), [], cfg);
        const id = "systems.my_server.network.interfaces.eth0.up";
        expect(adapter.objects.get(id)?.common.unit, "creation path ignores the table").to.equal("sentinel/s");

        // (b) refresh path — a fresh manager, a system without stats, object only
        adapter.objects.set(id, {
          ...adapter.objects.get(id)!,
          common: { ...adapter.objects.get(id)!.common, unit: "stale" },
        });
        const fresh = new StateManager(adapter as never);
        await fresh.snapshotExistingStates();
        await fresh.updateSystem({ ...testSystem, status: "down" }, undefined, [], cfg);
        expect(adapter.objects.get(id)?.common.unit, "refresh path ignores the table").to.equal("sentinel/s");
      } finally {
        LEAF_COMMONS.ifaceUp = original;
      }
    });

    it("a system without stats STILL gets corrected names and descriptions on its datapoints", async () => {
      // Found on the live tree (v0.14.1): the two systems that were down carried the old
      // wording and no descriptions, because their metrics were skipped whole — the
      // object refresh rode along with the value write. No gate can see this.
      adapter.objects.set("systems.my_server.cpu.usage", {
        type: "state",
        common: { name: { en: "old wording" }, type: "number", role: "value" },
        native: {},
      });
      adapter.states.set("systems.my_server.cpu.usage", { val: 42, ack: true });
      await manager.snapshotExistingStates();

      await manager.updateSystem({ ...testSystem, status: "down" }, undefined, [], allMetricsConfig());

      const obj = adapter.objects.get("systems.my_server.cpu.usage");
      expect(obj?.common.name, "the corrected name must reach a down system too").to.deep.equal({
        en: "cpuUsage",
        de: "cpuUsage_de",
      });
      // …and the value it last measured stays exactly where it was.
      expect(adapter.states.get("systems.my_server.cpu.usage")?.val).to.equal(42);
    });

    it("a system without stats gains NO new datapoints", async () => {
      // The other half of the same rule: refreshing existing objects must not create
      // datapoints for a system that never reported the metric.
      await manager.snapshotExistingStates();
      await manager.updateSystem({ ...testSystem, status: "down" }, undefined, [], allMetricsConfig());
      expect(adapter.objects.has("systems.my_server.cpu.usage")).to.be.false;
      expect(adapter.objects.has("systems.my_server.memory.percent")).to.be.false;
    });

    it("a system without ANY stats keeps its last values — in the same run and after a restart", async () => {
      // The Hub has no reading for the system (down / paused). The dynamic groups
      // already froze in this case; the scalars nulled themselves, so the same
      // situation produced two different trees depending on whether the adapter had
      // restarted in between (v0.14.0).
      const cfg = allMetricsConfig();
      await manager.snapshotExistingStates();
      await manager.updateSystem(testSystem, testStats, [], cfg);
      const measured = adapter.states.get("systems.my_server.cpu.usage")?.val;
      expect(measured).to.be.a("number");

      await manager.updateSystem({ ...testSystem, status: "down" }, undefined, [], cfg);
      expect(adapter.states.get("systems.my_server.cpu.usage")?.val).to.equal(measured);

      const fresh = new StateManager(adapter as never);
      await fresh.snapshotExistingStates();
      await fresh.updateSystem({ ...testSystem, status: "down" }, undefined, [], cfg);
      expect(adapter.states.get("systems.my_server.cpu.usage")?.val).to.equal(measured);
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

    it("sweeps without probing: not a single object read for the legacy ids", async () => {
      // The sweep decides from the startup snapshot. Before v0.14.0 it probed 33 ids
      // per system and needed the `info.legacyMigrated` marker to stop doing that on
      // every restart; now there is nothing to skip, so the marker is gone.
      adapter.objects.set("systems.my_server", { type: "device", common: { name: "My Server" }, native: {} });
      adapter.objects.set("systems.my_server.cpu_usage", { type: "state", common: {}, native: {} });
      await manager.snapshotExistingStates();
      let objectReads = 0;
      const origGet = adapter.getObjectAsync;
      adapter.getObjectAsync = (id: string): Promise<ObjectDef | null> => {
        objectReads++;
        return origGet(id);
      };
      await manager.migrateLegacyStates();
      expect(adapter.objects.has("systems.my_server.cpu_usage")).to.be.false;
      expect(objectReads).to.equal(0);
    });

    it("takes the snapshot itself when the caller did not", async () => {
      // onReady always snapshots first; a direct caller must still get a working sweep.
      adapter.objects.set("systems.my_server", { type: "device", common: { name: "My Server" }, native: {} });
      adapter.objects.set("systems.my_server.cpu_usage", { type: "state", common: {}, native: {} });
      await manager.migrateLegacyStates();
      expect(adapter.objects.has("systems.my_server.cpu_usage")).to.be.false;
    });

    it("removes the obsolete legacyMigrated marker from an upgraded install", async () => {
      adapter.objects.set("info.legacyMigrated", {
        type: "state",
        common: { name: "Legacy state migration completed" },
        native: {},
      });
      adapter.states.set("info.legacyMigrated", { val: true, ack: true });
      await manager.snapshotExistingStates();

      await manager.migrateLegacyStates();

      expect(adapter.objects.has("info.legacyMigrated")).to.be.false;
      // The user-facing datapoint line has to report it like any other removal.
      expect(manager.takeChangeCounts().removed).to.equal(1);
    });

    it("should do nothing when no legacy states exist", async () => {
      // Create a system with new channel-based states
      await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
      const objectCountBefore = adapter.objects.size;

      await manager.migrateLegacyStates();

      // No marker is created any more — the object tree is untouched.
      expect(adapter.objects.has("info.legacyMigrated")).to.be.false;
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
      const mgr = internals(manager);
      expect(mgr.sanitize(null)).to.equal("");
      expect(mgr.sanitize(undefined)).to.equal("");
      expect(mgr.sanitize(42)).to.equal("");
      expect(mgr.sanitize({})).to.equal("");
      expect(mgr.sanitize([])).to.equal("");
    });

    it("sanitize collapses all-non-alphanumeric names to empty", () => {
      expect(internals(manager).sanitize("!!!")).to.equal("");
      expect(internals(manager).sanitize("---")).to.equal("");
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

    it("SM10: clamps a negative uptime instead of formatting '-1d -2h'", async () => {
      // Clock skew or an agent bug can send a negative value; without the clamp
      // the text state read "-1d -2h -3m" (audit 2026-08-22 — clamp unguarded).
      const sys = { ...testSystem, info: { u: -93780 } };
      await manager.updateSystem(sys, undefined, [], allMetricsConfig());
      expect(adapter.states.get("systems.my_server.info.uptime_text")?.val).to.equal("0m");
      expect(adapter.states.get("systems.my_server.info.uptime")?.val).to.equal(-93780);
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

    it("uses only FINITE temperature readings for average and max", async () => {
      // The old version of this test passed four valid numbers, so it proved
      // nothing about filtering — removing the finite-filter entirely kept it
      // green (audit 2026-08-22). A non-finite reading that slips past the
      // coercer (Hub drift) must be ignored, not poison avg/max with NaN.
      const stats = { t: { a: 60, b: 70, c: 80, d: 50, broken: NaN, huge: Infinity } } as unknown as SystemStats;
      await manager.updateSystem(testSystem, stats, [], allMetricsConfig());
      expect(adapter.states.get("systems.my_server.temperature.average")?.val).to.equal(70);
      expect(adapter.states.get("systems.my_server.temperature.max")?.val).to.equal(80);
    });

    it("writes null when every temperature reading is unusable", async () => {
      const stats = { t: { a: NaN, b: Infinity } } as unknown as SystemStats;
      await manager.updateSystem(testSystem, stats, [], allMetricsConfig());
      expect(adapter.states.get("systems.my_server.temperature.average")?.val).to.be.null;
      expect(adapter.states.get("systems.my_server.temperature.max")?.val).to.be.null;
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

    it("reports battery not charging when chargeState is 0", async () => {
      const stats: SystemStats = { bat: [45, 0] };
      await manager.updateSystem(testSystem, stats, [], allMetricsConfig());
      expect(adapter.states.get("systems.my_server.battery.charging")?.val).to.be.false;
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

    it("skips a dynamic-group member whose name sanitizes to nothing", async () => {
      // A sensor called "!!!" has no usable id segment — it must be skipped, not
      // written to `<sysId>.temperature.sensors.` (audit 2026-08-22: unguarded).
      const stats: SystemStats = { t: { "!!!": 40, "Core 0": 45 } };
      await manager.updateSystem(testSystem, stats, [], allMetricsConfig());
      const sensorIds = [...adapter.states.keys()].filter(k => k.includes(".temperature.sensors."));
      expect(sensorIds).to.deep.equal(["systems.my_server.temperature.sensors.core_0"]);
    });

    it("maps an unknown OS enum to a labelled fallback instead of a bare number", async () => {
      const sys = { ...testSystem, details: { os: 7 } };
      await manager.updateSystem(sys, undefined, [], allMetricsConfig());
      expect(adapter.states.get("systems.my_server.info.os")?.val).to.equal("Unknown (7)");
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
  // createdIds cache: avoid repeated object writes per poll
  // -----------------------------------------------------------------------

  describe("createdIds cache", () => {
    it("does not write the channel objects again on a second poll", async () => {
      let createCalls = 0;
      const original = adapter.extendObject;
      adapter.extendObject = (id, obj): Promise<void> => {
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
      const original = adapter.extendObject;
      adapter.extendObject = (id, obj): Promise<void> => {
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
      const original = adapter.extendObject;
      adapter.extendObject = (id, obj): Promise<void> => {
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

    it("does not re-extendObject every STATE on a second poll (one write per state per restart)", async () => {
      // The existing cache test counts setObjectNotExistsAsync — but states go
      // through extendObject (DP-retrofit), so the state-level cache was
      // unguarded: writing every state's object on every poll kept the suite
      // green (audit 2026-08-22). That is one DB write per state per minute.
      let stateExtends = 0;
      const origExtend = adapter.extendObject;
      adapter.extendObject = async (...args): Promise<void> => {
        if (args[0] !== "systems.my_server") {
          stateExtends++;
        }
        return origExtend(...args);
      };
      await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
      expect(stateExtends).to.be.greaterThan(0);

      stateExtends = 0;
      await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
      expect(stateExtends).to.equal(0);
    });

    it("DP-retrofit: a state object is extended WITHOUT preserve, so a changed name reaches it", async () => {
      const calls: unknown[][] = [];
      const origExtend = adapter.extendObject;
      adapter.extendObject = (...args: unknown[]): Promise<void> => {
        calls.push(args);
        return origExtend(args[0] as string, args[1] as Partial<ObjectDef>);
      };
      await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
      const stateCall = calls.find(c => c[0] === "systems.my_server.cpu.usage");
      expect(stateCall, "cpu.usage must be written via extendObject").to.not.be.undefined;
      // No third argument: preserving `common.name` would freeze the text an
      // existing installation was first created with (v0.14.0).
      expect(stateCall![2]).to.be.undefined;
    });

    it("a corrected name reaches a state that ALREADY exists (not just fresh installs)", async () => {
      // The exact defect `preserve` used to cause: an upgraded install keeps the
      // old wording forever while the manifest and every gate look green.
      adapter.objects.set("systems.my_server.cpu.usage", {
        type: "state",
        common: { name: { en: "old wording", de: "alter Text" }, type: "number", role: "value" },
        native: {},
      });

      await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());

      expect(adapter.objects.get("systems.my_server.cpu.usage")?.common.name).to.deep.equal({
        en: "cpuUsage",
        de: "cpuUsage_de",
      });
    });

    it("a corrected name reaches a CHANNEL that already exists", async () => {
      adapter.objects.set("systems.my_server.cpu", {
        type: "channel",
        common: { name: { en: "old channel wording" } },
        native: {},
      });

      await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());

      expect(adapter.objects.get("systems.my_server.cpu")?.common.name).to.deep.equal({
        en: "channelCpu",
        de: "channelCpu_de",
      });
    });

    it("the DEVICE object keeps preserve — its name is the Hub's, a user rename stays", async () => {
      const calls: unknown[][] = [];
      const origExtend = adapter.extendObject;
      adapter.extendObject = (...args: unknown[]): Promise<void> => {
        calls.push(args);
        return origExtend(args[0] as string, args[1] as Partial<ObjectDef>);
      };
      await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
      const deviceCall = calls.find(c => c[0] === "systems.my_server");
      expect(deviceCall, "the device object must be written").to.not.be.undefined;
      expect(deviceCall![2]).to.deep.equal({ preserve: { common: ["name"] } });
    });
  });

  // -----------------------------------------------------------------------
  // v0.7.2 — device-object write cache
  // -----------------------------------------------------------------------

  describe("device-object write cache (v0.7.2)", () => {
    it("writes the device object only once while id/host/name are unchanged", async () => {
      let extendCalls = 0;
      const origExtend = adapter.extendObject;
      adapter.extendObject = async (...args): Promise<void> => {
        // DP-retrofit: createAndSetState now also extendObjects each state, so
        // count only the DEVICE-object write to keep testing the device cache.
        if (args[0] === "systems.my_server") {
          extendCalls++;
        }
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
      const origExtend = adapter.extendObject;
      adapter.extendObject = async (...args): Promise<void> => {
        // DP-retrofit: createAndSetState now also extendObjects each state, so
        // count only the DEVICE-object write to keep testing the device cache.
        if (args[0] === "systems.my_server") {
          extendCalls++;
        }
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
      const origExtend = adapter.extendObject;
      adapter.extendObject = async (...args): Promise<void> => {
        // DP-retrofit: createAndSetState now also extendObjects each state, so
        // count only the DEVICE-object write to keep testing the device cache.
        if (args[0] === "systems.my_server") {
          extendCalls++;
        }
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

    it("reconciles zombies from a previous run on the first poll (startup snapshot)", async () => {
      // Simulate a leftover container channel from before this adapter start. v0.16.0:
      // the reconcile reads the startup snapshot instead of a per-group object view, so
      // the leftover has to be in the tree when the snapshot is taken — which is exactly
      // the situation it describes (onReady snapshots before the first poll).
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
      await manager.snapshotExistingStates();
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

    it("a removed-and-re-added system reconciles against the DB again (group cache follows the lifecycle)", async () => {
      // dropCacheUnder must clear dynamicChildren too — otherwise the re-added
      // system trusts a stale in-memory set and never reconciles, so leftovers from the
      // previous life stay forever (audit 2026-08-22: that cache-drop was unguarded).
      // A zombie sensor from an older version is in the tree when the adapter starts.
      adapter.objects.set("systems.my_server.temperature.sensors.zombie", {
        type: "state",
        common: { name: "zombie" },
        native: {},
      });
      await manager.snapshotExistingStates();
      await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
      expect(adapter.objects.has("systems.my_server.temperature.sensors.zombie")).to.be.false;
      await manager.cleanupSystems([]); // system disappears from the Hub
      expect(adapter.objects.has("systems.my_server")).to.be.false;

      await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
      expect(adapter.states.has("systems.my_server.temperature.sensors.core_0")).to.be.true;
      expect(adapter.objects.has("systems.my_server.temperature.sensors.zombie")).to.be.false;
    });

    it("getExistingSystemNames is empty when the snapshot found no device", async () => {
      await manager.snapshotExistingStates();
      expect(manager.getExistingSystemNames()).to.deep.equal([]);
    });

    it("does not treat a prefix-sharing sibling as a group member", async () => {
      // The reconcile filters `<base>.` — an id that merely SHARES the prefix
      // (`temperature.sensors_backup`) is a different object and must survive.
      adapter.objects.set("systems.my_server.temperature.sensors_backup", {
        type: "channel",
        common: { name: "not a member" },
        native: {},
      });
      await manager.snapshotExistingStates();
      await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
      expect(adapter.objects.has("systems.my_server.temperature.sensors_backup")).to.be.true;
      expect(adapter.objects.has("systems.my_server.temperature.sensors.core_0")).to.be.true;
    });

    it("getExistingSystemNames returns only direct system devices, not deeper ids", async () => {
      // A `device`-typed object further down the tree (foreign writer, older
      // layout) must not be mistaken for a system name — cleanupSystems would
      // then delete the wrong path.
      adapter.objects.set("systems.my_server", { type: "device", common: {}, native: {} });
      adapter.objects.set("systems.my_server.sub.device", { type: "device", common: {}, native: {} });
      await manager.snapshotExistingStates();
      expect(manager.getExistingSystemNames()).to.deep.equal(["my_server"]);
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
          out.set(key, value);
        }
        collectFields(value, out);
      }
    }

    const jsonConfig = JSON.parse(readFileSync(join(__dirname, "../../admin/jsonConfig.json"), "utf8")) as unknown;
    const fields = new Map<string, JsonConfigField>();
    collectFields(jsonConfig, fields);
    const deps = METRIC_DEPENDENCIES as Record<string, string>;

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

    it("manifest, admin UI and code know exactly the same metric switches", () => {
      // v0.16.0: the third side of the triangle. `ALL_TOGGLES` is derived from the code,
      // so this closes the gap that let a new switch (`metrics_diskIo`, 2026-09-05) exist
      // in the manifest and the UI while the test fixtures had never heard of it — three
      // "does NOT create when off" tests were asserting nothing because of it.
      const manifest = JSON.parse(readFileSync(join(__dirname, "../../io-package.json"), "utf8")) as {
        native: Record<string, unknown>;
      };
      const inManifest = Object.keys(manifest.native)
        .filter(k => k.startsWith("metrics_"))
        .sort();
      const inCode = [...ALL_TOGGLES].sort();
      const inAdmin = [...fields.keys()].sort();
      expect(inCode, "code toggles vs. io-package.json native").to.deep.equal(inManifest);
      expect(inAdmin, "admin UI fields vs. io-package.json native").to.deep.equal(inManifest);
      // …and every one of them is a real boolean default, not an accident.
      for (const key of inManifest) {
        expect(typeof manifest.native[key], `${key} must default to a boolean`).to.equal("boolean");
      }
    });
  });

  describe("device object", () => {
    it("links the device to its online state via statusStates (admin shows the red/green dot)", async () => {
      // Without statusStates.onlineId the admin device view loses its
      // reachability indicator — invisible to the suite until now.
      await manager.updateSystem(testSystem, undefined, [], allMetricsConfig());
      const dev = adapter.objects.get("systems.my_server");
      expect(dev!.common.statusStates).to.deep.equal({
        onlineId: "beszel.0.systems.my_server.info.online",
      });
    });
  });

  // -----------------------------------------------------------------------
  // v0.16.0 — a deleted channel stays deleted
  // -----------------------------------------------------------------------

  describe("channel bookkeeping (v0.16.0)", () => {
    it("a channel cleanupMetrics deleted does NOT come back on a system without stats", async () => {
      // The bug: `knownChannelIds` was filled by the startup snapshot and never pruned,
      // so refreshDynamicObjects found every deleted group channel again and
      // `extendObject` re-created it — empty. Every start deleted them, every first poll
      // brought them back, and only on the systems that are offline right now.
      adapter.objects.set("systems.my_server", { type: "device", common: {}, native: {} });
      for (const ch of [
        "systems.my_server.containers",
        "systems.my_server.containers.nginx",
        "systems.my_server.cpu",
        "systems.my_server.cpu.cores",
        "systems.my_server.temperature",
        "systems.my_server.temperature.sensors",
        "systems.my_server.gpu",
        "systems.my_server.fans",
        "systems.my_server.zfs",
        "systems.my_server.filesystems",
        "systems.my_server.network",
        "systems.my_server.network.interfaces",
      ]) {
        adapter.objects.set(ch, { type: "channel", common: { name: { en: "old" } }, native: {} });
      }
      adapter.objects.set("systems.my_server.containers.nginx.status", {
        type: "state",
        common: {},
        native: {},
      });
      await manager.snapshotExistingStates();

      // Every dynamic group switched off.
      const cfg = allMetricsConfig({
        metrics_containers: false,
        metrics_cpuCores: false,
        metrics_temperatureDetails: false,
        metrics_gpu: false,
        metrics_gpuDetails: false,
        metrics_fans: false,
        metrics_zfs: false,
        metrics_extraFs: false,
        metrics_networkInterfaces: false,
      });
      await manager.cleanupMetrics("my_server", cfg);
      const gone = [
        "systems.my_server.containers",
        "systems.my_server.cpu.cores",
        "systems.my_server.temperature.sensors",
        "systems.my_server.gpu",
        "systems.my_server.fans",
        "systems.my_server.zfs",
        "systems.my_server.filesystems",
        "systems.my_server.network.interfaces",
      ];
      for (const id of gone) {
        expect(adapter.objects.has(id), `${id} should be gone after cleanup`).to.be.false;
      }

      // First poll, system has no reading → the refresh path walks the tree.
      await manager.updateSystem({ ...testSystem, status: "down" }, undefined, [], cfg);
      const resurrected = gone.filter(id => adapter.objects.has(id));
      expect(resurrected, "empty channels resurrected on a system without stats").to.deep.equal([]);
    });

    it("a group channel pruned at runtime stays gone when the system later goes down", async () => {
      // Same defect, reachable without touching a single switch: containers stop, the
      // drop-to-zero prune removes the now-empty parent channel, the system goes
      // offline — and the channel used to reappear.
      adapter.objects.set("systems.my_server", { type: "device", common: {}, native: {} });
      adapter.objects.set("systems.my_server.containers", {
        type: "channel",
        common: { name: { en: "Containers" } },
        native: {},
      });
      adapter.objects.set("systems.my_server.containers.nginx", {
        type: "channel",
        common: { name: { en: "nginx" } },
        native: {},
      });
      adapter.objects.set("systems.my_server.containers.nginx.status", {
        type: "state",
        common: {},
        native: {},
      });
      await manager.snapshotExistingStates();

      const cfg = allMetricsConfig({ metrics_containers: true });
      // Two empty polls: the second confirms the drop-to-zero and prunes the parent.
      await manager.updateSystem(testSystem, testStats, [], cfg);
      await manager.updateSystem(testSystem, testStats, [], cfg);
      expect(adapter.objects.has("systems.my_server.containers"), "prune must remove the empty parent").to.be.false;

      await manager.updateSystem({ ...testSystem, status: "down" }, undefined, [], cfg);
      expect(adapter.objects.has("systems.my_server.containers"), "channel came back on the offline system").to.be
        .false;
    });

    it("removing a system forgets its channels and device, so nothing is refreshed into existence", async () => {
      await manager.snapshotExistingStates();
      await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
      expect(manager.getExistingSystemNames()).to.deep.equal(["my_server"]);

      await manager.cleanupSystems([]);
      expect(manager.getExistingSystemNames()).to.deep.equal([]);
      // The refresh walk of ANOTHER system must not resurrect anything of the removed one.
      await manager.updateSystem({ ...testSystem, id: "other", name: "Other" }, undefined, [], allMetricsConfig());
      const leftovers = [...adapter.objects.keys()].filter(id => id.startsWith("systems.my_server"));
      expect(leftovers, "objects of a removed system reappeared").to.deep.equal([]);
    });

    it("deleting a state the bookkeeping never saw is a no-op, not a delete", async () => {
      // The gpuDetails branch asks for every GPU's power_package; a GPU that never had
      // one (details were off all along) must not produce a delete for a missing object.
      const stats = { ...testStats, g: { gpu0: { n: "Intel", u: 30 } } };
      await manager.snapshotExistingStates();
      await manager.updateSystem(testSystem, stats, [], allMetricsConfig({ metrics_gpuDetails: false }));
      expect(adapter.objects.has("systems.my_server.gpu.gpu0.power_package")).to.be.false;
      const deleted: string[] = [];
      adapter.delObjectAsync = (id: string): Promise<void> => {
        deleted.push(id);
        return Promise.resolve();
      };
      await manager.cleanupMetrics("my_server", allMetricsConfig({ metrics_gpu: true, metrics_gpuDetails: false }));
      expect(deleted, "deleted an object that was never there").to.not.include(
        "systems.my_server.gpu.gpu0.power_package",
      );
    });

    it("cleanupMetrics asks the objects DB nothing — the startup snapshot answers", async () => {
      // Measured before the change: 43 `getObjectAsync` per system per start on the
      // default configuration, for information the snapshot had just read in one call.
      // The tree must actually CONTAIN what gets deleted, otherwise the counter has
      // nothing to count and the test would pass on an empty run.
      await manager.snapshotExistingStates();
      await manager.updateSystem(
        testSystem,
        richStats(),
        testContainers,
        allMetricsConfig({ metrics_gpu: true, metrics_gpuDetails: true, metrics_containers: true }),
      );
      expect(adapter.states.has("systems.my_server.gpu.gpu0.power_package"), "fixture must create removable states").to
        .be.true;
      expect(adapter.objects.has("systems.my_server.containers"), "fixture must create removable channels").to.be.true;
      let reads = 0;
      adapter.getObjectAsync = (id: string): Promise<ObjectDef | null> => {
        reads++;
        return Promise.resolve(adapter.objects.get(id) ?? null);
      };
      adapter.getObjectViewAsync = (): Promise<{ rows: Array<{ id: string; value: ObjectDef }> }> => {
        reads++;
        return Promise.resolve({ rows: [] });
      };
      await manager.cleanupMetrics(
        "my_server",
        allMetricsConfig({
          metrics_gpu: true,
          metrics_gpuDetails: false,
          metrics_cpuPeak: false,
          metrics_containers: false,
          metrics_battery: false,
        }),
      );
      // …and it really did delete, so the zero above is "asked nobody", not "did nothing".
      expect(adapter.objects.has("systems.my_server.containers")).to.be.false;
      expect(adapter.objects.has("systems.my_server.battery")).to.be.false;
      expect(adapter.objects.has("systems.my_server.gpu.gpu0.power_package")).to.be.false;
      expect(reads, "cleanupMetrics still reads objects from the DB").to.equal(0);
    });
  });

  // -----------------------------------------------------------------------
  // v0.16.0 — common.states: plain strings, translated, complete
  // -----------------------------------------------------------------------

  describe("defensive fallbacks (v0.16.0)", () => {
    it("a snapshot the broker answers with nothing leaves the bookkeeping empty", async () => {
      adapter.getObjectListAsync = (): Promise<null> => Promise.resolve(null);
      await manager.snapshotExistingStates();
      expect(manager.getExistingSystemNames()).to.deep.equal([]);
    });

    it("the snapshot ignores object types it does not track", async () => {
      adapter.objects.set("systems", { type: "folder", common: {}, native: {} });
      adapter.objects.set("systems.my_server", { type: "device", common: {}, native: {} });
      adapter.objects.set("systems.my_server.cpu", { type: "channel", common: {}, native: {} });
      adapter.objects.set("systems.my_server.cpu.usage", { type: "state", common: {}, native: {} });
      await manager.snapshotExistingStates();
      expect(manager.getExistingSystemNames()).to.deep.equal(["my_server"]);
    });

    it("a system whose name is not even a string is skipped with a readable warning", async () => {
      const warns: string[] = [];
      adapter.log.warn = (m: string): void => {
        warns.push(m);
      };
      const broken = { ...testSystem, name: { oops: true } } as unknown as BeszelSystem;
      await manager.updateSystem(broken, testStats, [], allMetricsConfig());
      expect(warns.some(w => w.includes("unusable name") && w.includes("oops"))).to.equal(true);
      expect([...adapter.objects.keys()].some(k => k.startsWith("systems."))).to.equal(false);
    });

    it("a system with an unusable name contributes nothing to the offline id list", () => {
      manager.prepareForPoll([
        { ...testSystem, id: "a", name: "Good One" },
        { ...testSystem, id: "b", name: "!!!" },
      ]);
      expect(manager.knownSystemIds()).to.deep.equal(["systems.good_one"]);
    });

    it("a container whose name sanitizes to nothing is skipped, the others are not", async () => {
      const containers: BeszelContainer[] = [
        { id: "c1", system: "sys001", name: "***", status: "running", health: 2, cpu: 1, memory: 8, image: "i" },
        { id: "c2", system: "sys001", name: "nginx", status: "running", health: 2, cpu: 1, memory: 8, image: "i" },
      ];
      await manager.updateSystem(testSystem, testStats, containers, allMetricsConfig({ metrics_containers: true }));
      const built = [...adapter.objects.keys()].filter(
        k => /^systems\.my_server\.containers\.[^.]+$/.test(k) && adapter.objects.get(k)!.type === "channel",
      );
      expect(built).to.deep.equal(["systems.my_server.containers.nginx"]);
    });

    it("a system with an unusable name is not mistaken for a stale device during cleanup", async () => {
      adapter.objects.set("systems.good_one", { type: "device", common: {}, native: {} });
      await manager.snapshotExistingStates();
      manager.prepareForPoll([
        { ...testSystem, id: "a", name: "Good One" },
        { ...testSystem, id: "b", name: "!!!" },
      ]);
      await manager.cleanupSystems(["Good One"]);
      expect(adapter.objects.has("systems.good_one"), "the healthy system must survive").to.be.true;
    });

    it("a dynamic-group member whose name sanitizes to nothing is skipped, not crashed on", async () => {
      const stats = { ...testStats, t: { "!!!": 40, cpu: 50 } };
      await manager.updateSystem(testSystem, stats, [], allMetricsConfig({ metrics_temperatureDetails: true }));
      const sensors = [...adapter.objects.keys()].filter(k => k.startsWith("systems.my_server.temperature.sensors."));
      expect(sensors).to.deep.equal(["systems.my_server.temperature.sensors.cpu"]);
    });

    it("the byte conversions answer null rather than NaN when the Hub omits the field", () => {
      expect(bytesToMib(undefined)).to.equal(null);
      expect(bytesToGib(undefined)).to.equal(null);
      expect(bytesToMib(1024 * 1024)).to.equal(1);
      expect(bytesToGib(1024 * 1024 * 1024)).to.equal(1);
    });

    it("the per-core leaf still builds a common when no index is handed in", () => {
      // The refresh path passes the index from the id; a caller without one must get a
      // usable common instead of `Core NaN`.
      expect(leafCommon("cpuCore")).to.have.property("type", "number");
    });

    it("a GPU without a vendor name falls back to its own id", async () => {
      const stats = { ...testStats, g: { gpu7: { u: 30 } } };
      await manager.updateSystem(testSystem, stats, [], allMetricsConfig({ metrics_gpu: true }));
      expect(adapter.objects.get("systems.my_server.gpu.gpu7")?.common.name).to.equal("gpu7");
    });

    it("a ZFS pool that reports nothing readable still gets its channel and null values", async () => {
      const stats = { ...testStats, z: { tank: {} } };
      await manager.updateSystem(testSystem, stats, [], allMetricsConfig({ metrics_zfs: true }));
      expect(adapter.objects.has("systems.my_server.zfs.tank")).to.be.true;
      expect(adapter.states.get("systems.my_server.zfs.tank.disk_total")?.val).to.equal(null);
      expect(adapter.states.get("systems.my_server.zfs.tank.disk_percent")?.val).to.equal(null);
      expect(adapter.states.get("systems.my_server.zfs.tank.health")?.val).to.equal(null);
      // omitzero on the wire means idle, not unknown — the speeds stay 0.
      expect(adapter.states.get("systems.my_server.zfs.tank.read_speed")?.val).to.equal(0);
    });

    it("a filesystem that reports no size yields null, not a computed percentage", async () => {
      const stats = { ...testStats, efs: { "/mnt/x": {} } };
      await manager.updateSystem(testSystem, stats, [], allMetricsConfig({ metrics_extraFs: true }));
      expect(adapter.states.get("systems.my_server.filesystems.mnt_x.disk_percent")?.val).to.equal(null);
      expect(adapter.states.get("systems.my_server.filesystems.mnt_x.disk_total")?.val).to.equal(null);
    });
  });

  describe("registry robustness (v0.16.0)", () => {
    it("every metric's extract survives a system with no data at all", () => {
      // The `?? null` tails are the defence against a Hub that sends a record without
      // the field. `available` normally keeps them out of reach, which is exactly why
      // nothing had ever exercised them — one changed guard and a thrown TypeError
      // would take a whole poll down.
      const bare: BeszelSystem = { id: "x", name: "X", status: "up", host: "h", info: {} };
      for (const def of buildMetricDefs()) {
        const withoutStats = (): unknown => def.extract(bare, undefined);
        const withEmptyStats = (): unknown => def.extract(bare, {});
        expect(withoutStats, `${def.id} threw without stats`).to.not.throw();
        expect(withEmptyStats, `${def.id} threw on an empty stats record`).to.not.throw();
        expect([null, undefined], `${def.id} invented a value out of nothing`).to.include(def.extract(bare, {}));
      }
    });

    it("every metric's availability gate says no when there is nothing to read", () => {
      const bare: BeszelSystem = { id: "x", name: "X", status: "up", host: "h", info: {} };
      for (const def of buildMetricDefs()) {
        if (!def.available) {
          continue; // always-available metrics fall back inside extract (loadAvg, uptime)
        }
        expect(def.available(undefined, bare), `${def.id} claims to be available without stats`).to.equal(false);
      }
    });
  });

  describe("common.states invariants (v0.16.0)", () => {
    it("every states VALUE is a plain string (React #31 invariant)", () => {
      // A translation object in a `common.states` value takes the whole admin down with
      // React error #31 — the admin renders the value directly as a React child. The
      // fleet standard demands this test next to every states map.
      for (const [label, map] of [
        ["systemStatusStates", systemStatusStates()],
        ["zfsHealthStates", zfsHealthStates()],
        ["containerHealthStates", containerHealthStates()],
      ] as const) {
        for (const [k, v] of Object.entries(map)) {
          expect(typeof v, `${label}[${k}] must be a plain string`).to.equal("string");
        }
      }
    });

    it("every states LABEL comes from the translation, not from a hardcoded word", () => {
      // The mock answers a translation with its key, so a label that never went through
      // `tState` would show up here as the English word it was frozen as.
      expect(systemStatusStates()).to.deep.equal({
        up: "stateUp",
        down: "stateDown",
        paused: "statePaused",
        pending: "statePending",
        unknown: "stateUnknown",
      });
      expect(zfsHealthStates().UNAVAIL).to.equal("zfsUnavailable");
      expect(containerHealthStates().unhealthy).to.equal("healthUnhealthy");
    });

    it("the container health enum covers every label the adapter can write", () => {
      const written = new Set([...CONTAINER_HEALTH_LABELS, CONTAINER_HEALTH_UNKNOWN]);
      expect(new Set(Object.keys(containerHealthStates()))).to.deep.equal(written);
      // …and the mapping itself: index → word, out-of-range → unknown.
      expect(containerHealthLabel(0)).to.equal("none");
      expect(containerHealthLabel(2)).to.equal("healthy");
      expect(containerHealthLabel(2.5)).to.equal("healthy");
      expect(containerHealthLabel(9)).to.equal(CONTAINER_HEALTH_UNKNOWN);
      expect(containerHealthLabel(-1)).to.equal(CONTAINER_HEALTH_UNKNOWN);
    });

    it("container health is a status datapoint like the other two, not plain text", async () => {
      await manager.updateSystem(testSystem, testStats, testContainers, allMetricsConfig());
      const id = [...adapter.objects.keys()].find(k => /\.containers\.[^.]+\.health$/.test(k))!;
      const common = adapter.objects.get(id)!.common as { role?: string; states?: Record<string, string> };
      expect(common.role, "the adapter knows this value set — it belongs on info.status").to.equal("info.status");
      expect(common.states?.healthy).to.equal("healthHealthy");
    });
  });

  // -----------------------------------------------------------------------
  // v0.16.0 — every dynamic channel has a cleanup rule
  // -----------------------------------------------------------------------

  describe("channel cleanup completeness (v0.16.0)", () => {
    it("switching every metric off leaves no channel behind but info", async () => {
      // The end-to-end form of the rule the two toggle tables express. A new dynamic
      // group that nobody wired into a cleanup table fails here — which is what used to
      // need a seventh hand-written `if`.
      const all = allMetricsConfig({
        metrics_containers: true,
        metrics_gpu: true,
        metrics_gpuDetails: true,
        metrics_extraFs: true,
        metrics_networkInterfaces: true,
        metrics_cpuCores: true,
        metrics_zfs: true,
      });
      await manager.snapshotExistingStates();
      await manager.updateSystem(
        testSystem,
        { ...richStats(), z: { tank: { d: 100, du: 50, rb: 1, wb: 1, h: "ONLINE" } } },
        testContainers,
        all,
      );
      const before = [...adapter.objects.keys()].filter(
        id => id.startsWith("systems.my_server.") && adapter.objects.get(id)!.type === "channel",
      );
      expect(before.length, "the fixture must build a fully populated tree").to.be.greaterThan(8);

      await manager.cleanupMetrics("my_server", noMetricsConfig());
      const left = [...adapter.objects.keys()].filter(
        id => id.startsWith("systems.my_server.") && adapter.objects.get(id)!.type === "channel",
      );
      expect(left, "channels without a cleanup rule").to.deep.equal(["systems.my_server.info"]);
    });
  });

  describe("deleteChannelIfExists", () => {
    it("leaves a debug breadcrumb instead of throwing when the broker refuses", async () => {
      adapter.objects.set("systems.my_server.gpu", { type: "channel", common: {}, native: {} });
      await manager.snapshotExistingStates();
      const debugs: string[] = [];
      adapter.log.debug = (msg: string): void => {
        debugs.push(msg);
      };
      adapter.delObjectAsync = (): Promise<void> => {
        return Promise.reject(new Error("broker is shutting down"));
      };
      // Must not reject — cleanupMetrics runs during startup and a broker hiccup
      // may not abort the whole boot.
      await manager.cleanupMetrics("my_server", allMetricsConfig({ metrics_gpu: false }));
      expect(debugs.some(d => d.includes("deleteChannelIfExists") && d.includes("broker is shutting down"))).to.equal(
        true,
      );
    });
  });

  describe("preserve option", () => {
    it("extendObject passes preserve option for devices", async () => {
      const adapter = createMockAdapter();
      const calls: any[][] = [];
      const origExtend = adapter.extendObject;
      adapter.extendObject = async (...args: any[]): Promise<void> => {
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
      const safeId = internals(manager).sanitize(longName);
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

  // -----------------------------------------------------------------------
  // F1 — every dynamic group has a startup cleanup path (regression lock)
  // -----------------------------------------------------------------------

  describe("F1: each dynamic group is pruned when its toggle is turned off at startup", () => {
    // Locks the hand-coded cleanupMetrics branches against drift — the v0.7.2
    // gpuDetails bug was exactly a missing cleanup branch. Adding a new dynamic
    // group means adding a row here AND the matching cleanupMetrics branch.
    const groups: Array<{ toggle: keyof AdapterConfig; channel: string; stats: Partial<SystemStats> }> = [
      { toggle: "metrics_cpuCores", channel: "cpu.cores", stats: { cpus: [10, 20] } },
      { toggle: "metrics_networkInterfaces", channel: "network.interfaces", stats: { ni: { eth0: [1, 2, 3, 4] } } },
      { toggle: "metrics_temperatureDetails", channel: "temperature.sensors", stats: { t: { cpu_pkg: 50 } } },
      { toggle: "metrics_gpu", channel: "gpu", stats: { g: { gpu0: { n: "GPU", u: 10 } } } },
      { toggle: "metrics_extraFs", channel: "filesystems", stats: { efs: { "/mnt": { d: 100, du: 50 } } } },
      { toggle: "metrics_containers", channel: "containers", stats: {} },
    ];

    for (const g of groups) {
      it(`removes '${g.channel}' when ${g.toggle} is off`, async () => {
        const containers: BeszelContainer[] =
          g.toggle === "metrics_containers"
            ? [
                {
                  id: "c1",
                  system: testSystem.id,
                  name: "nginx",
                  status: "running",
                  health: 2,
                  cpu: 1,
                  memory: 1,
                  image: "n",
                },
              ]
            : [];
        await manager.updateSystem(
          testSystem,
          { ...testStats, ...g.stats },
          containers,
          allMetricsConfig({ [g.toggle]: true }),
        );
        expect(adapter.objects.has(`systems.my_server.${g.channel}`), `${g.channel} should be created`).to.be.true;

        await manager.cleanupMetrics("my_server", allMetricsConfig({ [g.toggle]: false }));
        expect(adapter.objects.has(`systems.my_server.${g.channel}`), `${g.channel} should be cleaned up`).to.be.false;
      });
    }
  });

  // -----------------------------------------------------------------------
  // DP — standard-role alignment (value.battery / value.power / info.status)
  // -----------------------------------------------------------------------

  describe("DP: standard-role alignment", () => {
    it("battery.percent uses value.battery, GPU power uses value.power", async () => {
      const stats: SystemStats = { ...testStats, bat: [80, 3], g: { gpu0: { n: "GPU", u: 10, p: 100, pp: 120 } } };
      await manager.updateSystem(testSystem, stats, [], allMetricsConfig({ metrics_gpuDetails: true }));
      expect(adapter.objects.get("systems.my_server.battery.percent")?.common.role).to.equal("value.battery");
      expect(adapter.objects.get("systems.my_server.gpu.gpu0.power")?.common.role).to.equal("value.power");
      expect(adapter.objects.get("systems.my_server.gpu.gpu0.power_package")?.common.role).to.equal("value.power");
    });

    it("info.status uses the info.status role and a common.states map", async () => {
      await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
      const status = adapter.objects.get("systems.my_server.info.status");
      expect(status?.common.role).to.equal("info.status");
      // v0.16.0: KEYS are the technical values the state carries, LABELS are translated
      // plain strings (the mock answers a translation with its key).
      expect(status?.common.states).to.deep.equal({
        up: "stateUp",
        down: "stateDown",
        paused: "statePaused",
        pending: "statePending",
        // The adapter's own fifth value — the Hub never sends it; it is what the
        // datapoint says while nobody is reading (adapter stopped / Hub unreachable).
        unknown: "stateUnknown",
      });
    });
  });

  // -----------------------------------------------------------------------
  // Datapoint change counters (v0.11.0) — the numbers behind the
  // "Object tree updated: created N, removed M datapoint(s)" log line.
  // -----------------------------------------------------------------------

  describe("datapoint change counters (v0.11.0)", () => {
    /** Simulate an adapter restart: fresh manager over the SAME object store. */
    async function restart(): Promise<StateManager> {
      const fresh = new StateManager(adapter as never);
      await fresh.snapshotExistingStates();
      return fresh;
    }

    it("counts every state of a first-ever run as created", async () => {
      await manager.snapshotExistingStates();
      await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
      const { created, removed } = manager.takeChangeCounts();
      expect(created).to.equal(adapter.states.size);
      expect(created).to.be.greaterThan(0);
      expect(removed).to.equal(0);
    });

    it("counts nothing on a second poll — the states already exist", async () => {
      await manager.snapshotExistingStates();
      await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
      manager.takeChangeCounts();
      await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
      expect(manager.takeChangeCounts()).to.deep.equal({ created: 0, removed: 0 });
    });

    it("counts nothing after a plain restart, despite the every-restart role retrofit", async () => {
      await manager.snapshotExistingStates();
      await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
      manager.takeChangeCounts();

      // The retrofit extendObject runs again on a fresh process (createdIds is
      // empty) — it must NOT be reported as newly created datapoints.
      const afterRestart = await restart();
      await afterRestart.updateSystem(testSystem, testStats, [], allMetricsConfig());
      expect(afterRestart.takeChangeCounts()).to.deep.equal({ created: 0, removed: 0 });
    });

    it("counts only the genuinely new datapoints when a toggle is switched on", async () => {
      const off = allMetricsConfig({ metrics_fans: false });
      await manager.snapshotExistingStates();
      await manager.updateSystem(testSystem, { ...testStats, f: { cpu_fan: 900, case_fan: 700 } }, [], off);
      manager.takeChangeCounts();

      const afterRestart = await restart();
      await afterRestart.updateSystem(
        testSystem,
        { ...testStats, f: { cpu_fan: 900, case_fan: 700 } },
        [],
        allMetricsConfig(),
      );
      expect(afterRestart.takeChangeCounts()).to.deep.equal({ created: 2, removed: 0 });
    });

    it("counts the datapoints a switched-off toggle removes at startup", async () => {
      await manager.snapshotExistingStates();
      const twoFans: SystemStats = { ...testStats, f: { cpu_fan: 900, case_fan: 700 } };
      await manager.updateSystem(testSystem, twoFans, [], allMetricsConfig());
      manager.takeChangeCounts();

      // Toggle off → restart → the startup cleanup removes the fan channel.
      const afterRestart = await restart();
      await afterRestart.cleanupMetrics("my_server", allMetricsConfig({ metrics_fans: false }));
      expect(afterRestart.takeChangeCounts()).to.deep.equal({ created: 0, removed: 2 });
    });

    it("removes the ZFS pools with their channel when the toggle is switched off (v0.15.0)", async () => {
      await manager.snapshotExistingStates();
      const pools: SystemStats = { ...testStats, z: { tank: { d: 100, du: 50, rb: 0, wb: 0, h: "ONLINE" } } };
      await manager.updateSystem(testSystem, pools, [], allMetricsConfig());
      manager.takeChangeCounts();

      // Same shape as the fans: the channel holds only dynamic children, so the
      // toggle-off cleanup must delete the whole `zfs` channel — six pool states go.
      const afterRestart = await restart();
      await afterRestart.cleanupMetrics("my_server", allMetricsConfig({ metrics_zfs: false }));
      expect(afterRestart.takeChangeCounts()).to.deep.equal({ created: 0, removed: 6 });
    });

    it("counts the SCALAR datapoints a switched-off toggle removes at startup", async () => {
      // The fan test above exercises the recursive (channel) path; the per-state
      // delete in cleanupMetrics has its own counter call — unguarded until now.
      await manager.snapshotExistingStates();
      await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
      manager.takeChangeCounts();

      const afterRestart = await restart();
      // Uptime off: exactly the two scalar states info.uptime + info.uptime_text go,
      // and the info channel itself is never deleted — no recursive removal involved.
      await afterRestart.cleanupMetrics("my_server", allMetricsConfig({ metrics_uptime: false }));
      expect(afterRestart.takeChangeCounts()).to.deep.equal({ created: 0, removed: 2 });
    });

    it("counts every datapoint lost with a system that disappeared from the Hub", async () => {
      await manager.snapshotExistingStates();
      await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
      const created = manager.takeChangeCounts().created;

      await manager.cleanupSystems([]);
      expect(manager.takeChangeCounts()).to.deep.equal({ created: 0, removed: created });
    });

    it("counts a pruned dynamic child (a fan that vanished)", async () => {
      await manager.snapshotExistingStates();
      const twoFans: SystemStats = { ...testStats, f: { cpu_fan: 900, case_fan: 700 } };
      await manager.updateSystem(testSystem, twoFans, [], allMetricsConfig());
      manager.takeChangeCounts();

      await manager.updateSystem(testSystem, { ...testStats, f: { cpu_fan: 900 } }, [], allMetricsConfig());
      expect(manager.takeChangeCounts()).to.deep.equal({ created: 0, removed: 1 });
    });

    it("counts a re-appearing datapoint as created again", async () => {
      await manager.snapshotExistingStates();
      await manager.updateSystem(testSystem, { ...testStats, f: { cpu_fan: 900 } }, [], allMetricsConfig());
      await manager.updateSystem(testSystem, { ...testStats, f: {} }, [], allMetricsConfig());
      await manager.updateSystem(testSystem, { ...testStats, f: {} }, [], allMetricsConfig()); // pruned now
      manager.takeChangeCounts();

      await manager.updateSystem(testSystem, { ...testStats, f: { cpu_fan: 950 } }, [], allMetricsConfig());
      expect(manager.takeChangeCounts()).to.deep.equal({ created: 1, removed: 0 });
    });

    it("takeChangeCounts resets, so each log line reports one batch only", async () => {
      await manager.snapshotExistingStates();
      await manager.updateSystem(testSystem, testStats, [], allMetricsConfig());
      expect(manager.takeChangeCounts().created).to.be.greaterThan(0);
      expect(manager.takeChangeCounts()).to.deep.equal({ created: 0, removed: 0 });
    });

    it("leaves the legacy REMOVALS out — the migration reports its own total", async () => {
      // A pre-0.3.0 install: flat states plus the old `temperatures` channel.
      adapter.objects.set("systems.my_server", { type: "device", common: {}, native: {} });
      adapter.objects.set("systems.my_server.cpu_usage", { type: "state", common: {}, native: {} });
      adapter.objects.set("systems.my_server.temperatures", { type: "channel", common: {}, native: {} });
      adapter.objects.set("systems.my_server.temperatures.core_0", { type: "state", common: {}, native: {} });

      const fresh = await restart();
      await fresh.migrateLegacyStates(["my_server"]);
      // The two legacy states it deleted are NOT in the counter — they belong to
      // the migration's own "removed N legacy state(s)" line. Nothing else moved.
      expect(fresh.takeChangeCounts()).to.deep.equal({ created: 0, removed: 0 });
    });

    it("stays silent on an install that never had legacy states", async () => {
      await manager.snapshotExistingStates();
      await manager.migrateLegacyStates([]);
      expect(manager.takeChangeCounts()).to.deep.equal({ created: 0, removed: 0 });

      const afterRestart = await restart();
      await afterRestart.migrateLegacyStates([]);
      expect(afterRestart.takeChangeCounts()).to.deep.equal({ created: 0, removed: 0 });
    });
  });
});

describe("markAllOffline / knownSystemIds", () => {
  it("resets every known system's info.online to false", async () => {
    const adapter = createMockAdapter();
    const { objects, states } = adapter;
    const sm = new StateManager(adapter as never);
    objects.set("systems.server_a.info.online", { type: "state", common: {}, native: {} });
    objects.set("systems.server_b.info.online", { type: "state", common: {}, native: {} });
    states.set("systems.server_a.info.online", { val: true, ack: true });
    states.set("systems.server_b.info.online", { val: true, ack: true });
    await sm.snapshotExistingStates();

    await sm.markAllOffline();

    expect(states.get("systems.server_a.info.online")).toEqual({ val: false, ack: true });
    expect(states.get("systems.server_b.info.online")).toEqual({ val: false, ack: true });
  });

  it("never writes an online state that has no object behind it", async () => {
    const adapter = createMockAdapter();
    const { states } = adapter;
    const sm = new StateManager(adapter as never);
    await sm.snapshotExistingStates();

    await sm.markAllOffline();

    expect(states.size).to.equal(0);
  });

  it("takes the fleet rollup down with it, but only where the states exist", async () => {
    const adapter = createMockAdapter();
    const { objects, states } = adapter;
    const sm = new StateManager(adapter as never);
    objects.set("info.systemsOnline", { type: "state", common: {}, native: {} });
    objects.set("info.systemsAllUp", { type: "state", common: {}, native: {} });
    await sm.snapshotExistingStates();

    await sm.markAllOffline();

    expect(states.get("info.systemsOnline")).toEqual({ val: 0, ack: true });
    expect(states.get("info.systemsAllUp")).toEqual({ val: false, ack: true });
    // systemsTotal stays: the last known count is still the best estimate.
    expect(states.has("info.systemsTotal")).toBe(false);
  });

  it("leaves every other state untouched", async () => {
    const adapter = createMockAdapter();
    const { objects, states } = adapter;
    const sm = new StateManager(adapter as never);
    objects.set("systems.server_a.info.online", { type: "state", common: {}, native: {} });
    objects.set("systems.server_a.cpu.usage", { type: "state", common: {}, native: {} });
    states.set("systems.server_a.cpu.usage", { val: 42, ack: true });
    await sm.snapshotExistingStates();

    await sm.markAllOffline();

    expect(states.get("systems.server_a.cpu.usage")).toEqual({ val: 42, ack: true });
  });

  it("knownSystemIds returns the state prefixes resolved for the current poll", () => {
    const adapter = createMockAdapter();
    const sm = new StateManager(adapter as never);
    sm.prepareForPoll([
      { id: "s1", name: "Server A", status: "up", host: "h1", info: {} },
      { id: "s2", name: "Server B", status: "up", host: "h2", info: {} },
    ]);

    expect(sm.knownSystemIds().sort()).toEqual(["systems.server_a", "systems.server_b"]);
  });

  it("knownSystemIds skips a system whose name sanitizes to nothing", () => {
    const adapter = createMockAdapter();
    const sm = new StateManager(adapter as never);
    sm.prepareForPoll([{ id: "s1", name: "***", status: "up", host: "h1", info: {} }]);

    expect(sm.knownSystemIds()).toEqual([]);
  });
});

describe("info.status carries its own 'unknown'", () => {
  it("resets the status of every known system and retrofits the enum", async () => {
    const adapter = createMockAdapter();
    const { objects, states } = adapter;
    const sm = new StateManager(adapter as never);
    objects.set("systems.server_a.info.status", {
      type: "state",
      // The four-value enum an install from an earlier version still carries.
      common: { states: { up: "Online", down: "Offline", paused: "Paused", pending: "Pending" } },
      native: {},
    });
    states.set("systems.server_a.info.status", { val: "up", ack: true });
    await sm.snapshotExistingStates();

    await sm.markAllOffline();

    expect(states.get("systems.server_a.info.status")).toEqual({ val: "unknown", ack: true });
    expect(objects.get("systems.server_a.info.status")?.common.states).to.have.property("unknown");
  });

  it("offers the value on the states the update path creates", async () => {
    const adapter = createMockAdapter();
    const { objects } = adapter;
    const sm = new StateManager(adapter as never);

    await sm.updateSystem(
      { id: "s1", name: "Server A", status: "up", host: "h", info: {} },
      undefined,
      [],
      noMetricsConfig(),
    );

    expect(objects.get("systems.server_a.info.status")?.common.states).to.have.property("unknown");
  });
});
