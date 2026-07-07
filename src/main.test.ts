import { vi } from "vitest";

// Stub the adapter-core base so BeszelAdapter can be instantiated without the
// ioBroker runtime. Methods main.ts uses are vi.fn / trivial impls; tests
// drive the private methods directly and assert on the injected fakes.
vi.mock("@iobroker/adapter-core", () => {
  class Adapter {
    public log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
    public namespace = "beszel.0";
    public adapterDir = "/tmp";
    public config: Record<string, unknown> = {};
    public on = vi.fn();
    public setStateAsync = vi.fn(async () => {});
    public setState = vi.fn(async () => {});
    public setStateChangedAsync = vi.fn(async () => {});
    public setInterval = vi.fn(() => ({}) as unknown);
    public clearInterval = vi.fn();
    public setTimeout = vi.fn(() => ({}) as unknown);
    public clearTimeout = vi.fn();
    public delay = vi.fn(async () => {});
    public sendTo = vi.fn();
    public extendForeignObjectAsync = vi.fn(async () => {});
    constructor(_opts: unknown) {}
  }
  return {
    Adapter,
    I18n: {
      init: vi.fn(async () => {}),
      getTranslatedObject: (k: string) => ({ en: k }),
      translate: (k: string) => k,
    },
  };
});

import { BeszelAdapter } from "./main";
import type { BeszelSystem, SystemDetails, SystemStats } from "./lib/types";

interface FakeClient {
  getSystems: ReturnType<typeof vi.fn>;
  getContainers: ReturnType<typeof vi.fn>;
  getLatestStats: ReturnType<typeof vi.fn>;
  getSystemDetails: ReturnType<typeof vi.fn>;
  invalidateToken: ReturnType<typeof vi.fn>;
  cancelAll: ReturnType<typeof vi.fn>;
}

interface FakeStateMgr {
  migrateLegacyStates: ReturnType<typeof vi.fn>;
  getExistingSystemNames: ReturnType<typeof vi.fn>;
  cleanupMetrics: ReturnType<typeof vi.fn>;
  prepareForPoll: ReturnType<typeof vi.fn>;
  updateSystem: ReturnType<typeof vi.fn>;
  cleanupSystems: ReturnType<typeof vi.fn>;
}

function makeSystem(overrides: Partial<BeszelSystem> = {}): BeszelSystem {
  return { id: "sys001", name: "Server A", status: "up", host: "10.0.0.1", info: {}, ...overrides };
}

function errnoError(message: string, code: string): NodeJS.ErrnoException {
  const err = new Error(message) as NodeJS.ErrnoException;
  err.code = code;
  return err;
}

