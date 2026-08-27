import { readFileSync } from "node:fs";
import { join } from "node:path";
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
    public setObjectNotExistsAsync = vi.fn(async () => {});
    public setInterval = vi.fn(() => ({}) as unknown);
    public clearInterval = vi.fn();
    public setTimeout = vi.fn(() => ({}) as unknown);
    public clearTimeout = vi.fn();
    public delay = vi.fn(async () => {});
    public sendTo = vi.fn();
    public extendForeignObjectAsync = vi.fn(async () => {});
    public getForeignObjectAsync = vi.fn(async () => null as unknown);
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
  snapshotExistingStates: ReturnType<typeof vi.fn>;
  takeChangeCounts: ReturnType<typeof vi.fn>;
  noteStatesCreated: ReturnType<typeof vi.fn>;
  markAllOffline: ReturnType<typeof vi.fn>;
  knownSystemIds: ReturnType<typeof vi.fn>;
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
  setObjectNotExistsAsync: ReturnType<typeof vi.fn>;
  setInterval: ReturnType<typeof vi.fn>;
  clearInterval: ReturnType<typeof vi.fn>;
  extendForeignObjectAsync: ReturnType<typeof vi.fn>;
  getForeignObjectAsync: ReturnType<typeof vi.fn>;
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
  /** Args the adapter handed to its client factory (url, user, pass, timeoutMs). */
  clientArgs: unknown[][];
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
    snapshotExistingStates: vi.fn(async () => {}),
    noteStatesCreated: vi.fn(),
    markAllOffline: vi.fn(async () => {}),
    knownSystemIds: vi.fn(() => ["systems.server_a"]),
    // v0.11.0: default "nothing changed" so the datapoint line stays silent in
    // tests that don't exercise it; the counter tests override this.
    takeChangeCounts: vi.fn(() => ({ created: 0, removed: 0 })),
  };
  const clientArgs: unknown[][] = [];
  const internal = adapter as unknown as {
    makeClient: (...args: unknown[]) => FakeClient;
    makeStateManager: () => FakeStateMgr;
  };
  internal.makeClient = (...args: unknown[]) => {
    clientArgs.push(args);
    return client;
  };
  internal.makeStateManager = () => stateMgr;
  return { adapter, client, stateMgr, clientArgs };
}