/** Typed access to the private fields/methods the orchestration tests drive. */
function internalOf(adapter: BeszelAdapter): {
  client: FakeClient | null;
  stateManager: FakeStateMgr | null;
  isPolling: boolean;
  lastSystemCount: number;
  lastErrorCode: string;
  authFailCount: number;
  failedSystems: Set<string>;
  systemDetails: Map<string, SystemDetails>;
  detailsAttempted: Set<string>;
  testClients: Set<{ cancelAll: () => void }>;
  pollTimer: unknown;
  config: Record<string, unknown>;
  log: {
    debug: ReturnType<typeof vi.fn>;
    info: ReturnType<typeof vi.fn>;
    warn: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
  setStateAsync: ReturnType<typeof vi.fn>;
  setState: ReturnType<typeof vi.fn>;
  setStateChangedAsync: ReturnType<typeof vi.fn>;
  setInterval: ReturnType<typeof vi.fn>;
  clearInterval: ReturnType<typeof vi.fn>;
  extendForeignObjectAsync: ReturnType<typeof vi.fn>;
  sendTo: ReturnType<typeof vi.fn>;
  classifyError: (err: unknown) => string;
  onReady: () => Promise<void>;
  onUnload: (cb: () => void) => void;
  onMessage: (obj: unknown) => Promise<void>;
  poll: () => Promise<void>;
} {
  return adapter as unknown as ReturnType<typeof internalOf>;
}

/** Build an adapter with fake client/stateManager factories + valid config. */
function setup(configOverrides: Record<string, unknown> = {}): {
  adapter: BeszelAdapter;
  client: FakeClient;
  stateMgr: FakeStateMgr;
} {
  const adapter = new BeszelAdapter();
  const i = internalOf(adapter);
  i.config.url = "http://192.168.1.5:8090";
  i.config.username = "admin";
  i.config.password = "secret";
  i.config.pollInterval = 60;
  Object.assign(i.config, configOverrides);

  const client: FakeClient = {
    getSystems: vi.fn(async () => [makeSystem()]),
    getContainers: vi.fn(async () => []),
    getLatestStats: vi.fn(async () => new Map<string, SystemStats>([["sys001", { cpu: 10 }]])),
    getSystemDetails: vi.fn(async () => new Map<string, SystemDetails>()),
    invalidateToken: vi.fn(),
    cancelAll: vi.fn(),
  };
  const stateMgr: FakeStateMgr = {
    migrateLegacyStates: vi.fn(async () => {}),
    getExistingSystemNames: vi.fn(async () => []),
    cleanupMetrics: vi.fn(async () => {}),
    prepareForPoll: vi.fn(),
    updateSystem: vi.fn(async () => {}),
    cleanupSystems: vi.fn(async () => {}),
  };
  const internal = adapter as unknown as {
    makeClient: () => FakeClient;
    makeStateManager: () => FakeStateMgr;
  };
  internal.makeClient = () => client;
  internal.makeStateManager = () => stateMgr;
  return { adapter, client, stateMgr };
}

/** setup() + onReady() so client/stateManager are wired like in production. */
async function setupReady(configOverrides: Record<string, unknown> = {}): Promise<{
  adapter: BeszelAdapter;
  client: FakeClient;
  stateMgr: FakeStateMgr;
}> {
  const ctx = setup(configOverrides);
  await internalOf(ctx.adapter).onReady();
  return ctx;
}

describe("BeszelAdapter classifyError", () => {
  const cases: Array<[string, unknown, string]> = [
    ["UNAUTHORIZED code", errnoError("401", "UNAUTHORIZED"), "UNAUTHORIZED"],
    ["FORBIDDEN code", errnoError("403", "FORBIDDEN"), "FORBIDDEN"],
    ["RATE_LIMITED code", errnoError("429", "RATE_LIMITED"), "RATE_LIMITED"],
    ["ENOTFOUND", errnoError("dns", "ENOTFOUND"), "NETWORK"],
    ["ECONNREFUSED", errnoError("refused", "ECONNREFUSED"), "NETWORK"],
    ["ECONNRESET", errnoError("reset", "ECONNRESET"), "NETWORK"],
    ["ENETUNREACH", errnoError("net", "ENETUNREACH"), "NETWORK"],
    ["EHOSTUNREACH", errnoError("host", "EHOSTUNREACH"), "NETWORK"],
    ["EAI_AGAIN", errnoError("dns-temp", "EAI_AGAIN"), "NETWORK"],
    ["ETIMEDOUT", errnoError("slow", "ETIMEDOUT"), "TIMEOUT"],
    // N6: the client's own timeout now carries ETIMEDOUT (see above); a bare
    // "timed out" message with no code is no longer special-cased → UNKNOWN.
    ["timed-out message without a code", new Error("Request to /api timed out"), "UNKNOWN"],
    ["other errno code", errnoError("denied", "EACCES"), "EACCES"],
    ["Error without code", new Error("weird"), "UNKNOWN"],
    ["non-Error value", "boom", "UNKNOWN"],
    ["null", null, "UNKNOWN"],
  ];
  for (const [label, err, expected] of cases) {
    it(`classifies ${label} as ${expected}`, () => {
      const { adapter } = setup();
      expect(internalOf(adapter).classifyError(err)).to.equal(expected);
    });
  }
});

describe("BeszelAdapter onReady", () => {
  it("refuses to start without url/username/password (upgrade hint)", async () => {
    const { adapter, client } = setup({ url: "" });
    const i = internalOf(adapter);
    await i.onReady();
    expect(i.log.error).toHaveBeenCalledWith(expect.stringContaining("URL, username, and password are required"));
    expect(i.client).toBeNull();
    expect(client.getSystems).not.toHaveBeenCalled();
  });

  it("refuses to start on an invalid hub URL", async () => {
    const { adapter } = setup({ url: "ftp://nope" });
    const i = internalOf(adapter);
    await i.onReady();
    expect(i.log.error).toHaveBeenCalledWith(expect.stringContaining("invalid"));
    expect(i.client).toBeNull();
  });

  it("happy path: migrates, cleans existing systems' metrics, polls once, schedules the interval", async () => {
    const { adapter, client, stateMgr } = setup();
    const i = internalOf(adapter);
    stateMgr.getExistingSystemNames.mockResolvedValue(["server_a", "old_box"]);
    await i.onReady();

    expect(stateMgr.migrateLegacyStates).toHaveBeenCalledTimes(1);
    expect(stateMgr.cleanupMetrics).toHaveBeenCalledTimes(2);
    expect(client.getSystems).toHaveBeenCalledTimes(1); // first poll ran
    expect(i.setInterval).toHaveBeenCalledTimes(1);
    expect(i.log.info).toHaveBeenCalledWith(expect.stringContaining("polling every 60s"));
  });

  it("reports disconnected at start (info.connection false before the first poll)", async () => {
    const { adapter } = setup();
    const i = internalOf(adapter);
    await i.onReady();
    expect(i.setStateChangedAsync.mock.calls[0]).toEqual(["info.connection", { val: false, ack: true }]);
  });

  it("catches a failing boot step instead of crashing (boundary try/catch)", async () => {
    const { adapter, stateMgr } = setup();
    const i = internalOf(adapter);
    stateMgr.migrateLegacyStates.mockRejectedValue(new Error("db down"));
    await i.onReady();
    expect(i.log.error).toHaveBeenCalledWith(expect.stringContaining("onReady failed: db down"));
  });

  it("SEC-3b: warns when the Hub URL is plain http to a remote host", async () => {
    const { adapter } = await setupReady(); // default url = http://192.168.1.5:8090 (remote http)
    expect(internalOf(adapter).log.warn).toHaveBeenCalledWith(expect.stringContaining("cleartext"));
  });

  it("SEC-3b: does NOT warn for https or loopback http", async () => {
    const https = await setupReady({ url: "https://192.168.1.5:8090" });
    expect(internalOf(https.adapter).log.warn).not.toHaveBeenCalledWith(expect.stringContaining("cleartext"));
    const loopback = await setupReady({ url: "http://localhost:8090" });
    expect(internalOf(loopback.adapter).log.warn).not.toHaveBeenCalledWith(expect.stringContaining("cleartext"));
  });
});

describe("BeszelAdapter onUnload", () => {
  it("clears the poll timer, cancels prod + test clients and always calls back", async () => {
    const { adapter, client } = await setupReady();
    const i = internalOf(adapter);
    const testClient = { cancelAll: vi.fn() };
    i.testClients.add(testClient);

    const callback = vi.fn();
    i.onUnload(callback);

    expect(i.clearInterval).toHaveBeenCalled();
    expect(i.pollTimer).toBeUndefined();
    expect(client.cancelAll).toHaveBeenCalled();
    expect(testClient.cancelAll).toHaveBeenCalled();
    expect(i.testClients.size).toBe(0);
    expect(callback).toHaveBeenCalledTimes(1);
  });

  it("still calls back when cleanup throws (debug breadcrumb only)", async () => {
    const { adapter, client } = await setupReady();
    const i = internalOf(adapter);
    client.cancelAll.mockImplementation(() => {
      throw new Error("already closed");
    });
    const callback = vi.fn();
    i.onUnload(callback);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(i.log.debug).toHaveBeenCalledWith(expect.stringContaining("onUnload error"));
  });
});

describe("BeszelAdapter poll — happy path", () => {
  it("updates every system, marks connected and resolves safeNames first", async () => {
    const { adapter, client, stateMgr } = await setupReady();
    const i = internalOf(adapter);
    const sysA = makeSystem();
    const sysB = makeSystem({ id: "sys002", name: "Server B" });
    client.getSystems.mockResolvedValue([sysA, sysB]);
    stateMgr.updateSystem.mockClear();

    await i.poll();

    expect(stateMgr.prepareForPoll).toHaveBeenCalledWith([sysA, sysB]);
    expect(stateMgr.updateSystem).toHaveBeenCalledTimes(2);
    expect(i.setStateChangedAsync).toHaveBeenCalledWith("info.connection", { val: true, ack: true });
    expect(i.lastSystemCount).toBe(2);
  });

  it("skips overlapping polls (in-flight guard)", async () => {
    const { adapter, client } = await setupReady();
    const i = internalOf(adapter);
    let release!: (v: BeszelSystem[]) => void;
    client.getSystems.mockImplementationOnce(
      () =>
        new Promise<BeszelSystem[]>(resolve => {
          release = resolve;
        }),
    );
    const first = i.poll();
    await i.poll(); // must bail out via isPolling
    expect(i.log.debug).toHaveBeenCalledWith(expect.stringContaining("previous poll still running"));
    release([]);
    await first;
  });

  it("fetches containers only when the toggle is on", async () => {
    const { adapter, client } = await setupReady({ metrics_containers: false });
    client.getContainers.mockClear();
    await internalOf(adapter).poll();
    expect(client.getContainers).not.toHaveBeenCalled();

    const on = await setupReady({ metrics_containers: true });
    await internalOf(on.adapter).poll();
    expect(on.client.getContainers).toHaveBeenCalled();
  });
});

describe("BeszelAdapter poll — per-system failure dedup", () => {
  it("warns on the first failure, demotes repeats to debug, clears on success", async () => {
    const { adapter, stateMgr } = await setupReady();
    const i = internalOf(adapter);
    stateMgr.updateSystem.mockRejectedValue(new Error("redis hiccup"));

    await i.poll();
    expect(i.log.warn).toHaveBeenCalledWith(expect.stringContaining("Failed to update system 'Server A'"));
    expect(i.failedSystems.has("sys001")).toBe(true);

    i.log.warn.mockClear();
    await i.poll();
    expect(i.log.warn).not.toHaveBeenCalled(); // repeat → debug
    expect(i.log.debug).toHaveBeenCalledWith(expect.stringContaining("Failed to update system 'Server A'"));

    stateMgr.updateSystem.mockResolvedValue(undefined);
    await i.poll();
    expect(i.failedSystems.has("sys001")).toBe(false);
  });

  it("one bad system does not poison the others", async () => {
    const { adapter, client, stateMgr } = await setupReady();
    const i = internalOf(adapter);
    const sysA = makeSystem();
    const sysB = makeSystem({ id: "sys002", name: "Server B" });
    client.getSystems.mockResolvedValue([sysA, sysB]);
    stateMgr.updateSystem.mockImplementation(async (system: BeszelSystem) => {
      if (system.id === "sys001") {
        throw new Error("bad records");
      }
    });

    await i.poll();
    expect(i.failedSystems.has("sys001")).toBe(true);
    expect(i.failedSystems.has("sys002")).toBe(false);
    expect(i.setStateChangedAsync).toHaveBeenCalledWith("info.connection", { val: true, ack: true });
  });
});

describe("BeszelAdapter poll — error classification routing", () => {
  it("UNAUTHORIZED invalidates the token and escalates: 3× error, then suppression notice, then debug", async () => {
    const { adapter, client } = await setupReady();
    const i = internalOf(adapter);
    client.getSystems.mockRejectedValue(errnoError("401", "UNAUTHORIZED"));

    for (let n = 1; n <= 3; n++) {
      i.log.error.mockClear();
      await i.poll();
      expect(client.invalidateToken).toHaveBeenCalled();
      expect(i.log.error).toHaveBeenCalledWith(expect.stringContaining("Authentication failed"));
    }
    i.log.error.mockClear();
    await i.poll(); // 4th
    expect(i.log.error).toHaveBeenCalledWith(expect.stringContaining("suppressing further auth errors"));
    i.log.error.mockClear();
    await i.poll(); // 5th
    expect(i.log.error).not.toHaveBeenCalled();
    expect(i.log.debug).toHaveBeenCalledWith(expect.stringContaining("Auth still failing (attempt 5)"));
  });

  it("auth-fail counter resets after a successful poll", async () => {
    const { adapter, client } = await setupReady();
    const i = internalOf(adapter);
    client.getSystems.mockRejectedValueOnce(errnoError("401", "UNAUTHORIZED"));
    await i.poll();
    expect(i.authFailCount).toBe(1);
    await i.poll(); // succeeds again
    expect(i.authFailCount).toBe(0);
  });

  it("FORBIDDEN surfaces the check-user-role hint", async () => {
    const { adapter, client } = await setupReady();
    const i = internalOf(adapter);
    client.getSystems.mockRejectedValue(errnoError("403", "FORBIDDEN"));
    await i.poll();
    expect(i.log.error).toHaveBeenCalledWith(expect.stringContaining("Check the user role"));
  });

  it("RATE_LIMITED suggests increasing the poll interval (warn)", async () => {
    const { adapter, client } = await setupReady();
    const i = internalOf(adapter);
    client.getSystems.mockRejectedValue(errnoError("429", "RATE_LIMITED"));
    await i.poll();
    expect(i.log.warn).toHaveBeenCalledWith(expect.stringContaining("rate-limited"));
  });

  it("NETWORK errors warn once and demote repeats to debug", async () => {
    const { adapter, client } = await setupReady();
    const i = internalOf(adapter);
    client.getSystems.mockRejectedValue(errnoError("refused", "ECONNREFUSED"));
    await i.poll();
    expect(i.log.warn).toHaveBeenCalledWith(expect.stringContaining("Cannot reach Beszel Hub"));

    i.log.warn.mockClear();
    await i.poll();
    expect(i.log.warn).not.toHaveBeenCalled();
    expect(i.log.debug).toHaveBeenCalledWith(expect.stringContaining("Poll failed (ongoing)"));
  });

  it("marks disconnected on failure and logs the recovery exactly once", async () => {
    const { adapter, client } = await setupReady();
    const i = internalOf(adapter);
    client.getSystems.mockRejectedValueOnce(errnoError("refused", "ECONNREFUSED"));
    await i.poll();
    expect(i.setStateChangedAsync).toHaveBeenCalledWith("info.connection", { val: false, ack: true });

    await i.poll(); // success
    expect(i.log.info).toHaveBeenCalledWith("Connection restored");
    expect(i.lastErrorCode).toBe("");

    i.log.info.mockClear();
    await i.poll(); // steady state — no repeated restore info
    expect(i.log.info).not.toHaveBeenCalledWith("Connection restored");
  });

  it("SEC-1: a generic poll error keeps Hub content out of the error-level log", async () => {
    const { adapter, client } = await setupReady();
    const i = internalOf(adapter);
    // an HTTP_ERROR carries a Hub response-body snippet in its message.
    client.getSystems.mockRejectedValue(errnoError("HTTP 500: secret-hub-body", "HTTP_ERROR"));
    await i.poll();
    // error-level line (captured by opt-in Sentry) carries only the error class.
    expect(i.log.error).toHaveBeenCalledWith("Poll failed (HTTP_ERROR)");
    expect(i.log.error).not.toHaveBeenCalledWith(expect.stringContaining("secret-hub-body"));
    // the full detail is still available at debug for diagnostics.
    expect(i.log.debug).toHaveBeenCalledWith(expect.stringContaining("secret-hub-body"));
  });
});

describe("BeszelAdapter poll — empty-systems guard", () => {
  it("does NOT clean up devices when a transient empty list arrives", async () => {
    const { adapter, client, stateMgr } = await setupReady();
    const i = internalOf(adapter);
    await i.poll(); // lastSystemCount = 1
    stateMgr.cleanupSystems.mockClear();

    client.getSystems.mockResolvedValue([]);
    await i.poll();
    expect(stateMgr.cleanupSystems).not.toHaveBeenCalled();
  });

  it("does NOT clean up on an empty result even on the first poll after restart (F1)", async () => {
    const { adapter, client, stateMgr } = await setupReady();
    const i = internalOf(adapter);
    client.getSystems.mockResolvedValue([]);
    stateMgr.cleanupSystems.mockClear();
    i.lastSystemCount = 0; // fresh instance, e.g. right after a restart
    await i.poll();
    // F1: an empty (transient / startup) systems response must NEVER wipe the
    // existing device trees — cleanupSystems runs only on a non-empty result.
    // A genuinely empty install has nothing to clean up anyway.
    expect(stateMgr.cleanupSystems).not.toHaveBeenCalled();
  });
});

// H2: the container-prune debounce moved out of main.ts into StateManager's
// per-group pruneGroup (tested in state-manager.test.ts). main.ts no longer
// computes a skipContainerPrune flag, so its dedicated F2 test is gone.

describe("BeszelAdapter poll — system_details cadence (F2)", () => {
  it("fetches details once for a new system and attaches them", async () => {
    const { adapter, client, stateMgr } = setup({ metrics_agentVersion: true });
    const i = internalOf(adapter);
    const details: SystemDetails = { hostname: "srv-a", cores: 8 };
    client.getSystemDetails.mockResolvedValue(new Map([["sys001", details]]));

    await i.onReady(); // first poll fetches + attaches
    expect(client.getSystemDetails).toHaveBeenCalledTimes(1);
    const system = stateMgr.updateSystem.mock.calls[0][0] as BeszelSystem;
    expect(system.details).toEqual(details);

    // Steady state: same system id → no refetch.
    await i.poll();
    expect(client.getSystemDetails).toHaveBeenCalledTimes(1);
  });

  it("refetches when a never-seen system id appears", async () => {
    const { adapter, client } = await setupReady({ metrics_agentVersion: true });
    const i = internalOf(adapter);
    await i.poll();
    expect(client.getSystemDetails).toHaveBeenCalledTimes(1);

    client.getSystems.mockResolvedValue([makeSystem(), makeSystem({ id: "sysNEW", name: "Newcomer" })]);
    await i.poll();
    expect(client.getSystemDetails).toHaveBeenCalledTimes(2);
  });

  it("a failed details fetch is non-fatal and not retried every poll (attempted marker)", async () => {
    const { adapter, client, stateMgr } = setup({ metrics_agentVersion: true });
    const i = internalOf(adapter);
    client.getSystemDetails.mockRejectedValue(errnoError("404", "HTTP_ERROR"));

    await i.onReady(); // first poll hits the 404
    expect(i.log.debug).toHaveBeenCalledWith(expect.stringContaining("system_details fetch failed (non-fatal"));
    expect(stateMgr.updateSystem).toHaveBeenCalled(); // poll continued
    expect(i.setStateChangedAsync).toHaveBeenCalledWith("info.connection", { val: true, ack: true });

    await i.poll();
    expect(client.getSystemDetails).toHaveBeenCalledTimes(1); // 404'd Hub → no hammering
  });

  it("F3: a TRANSIENT details fetch error is NOT marked attempted and is retried next poll", async () => {
    const { adapter, client } = setup({ metrics_agentVersion: true });
    const i = internalOf(adapter);
    client.getSystemDetails.mockRejectedValue(errnoError("conn refused", "ECONNREFUSED"));

    await i.onReady(); // first poll: a NETWORK failure must not suppress the fetch
    expect(client.getSystemDetails).toHaveBeenCalledTimes(1);
    expect(i.detailsAttempted.size).to.equal(0); // not marked → will retry

    await i.poll(); // retries because nothing was marked attempted
    expect(client.getSystemDetails).toHaveBeenCalledTimes(2);
  });

  it("never fetches details when System info is disabled", async () => {
    const { adapter, client } = await setupReady({ metrics_agentVersion: false });
    await internalOf(adapter).poll();
    expect(client.getSystemDetails).not.toHaveBeenCalled();
  });
});

describe("BeszelAdapter poll — v0.7.2 bookkeeping pruning", () => {
  it("drops failedSystems/detailsAttempted/systemDetails entries of removed systems", async () => {
    const { adapter, client } = await setupReady({ metrics_agentVersion: true });
    const i = internalOf(adapter);
    i.failedSystems.add("Old Box");
    i.detailsAttempted.add("sysOLD");
    i.systemDetails.set("sysOLD", { hostname: "old" });

    client.getSystems.mockResolvedValue([makeSystem()]);
    await i.poll();

    expect(i.failedSystems.has("Old Box")).toBe(false);
    expect(i.detailsAttempted.has("sysOLD")).toBe(false);
    expect(i.systemDetails.has("sysOLD")).toBe(false);
    // Current system's bookkeeping survives.
    expect(i.detailsAttempted.has("sys001")).toBe(true);
  });

  it("keeps the bookkeeping when a transient empty list arrives (same guard as cleanup)", async () => {
    const { adapter, client } = await setupReady();
    const i = internalOf(adapter);
    await i.poll();
    i.failedSystems.add("Server A");

    client.getSystems.mockResolvedValue([]);
    await i.poll();
    expect(i.failedSystems.has("Server A")).toBe(true);
  });
});

describe("BeszelAdapter onMessage", () => {
  it("answers unknown commands instead of leaving the callback hanging", async () => {
    const { adapter } = await setupReady();
    const i = internalOf(adapter);
    await i.onMessage({
      command: "noSuchCommand",
      from: "system.adapter.admin.0",
      callback: { id: 1, message: "x", time: 0, ack: false },
    });
    expect(i.sendTo).toHaveBeenCalledWith(
      "system.adapter.admin.0",
      "noSuchCommand",
      { error: "Unknown command" },
      expect.anything(),
    );
  });
});