/** setup() + onReady() so client/stateManager are wired like in production. */
async function setupReady(configOverrides: Record<string, unknown> = {}): Promise<{
  adapter: BeszelAdapter;
  client: FakeClient;
  stateMgr: FakeStateMgr;
  clientArgs: unknown[][];
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

  it("v0.11.0: snapshots the existing states BEFORE the first cleanup or poll", async () => {
    const { adapter, stateMgr } = setup();
    const i = internalOf(adapter);
    const order: string[] = [];
    stateMgr.snapshotExistingStates.mockImplementation(async () => {
      order.push("snapshot");
    });
    stateMgr.cleanupMetrics.mockImplementation(async () => {
      order.push("cleanup");
    });
    stateMgr.updateSystem.mockImplementation(async () => {
      order.push("poll");
    });
    stateMgr.getExistingSystemNames.mockResolvedValue(["server_a"]);
    await i.onReady();
    // Anything created or removed before the snapshot would be miscounted.
    expect(order).toEqual(["snapshot", "cleanup", "poll"]);
  });

  it("F3: fetches existing system names once and hands them to migrateLegacyStates", async () => {
    const { adapter, stateMgr } = setup();
    const i = internalOf(adapter);
    stateMgr.getExistingSystemNames.mockResolvedValue(["server_a", "old_box"]);
    await i.onReady();
    // The names are fetched once in onReady and threaded into the migration, so the
    // real StateManager needn't re-run the object view a second time on startup.
    expect(stateMgr.migrateLegacyStates).toHaveBeenCalledWith(["server_a", "old_box"]);
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

  it("the scheduled callback really polls again — not just a timer that exists", async () => {
    // Audit 2026-08-22: `setInterval` is a mock, so a test that only asserts it
    // was called leaves the recurring poll completely unguarded — gutting the
    // callback body kept all 448 tests green. Capture the callback, run it, and
    // assert a SECOND poll actually reached the client.
    const { adapter, client } = await setupReady();
    const i = internalOf(adapter);
    expect(client.getSystems).toHaveBeenCalledTimes(1); // the onReady poll
    const tick = i.setInterval.mock.calls[0][0] as () => void;
    expect(typeof tick).toBe("function");
    tick();
    await new Promise(r => setImmediate(r)); // the callback fires poll() un-awaited
    expect(client.getSystems).toHaveBeenCalledTimes(2);
  });

  it("hands the configured poll interval and request timeout to timer + client", async () => {
    // Both values used to be unverifiable: the fixture's 60 s / default 15 s
    // matched a hardcoded mutant exactly, so ignoring the user's config was
    // invisible. Non-default values make the wiring provable.
    const { adapter, clientArgs } = await setupReady({ pollInterval: 120, requestTimeout: 30 });
    const i = internalOf(adapter);
    expect(i.setInterval.mock.calls[0][1]).toBe(120_000);
    expect(clientArgs[0][3]).toBe(30_000);
    expect(i.log.info).toHaveBeenCalledWith(expect.stringContaining("polling every 120s"));
  });

  it("clamps an out-of-range poll interval before arming the timer", async () => {
    const { adapter } = await setupReady({ pollInterval: 5000 });
    expect(internalOf(adapter).setInterval.mock.calls[0][1]).toBe(300_000);
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
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));

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
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
    expect(i.log.debug).toHaveBeenCalledWith(expect.stringContaining("onUnload error"));
  });

  it("the manifest must not declare stopInstance, or none of this runs at all", () => {
    // Measured against the live js-controller 7.2.2 on 2026-08-27: with
    // `supportedMessages.stopInstance` the host sends a message and then kills the
    // process unconditionally — `onUnload` never runs and every state written while
    // shutting down is dead code. This is a property of the MANIFEST, so no amount
    // of shutdown code can defend it — only this test can.
    const manifest = JSON.parse(readFileSync(join(__dirname, "..", "io-package.json"), "utf8")) as {
      common: { supportedMessages?: Record<string, unknown> };
    };
    expect(manifest.common.supportedMessages?.stopInstance).toBeUndefined();
  });

  it("tells the controller we are done only AFTER the last state was written", async () => {
    const { adapter, stateMgr } = await setupReady();
    const i = internalOf(adapter);
    stateMgr.knownSystemIds.mockReturnValue(["systems.server_a"]);
    const order: string[] = [];
    // Resolves on a LATER turn of the event loop, like a real database round trip —
    // an `async () => push()` would record the write synchronously and the test
    // would pass even with the callback fired first.
    i.setState.mockImplementation(
      (id: string) =>
        new Promise<void>(resolve =>
          setTimeout(() => {
            order.push(`write:${id}`);
            resolve();
          }, 0),
        ),
    );
    const callback = vi.fn(() => order.push("callback"));

    i.onUnload(callback);
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));

    expect(order[order.length - 1]).toBe("callback");
    expect(order).toContain("write:systems.server_a.info.online");
    expect(order).toContain("write:systems.server_a.info.status");
    expect(order).toContain("write:info.connection");
  });

  it("calls back even when a shutdown write is rejected by a dying states database", async () => {
    const { adapter } = await setupReady();
    const i = internalOf(adapter);
    i.setState.mockRejectedValue(new Error("states db is gone"));
    const callback = vi.fn();

    i.onUnload(callback);
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
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

  it("F1: passes containersAvailable=false to updateSystem when the container fetch fails", async () => {
    const { adapter, client, stateMgr } = await setupReady({ metrics_containers: true });
    const i = internalOf(adapter);
    client.getContainers.mockRejectedValue(errnoError("403", "FORBIDDEN"));
    stateMgr.updateSystem.mockClear();

    await i.poll();

    // A failed container fetch must reach the StateManager as containersAvailable=false
    // (5th arg) so it freezes the container tree instead of pruning it.
    expect(stateMgr.updateSystem).toHaveBeenCalled();
    expect(stateMgr.updateSystem.mock.calls[0][4]).toBe(false);
  });

  it("F1: passes containersAvailable=true when the container fetch succeeds", async () => {
    const { adapter, stateMgr } = await setupReady({ metrics_containers: true });
    const i = internalOf(adapter);
    stateMgr.updateSystem.mockClear();

    await i.poll();

    expect(stateMgr.updateSystem.mock.calls[0][4]).toBe(true);
  });

  it("DP4: writes the fleet rollup — total, online and the all-up flag", async () => {
    // The rollup states were written but never asserted: blanking them out, or
    // pinning allUp to true, kept the suite green (audit 2026-08-22).
    const { adapter, client } = await setupReady();
    const i = internalOf(adapter);
    client.getSystems.mockResolvedValue([
      makeSystem(),
      makeSystem({ id: "sys002", name: "Server B", status: "down" }),
      makeSystem({ id: "sys003", name: "Server C" }),
    ]);
    await i.poll();
    expect(i.setStateChangedAsync).toHaveBeenCalledWith("info.systemsTotal", { val: 3, ack: true });
    expect(i.setStateChangedAsync).toHaveBeenCalledWith("info.systemsOnline", { val: 2, ack: true });
    expect(i.setStateChangedAsync).toHaveBeenCalledWith("info.systemsAllUp", { val: false, ack: true });
  });

  it("DP4: allUp is true only when every system reports up", async () => {
    const { adapter, client } = await setupReady();
    const i = internalOf(adapter);
    client.getSystems.mockResolvedValue([makeSystem(), makeSystem({ id: "sys002", name: "Server B" })]);
    await i.poll();
    expect(i.setStateChangedAsync).toHaveBeenCalledWith("info.systemsAllUp", { val: true, ack: true });
  });

  it("v0.11.0: reports the datapoints a poll created and removed", async () => {
    const { adapter, stateMgr } = await setupReady();
    const i = internalOf(adapter);
    stateMgr.takeChangeCounts.mockReturnValue({ created: 12, removed: 3 });
    i.log.info.mockClear();
    await i.poll();
    expect(i.log.info).toHaveBeenCalledWith("Object tree updated: created 12 datapoint(s), removed 3 datapoint(s)");
  });

  it("v0.11.0: names only the side that actually changed", async () => {
    const { adapter, stateMgr } = await setupReady();
    const i = internalOf(adapter);

    stateMgr.takeChangeCounts.mockReturnValue({ created: 4, removed: 0 });
    i.log.info.mockClear();
    await i.poll();
    expect(i.log.info).toHaveBeenCalledWith("Object tree updated: created 4 datapoint(s)");

    stateMgr.takeChangeCounts.mockReturnValue({ created: 0, removed: 7 });
    i.log.info.mockClear();
    await i.poll();
    expect(i.log.info).toHaveBeenCalledWith("Object tree updated: removed 7 datapoint(s)");
  });

  it("v0.11.0: stays silent when the object tree did not change", async () => {
    const { adapter, stateMgr } = await setupReady();
    const i = internalOf(adapter);
    stateMgr.takeChangeCounts.mockReturnValue({ created: 0, removed: 0 });
    i.log.info.mockClear();
    await i.poll();
    // A plain restart must not add a line to the user's log every minute.
    expect(i.log.info).not.toHaveBeenCalledWith(expect.stringContaining("Object tree updated"));
  });

  it("v0.11.0: the fleet rollup states count towards the datapoint total too", async () => {
    const { adapter, stateMgr } = await setupReady();
    // They are created via setObjectNotExistsAsync, outside createAndSetState —
    // without this hand-off the first-ever start would under-report by three.
    expect(stateMgr.noteStatesCreated).toHaveBeenCalledWith([
      "info.systemsTotal",
      "info.systemsOnline",
      "info.systemsAllUp",
    ]);
    const i = internalOf(adapter);
    stateMgr.noteStatesCreated.mockClear();
    await i.poll();
    expect(stateMgr.noteStatesCreated).not.toHaveBeenCalled(); // only on the create pass
  });

  it("DP4: creates the three rollup objects once, then only writes values", async () => {
    const { adapter } = await setupReady();
    const i = internalOf(adapter);
    const created = (): string[] => i.setObjectNotExistsAsync.mock.calls.map(c => c[0] as string);
    expect(created()).toEqual(["info.systemsTotal", "info.systemsOnline", "info.systemsAllUp"]);
    i.setObjectNotExistsAsync.mockClear();
    await i.poll();
    expect(i.setObjectNotExistsAsync).not.toHaveBeenCalled();
  });

  it("groups several containers of the SAME system into one list", async () => {
    const { adapter, client, stateMgr } = await setupReady({ metrics_containers: true });
    const i = internalOf(adapter);
    client.getContainers.mockResolvedValue([
      { id: "c1", system: "sys001", name: "nginx", status: "running", health: 2, cpu: 1, memory: 10, image: "n" },
      { id: "c2", system: "sys001", name: "pg", status: "running", health: 2, cpu: 1, memory: 10, image: "p" },
    ]);
    stateMgr.updateSystem.mockClear();
    await i.poll();
    const passed = stateMgr.updateSystem.mock.calls[0][2] as Array<{ id: string }>;
    expect(passed.map(c => c.id)).toEqual(["c1", "c2"]);
  });

  it("F5: passes each system only its own containers (grouped by the poll)", async () => {
    const { adapter, client, stateMgr } = await setupReady({ metrics_containers: true });
    const i = internalOf(adapter);
    client.getSystems.mockResolvedValue([makeSystem(), makeSystem({ id: "sys002", name: "Server B" })]);
    client.getContainers.mockResolvedValue([
      { id: "c1", system: "sys001", name: "nginx", status: "running", health: 2, cpu: 1, memory: 10, image: "n" },
      { id: "c2", system: "sys002", name: "pg", status: "running", health: 2, cpu: 1, memory: 10, image: "p" },
    ]);
    stateMgr.updateSystem.mockClear();

    await i.poll();

    const containersFor = (id: string): string[] => {
      const call = stateMgr.updateSystem.mock.calls.find(c => (c[0] as BeszelSystem).id === id);
      return (call?.[2] as Array<{ id: string }>).map(c => c.id);
    };
    expect(containersFor("sys001")).toEqual(["c1"]);
    expect(containersFor("sys002")).toEqual(["c2"]);
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
    // mockClear first: onReady already wrote `info.connection = false` before the
    // first poll, so without this the assertion below passes even when the error
    // path never touches the state at all (audit 2026-08-22 — the old test was
    // green with the whole write removed).
    i.setStateChangedAsync.mockClear();
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

  it("does not mark disconnected while polls keep succeeding", async () => {
    const { adapter } = await setupReady();
    const i = internalOf(adapter);
    i.setStateChangedAsync.mockClear();
    await i.poll();
    expect(i.setStateChangedAsync).not.toHaveBeenCalledWith("info.connection", { val: false, ack: true });
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

  it("F3: a TIMEOUT is transient too — retried, not marked attempted", async () => {
    // The retry guard names two transient classes; only NETWORK was covered, so
    // dropping TIMEOUT from the condition went unnoticed (audit 2026-08-22).
    const { adapter, client } = setup({ metrics_agentVersion: true });
    const i = internalOf(adapter);
    client.getSystemDetails.mockRejectedValue(errnoError("slow hub", "ETIMEDOUT"));

    await i.onReady();
    expect(i.detailsAttempted.size).to.equal(0);
    await i.poll();
    expect(client.getSystemDetails).toHaveBeenCalledTimes(2);
    expect(i.log.debug).toHaveBeenCalledWith(expect.stringContaining("willRetry=true"));
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

  it("wires checkConnection end-to-end: real test-client, registered and released again", async () => {
    // The onMessage dependency block (client factory + the two lifecycle hooks)
    // was never executed by a test — only the router was tested in isolation.
    // Port 1 refuses instantly, so this exercises the whole wiring without a
    // stub client and without a slow network wait.
    const { adapter } = await setupReady();
    const i = internalOf(adapter);
    await i.onMessage({
      command: "checkConnection",
      from: "system.adapter.admin.0",
      callback: { id: 1, message: "x", time: 0, ack: false },
      message: { url: "http://127.0.0.1:1", username: "u", password: "p" },
    });
    const [, command, response] = i.sendTo.mock.calls[0] as [string, string, { error?: string }];
    expect(command).toBe("checkConnection");
    expect(response.error, "a refused connection must surface as an error").toBeTruthy();
    // The short-lived client must be gone again — otherwise onUnload would try
    // to abort a completed client and the Set would grow without bound.
    expect(i.testClients.size).toBe(0);
  }, 10000);

  it("logs instead of crashing when the message handler itself throws", async () => {
    // A malformed payload (no `command` accessor at all) reaches the router and
    // blows up there; the boundary try/catch must turn that into one error line.
    const { adapter } = await setupReady();
    const i = internalOf(adapter);
    i.sendTo.mockImplementation(() => {
      throw new Error("broker gone");
    });
    await i.onMessage({
      command: "noSuchCommand",
      from: "system.adapter.admin.0",
      callback: { id: 1, message: "x", time: 0, ack: false },
    });
    expect(i.log.error).toHaveBeenCalledWith(expect.stringContaining("onMessage failed: broker gone"));
  });
});

describe("BeszelAdapter poll — container availability dedup (L3)", () => {
  it("warns once while the container fetch keeps failing, then traces", async () => {
    const { adapter, client } = await setupReady({ metrics_containers: true });
    const i = internalOf(adapter);
    client.getContainers.mockRejectedValue(errnoError("403", "FORBIDDEN"));

    await i.poll();
    expect(i.log.warn).toHaveBeenCalledWith(expect.stringContaining("Container fetch failed"));

    i.log.warn.mockClear();
    await i.poll();
    expect(i.log.warn).not.toHaveBeenCalled();
    expect(i.log.debug).toHaveBeenCalledWith(expect.stringContaining("Container fetch failed"));
  });

  it("reports recovery once when the container fetch works again", async () => {
    const { adapter, client } = await setupReady({ metrics_containers: true });
    const i = internalOf(adapter);
    client.getContainers.mockRejectedValueOnce(errnoError("403", "FORBIDDEN"));
    await i.poll();

    i.log.info.mockClear();
    await i.poll(); // fetch succeeds again
    expect(i.log.info).toHaveBeenCalledWith("Container data is available again");

    i.log.info.mockClear();
    await i.poll(); // steady state — no repeat
    expect(i.log.info).not.toHaveBeenCalledWith("Container data is available again");
  });

  it("does not touch the Hub when the container toggle is off (no failure state either)", async () => {
    const { adapter, client, stateMgr } = await setupReady({ metrics_containers: false });
    const i = internalOf(adapter);
    stateMgr.updateSystem.mockClear();
    await i.poll();
    expect(client.getContainers).not.toHaveBeenCalled();
    // Toggle-off is "nothing to show", not a failure → containersAvailable stays true.
    expect(stateMgr.updateSystem.mock.calls[0][4]).toBe(true);
  });
});

describe("BeszelAdapter poll — guards", () => {
  it("does nothing when the adapter never finished booting (no client)", async () => {
    const { adapter, client } = setup(); // onReady deliberately NOT run
    const i = internalOf(adapter);
    await i.poll();
    expect(client.getSystems).not.toHaveBeenCalled();
    expect(i.setStateChangedAsync).not.toHaveBeenCalled();
  });
});

describe("BeszelAdapter stale online indicators", () => {
  it("clears the online indicators at startup, after the snapshot and before the first poll", async () => {
    const { adapter, stateMgr, client } = setup();
    const order: string[] = [];
    stateMgr.snapshotExistingStates.mockImplementation(async () => {
      order.push("snapshot");
    });
    stateMgr.markAllOffline.mockImplementation(async () => {
      order.push("markAllOffline");
    });
    client.getSystems.mockImplementation(async () => {
      order.push("poll");
      return [makeSystem()];
    });

    await internalOf(adapter).onReady();

    expect(order).toEqual(["snapshot", "markAllOffline", "poll"]);
  });

  it("marks every known system offline when the adapter stops", async () => {
    const { adapter, stateMgr } = await setupReady();
    const i = internalOf(adapter);
    stateMgr.knownSystemIds.mockReturnValue(["systems.server_a", "systems.server_b"]);
    i.setState.mockClear();

    i.onUnload(vi.fn());

    expect(i.setState).toHaveBeenCalledWith("systems.server_a.info.online", { val: false, ack: true });
    expect(i.setState).toHaveBeenCalledWith("systems.server_b.info.online", { val: false, ack: true });
  });

  it("still completes the shutdown when there is no system yet", async () => {
    const { adapter, stateMgr } = await setupReady();
    const i = internalOf(adapter);
    stateMgr.knownSystemIds.mockReturnValue([]);
    const callback = vi.fn();

    i.onUnload(callback);

    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));
  });

  it("marks the systems offline when the Hub cannot be reached", async () => {
    const { adapter, client, stateMgr } = await setupReady();
    const i = internalOf(adapter);
    stateMgr.knownSystemIds.mockReturnValue(["systems.server_a"]);
    client.getSystems.mockRejectedValue(errnoError("refused", "ECONNREFUSED"));
    i.setStateChangedAsync.mockClear();

    await i.poll();

    expect(i.setStateChangedAsync).toHaveBeenCalledWith("info.connection", { val: false, ack: true });
    expect(i.setStateChangedAsync).toHaveBeenCalledWith("systems.server_a.info.online", { val: false, ack: true });
  });

  it("takes the fleet rollup offline with it once the rollup states exist", async () => {
    const { adapter, client, stateMgr } = await setupReady();
    const i = internalOf(adapter);
    stateMgr.knownSystemIds.mockReturnValue(["systems.server_a"]);
    client.getSystems.mockRejectedValue(errnoError("refused", "ECONNREFUSED"));
    i.setStateChangedAsync.mockClear();

    await i.poll();

    expect(i.setStateChangedAsync).toHaveBeenCalledWith("info.systemsOnline", { val: 0, ack: true });
    expect(i.setStateChangedAsync).toHaveBeenCalledWith("info.systemsAllUp", { val: false, ack: true });
  });

  it("does not write rollup states that were never created", async () => {
    const { adapter, client, stateMgr } = setup();
    const i = internalOf(adapter);
    // Hub is down from the very first poll → writeRollup never ran, so the
    // rollup objects do not exist yet.
    client.getSystems.mockRejectedValue(errnoError("refused", "ECONNREFUSED"));
    stateMgr.knownSystemIds.mockReturnValue([]);
    await i.onReady();

    expect(i.setStateChangedAsync).not.toHaveBeenCalledWith("info.systemsOnline", { val: 0, ack: true });
  });

  it("says 'unknown' in info.status instead of claiming one of the Hub's four values", async () => {
    const { adapter, client, stateMgr } = await setupReady();
    const i = internalOf(adapter);
    stateMgr.knownSystemIds.mockReturnValue(["systems.server_a"]);
    client.getSystems.mockRejectedValue(errnoError("refused", "ECONNREFUSED"));
    i.setStateChangedAsync.mockClear();

    await i.poll();

    expect(i.setStateChangedAsync).toHaveBeenCalledWith("systems.server_a.info.status", {
      val: "unknown",
      ack: true,
    });
    const claimedDown = i.setStateChangedAsync.mock.calls.some(
      (c: unknown[]) => String(c[0]).endsWith(".info.status") && (c[1] as { val: unknown }).val === "down",
    );
    expect(claimedDown).toBe(false);
  });

  it("also marks the status unknown when the adapter stops", async () => {
    const { adapter, stateMgr } = await setupReady();
    const i = internalOf(adapter);
    stateMgr.knownSystemIds.mockReturnValue(["systems.server_a"]);
    i.setState.mockClear();

    i.onUnload(vi.fn());

    expect(i.setState).toHaveBeenCalledWith("systems.server_a.info.status", { val: "unknown", ack: true });
  });
});

describe("BeszelAdapter clears the stopInstance flag it used to ship with", () => {
  // Measured on the live server 2026-08-27: dropping the entry from the manifest only
  // helps FRESH installs. An upgrade merges the manifest into the existing instance
  // object and never removes a key, so `stopInstance: true` survives — the host keeps
  // killing the process and every shutdown write stays dead code.
  it("switches the flag off when the instance object still carries it", async () => {
    const { adapter } = setup();
    const i = internalOf(adapter);
    i.getForeignObjectAsync.mockResolvedValue({
      common: { supportedMessages: { stopInstance: true, checkConnection: true } },
    });

    await i.onReady();

    expect(i.extendForeignObjectAsync).toHaveBeenCalledWith("system.adapter.beszel.0", {
      common: { supportedMessages: { stopInstance: false } },
    });
  });

  it("stops the start right there — the host is already restarting the instance", async () => {
    const { adapter, client, stateMgr } = setup();
    const i = internalOf(adapter);
    i.getForeignObjectAsync.mockResolvedValue({
      common: { supportedMessages: { stopInstance: true } },
    });

    await i.onReady();

    // Carrying on would work against a process that is already going down: failed
    // state writes and a closed objects database in the user's log (live-measured).
    expect(client.getSystems).not.toHaveBeenCalled();
    expect(stateMgr.snapshotExistingStates).not.toHaveBeenCalled();
    expect(i.setInterval).not.toHaveBeenCalled();
  });

  it("writes nothing when the flag is already off — an object write restarts the instance", async () => {
    const { adapter } = setup();
    const i = internalOf(adapter);
    i.getForeignObjectAsync.mockResolvedValue({
      common: { supportedMessages: { stopInstance: false, checkConnection: true } },
    });

    await i.onReady();

    expect(i.extendForeignObjectAsync).not.toHaveBeenCalled();
  });

  it("writes nothing on a fresh install that never had the entry", async () => {
    const { adapter } = setup();
    const i = internalOf(adapter);
    i.getForeignObjectAsync.mockResolvedValue({ common: { name: "beszel" } });

    await i.onReady();

    expect(i.extendForeignObjectAsync).not.toHaveBeenCalled();
  });

  it("starts up normally when the instance object cannot be read", async () => {
    const { adapter, client } = setup();
    const i = internalOf(adapter);
    i.getForeignObjectAsync.mockRejectedValue(new Error("objects db unreachable"));

    await i.onReady();

    expect(client.getSystems).toHaveBeenCalledTimes(1);
  });

  it("takes the fleet rollup down on shutdown too, not just the single systems", async () => {
    const { adapter, stateMgr } = await setupReady();
    const i = internalOf(adapter);
    stateMgr.knownSystemIds.mockReturnValue(["systems.server_a"]);
    i.setState.mockClear();
    const callback = vi.fn();

    i.onUnload(callback);
    await vi.waitFor(() => expect(callback).toHaveBeenCalledTimes(1));

    expect(i.setState).toHaveBeenCalledWith("info.systemsOnline", { val: 0, ack: true });
    expect(i.setState).toHaveBeenCalledWith("info.systemsAllUp", { val: false, ack: true });
  });
});
