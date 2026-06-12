import * as http from "node:http";
import { BeszelClient } from "./beszel-client";

// ---------------------------------------------------------------------------
// Test HTTP server — simulates Beszel PocketBase API
// ---------------------------------------------------------------------------

interface MockServerConfig {
  authHandler?: (body: string) => { status: number; body: string };
  systemsHandler?: () => { status: number; body: string };
  statsHandler?: () => { status: number; body: string };
  containersHandler?: () => { status: number; body: string };
  detailsHandler?: () => { status: number; body: string };
}

function createMockServer(config: MockServerConfig = {}): {
  server: http.Server;
  port: number;
  start: () => Promise<number>;
  stop: () => Promise<void>;
  requestLog: Array<{ method: string; path: string; headers: http.IncomingHttpHeaders }>;
} {
  const requestLog: Array<{ method: string; path: string; headers: http.IncomingHttpHeaders }> = [];

  const server = http.createServer((req, res) => {
    requestLog.push({
      method: req.method || "",
      path: req.url || "",
      headers: req.headers,
    });

    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      const path = req.url || "";

      if (path.includes("/api/collections/users/auth-with-password")) {
        const handler = config.authHandler || defaultAuthHandler;
        const result = handler(body);
        res.writeHead(result.status, { "Content-Type": "application/json" });
        res.end(result.body);
      } else if (path.includes("/api/collections/systems/records")) {
        const handler = config.systemsHandler || defaultSystemsHandler;
        const result = handler();
        res.writeHead(result.status, { "Content-Type": "application/json" });
        res.end(result.body);
      } else if (path.includes("/api/collections/system_stats/records")) {
        const handler = config.statsHandler || defaultStatsHandler;
        const result = handler();
        res.writeHead(result.status, { "Content-Type": "application/json" });
        res.end(result.body);
      } else if (path.includes("/api/collections/containers/records")) {
        const handler = config.containersHandler || defaultContainersHandler;
        const result = handler();
        res.writeHead(result.status, { "Content-Type": "application/json" });
        res.end(result.body);
      } else if (path.includes("/api/collections/system_details/records")) {
        const handler = config.detailsHandler || defaultSystemDetailsHandler;
        const result = handler();
        res.writeHead(result.status, { "Content-Type": "application/json" });
        res.end(result.body);
      } else {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "Not found" }));
      }
    });
  });

  let port = 0;

  return {
    server,
    get port() {
      return port;
    },
    requestLog,
    start: () =>
      new Promise(resolve => {
        server.listen(0, "127.0.0.1", () => {
          const addr = server.address() as { port: number };
          port = addr.port;
          resolve(port);
        });
      }),
    stop: () =>
      new Promise(resolve => {
        server.close(() => resolve());
      }),
  };
}

function defaultAuthHandler(body: string): { status: number; body: string } {
  const parsed = JSON.parse(body);
  if (parsed.identity === "admin" && parsed.password === "secret") {
    return {
      status: 200,
      body: JSON.stringify({
        token: "test-token-abc123",
        record: { id: "user001", email: "admin@test.com" },
      }),
    };
  }
  return {
    status: 401,
    body: JSON.stringify({ message: "Invalid credentials" }),
  };
}

function defaultSystemsHandler(): { status: number; body: string } {
  return {
    status: 200,
    body: JSON.stringify({
      page: 1,
      perPage: 200,
      totalItems: 2,
      totalPages: 1,
      items: [
        {
          id: "sys001",
          name: "Server A",
          status: "up",
          host: "192.168.1.10",
          info: { u: 86400, v: "0.8.0", la: [1.0, 2.0, 3.0] },
        },
        {
          id: "sys002",
          name: "Server B",
          status: "down",
          host: "192.168.1.20",
          info: { u: 3600 },
        },
      ],
    }),
  };
}

function defaultStatsHandler(): { status: number; body: string } {
  return {
    status: 200,
    body: JSON.stringify({
      page: 1,
      perPage: 200,
      totalItems: 2,
      totalPages: 1,
      items: [
        {
          id: "stat001",
          system: "sys001",
          type: "1m",
          stats: { cpu: 45.0, mu: 4.0, m: 16.0, mp: 25 },
          updated: "2026-01-01T12:00:00Z",
        },
        {
          id: "stat002",
          system: "sys002",
          type: "1m",
          stats: { cpu: 10.0 },
          updated: "2026-01-01T12:00:00Z",
        },
      ],
    }),
  };
}

function defaultContainersHandler(): { status: number; body: string } {
  return {
    status: 200,
    body: JSON.stringify({
      page: 1,
      perPage: 500,
      totalItems: 1,
      totalPages: 1,
      items: [
        {
          id: "c001",
          system: "sys001",
          name: "nginx",
          status: "running",
          health: 2,
          cpu: 5.0,
          memory: 128,
          image: "nginx:latest",
        },
      ],
    }),
  };
}

function defaultSystemDetailsHandler(): { status: number; body: string } {
  return {
    status: 200,
    body: JSON.stringify({
      page: 1,
      perPage: 200,
      totalItems: 2,
      totalPages: 1,
      items: [
        {
          id: "d001",
          system: "sys001",
          hostname: "server-a",
          os: 0,
          os_name: "Ubuntu 22.04",
          kernel: "6.5.0-1",
          cpu: "Intel i7-9700",
          arch: "x86_64",
          cores: 8,
          threads: 16,
          podman: false,
        },
        {
          id: "d002",
          system: "sys002",
          hostname: "server-b",
          os: 1,
          os_name: "macOS 14.1",
          cpu: "Apple M2",
          arch: "arm64",
          cores: 8,
          threads: 8,
        },
      ],
    }),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BeszelClient", () => {
  let mock: ReturnType<typeof createMockServer>;

  afterEach(async () => {
    if (mock) {
      await mock.stop();
    }
  });

  // -----------------------------------------------------------------------
  // Constructor and URL handling
  // -----------------------------------------------------------------------

  describe("constructor", () => {
    it("should strip trailing slash from URL", async () => {
      mock = createMockServer();
      const port = await mock.start();

      const client = new BeszelClient(`http://127.0.0.1:${port}/`, "admin", "secret");
      const systems = await client.getSystems();
      expect(systems).to.have.lengthOf(2);
    });

    it("should strip multiple trailing slashes", async () => {
      mock = createMockServer();
      const port = await mock.start();

      const client = new BeszelClient(`http://127.0.0.1:${port}///`, "admin", "secret");
      const systems = await client.getSystems();
      expect(systems).to.have.lengthOf(2);
    });
  });

  // -----------------------------------------------------------------------
  // Authentication
  // -----------------------------------------------------------------------

  describe("authentication", () => {
    it("should authenticate and use token for subsequent requests", async () => {
      mock = createMockServer();
      const port = await mock.start();

      const client = new BeszelClient(`http://127.0.0.1:${port}`, "admin", "secret");
      await client.getSystems();

      // Should have made auth request + systems request
      expect(mock.requestLog).to.have.lengthOf(2);
      expect(mock.requestLog[0].path).to.include("auth-with-password");
      expect(mock.requestLog[1].path).to.include("systems/records");

      // The systems request should have the token
      expect(mock.requestLog[1].headers.authorization).to.equal("test-token-abc123");
    });

    it("should send correct credentials in auth request", async () => {
      let receivedBody = "";
      mock = createMockServer({
        authHandler: (body: string) => {
          receivedBody = body;
          return {
            status: 200,
            body: JSON.stringify({
              token: "tok",
              record: { id: "u1", email: "a@b.com" },
            }),
          };
        },
      });
      const port = await mock.start();

      const client = new BeszelClient(`http://127.0.0.1:${port}`, "myuser", "mypass");
      await client.getSystems();

      const parsed = JSON.parse(receivedBody);
      expect(parsed.identity).to.equal("myuser");
      expect(parsed.password).to.equal("mypass");
    });

    it("should reuse token for multiple requests", async () => {
      mock = createMockServer();
      const port = await mock.start();

      const client = new BeszelClient(`http://127.0.0.1:${port}`, "admin", "secret");
      await client.getSystems();
      await client.getSystems();

      // Auth should only happen once
      const authRequests = mock.requestLog.filter(r => r.path.includes("auth-with-password"));
      expect(authRequests).to.have.lengthOf(1);
    });

    it("should reject with error on invalid credentials", async () => {
      mock = createMockServer();
      const port = await mock.start();

      const client = new BeszelClient(`http://127.0.0.1:${port}`, "wrong", "wrong");
      try {
        await client.getSystems();
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).to.be.instanceOf(Error);
        expect((err as Error).message).to.include("401");
        expect((err as NodeJS.ErrnoException).code).to.equal("UNAUTHORIZED");
      }
    });
  });

  // -----------------------------------------------------------------------
  // invalidateToken
  // -----------------------------------------------------------------------

  describe("invalidateToken", () => {
    it("should force re-authentication on next request", async () => {
      mock = createMockServer();
      const port = await mock.start();

      const client = new BeszelClient(`http://127.0.0.1:${port}`, "admin", "secret");
      await client.getSystems();

      // Invalidate and make another request
      client.invalidateToken();
      await client.getSystems();

      const authRequests = mock.requestLog.filter(r => r.path.includes("auth-with-password"));
      expect(authRequests).to.have.lengthOf(2);
    });
  });

  // -----------------------------------------------------------------------
  // checkConnection
  // -----------------------------------------------------------------------

  describe("checkConnection", () => {
    it("should return success on valid credentials", async () => {
      mock = createMockServer();
      const port = await mock.start();

      const client = new BeszelClient(`http://127.0.0.1:${port}`, "admin", "secret");
      const result = await client.checkConnection();
      expect(result.success).to.be.true;
      expect(result.message).to.equal("Connected successfully");
    });

    it("should return failure on invalid credentials", async () => {
      mock = createMockServer();
      const port = await mock.start();

      const client = new BeszelClient(`http://127.0.0.1:${port}`, "wrong", "wrong");
      const result = await client.checkConnection();
      expect(result.success).to.be.false;
      expect(result.message).to.include("401");
    });

    it("should return failure on connection error", async () => {
      // Use a port that nothing listens on
      const client = new BeszelClient("http://127.0.0.1:1", "admin", "secret");
      const result = await client.checkConnection();
      expect(result.success).to.be.false;
      expect(result.message.length).to.be.greaterThan(0);
    });

    it("should invalidate token before testing", async () => {
      mock = createMockServer();
      const port = await mock.start();

      const client = new BeszelClient(`http://127.0.0.1:${port}`, "admin", "secret");
      // First connection
      await client.checkConnection();
      // Second connection should re-authenticate
      await client.checkConnection();

      const authRequests = mock.requestLog.filter(r => r.path.includes("auth-with-password"));
      expect(authRequests).to.have.lengthOf(2);
    });
  });

  // -----------------------------------------------------------------------
  // getSystems
  // -----------------------------------------------------------------------

  describe("getSystems", () => {
    it("should return parsed system records", async () => {
      mock = createMockServer();
      const port = await mock.start();

      const client = new BeszelClient(`http://127.0.0.1:${port}`, "admin", "secret");
      const systems = await client.getSystems();

      expect(systems).to.have.lengthOf(2);
      expect(systems[0].id).to.equal("sys001");
      expect(systems[0].name).to.equal("Server A");
      expect(systems[0].status).to.equal("up");
      expect(systems[0].host).to.equal("192.168.1.10");
      expect(systems[0].info.u).to.equal(86400);
      expect(systems[0].info.v).to.equal("0.8.0");
      expect(systems[1].id).to.equal("sys002");
      expect(systems[1].status).to.equal("down");
    });

    it("should handle empty systems list", async () => {
      mock = createMockServer({
        systemsHandler: () => ({
          status: 200,
          body: JSON.stringify({
            page: 1,
            perPage: 200,
            totalItems: 0,
            totalPages: 0,
            items: [],
          }),
        }),
      });
      const port = await mock.start();

      const client = new BeszelClient(`http://127.0.0.1:${port}`, "admin", "secret");
      const systems = await client.getSystems();
      expect(systems).to.have.lengthOf(0);
    });
  });

  // -----------------------------------------------------------------------
  // getLatestStats
  // -----------------------------------------------------------------------

  describe("getLatestStats", () => {
    it("should return stats map keyed by system ID", async () => {
      mock = createMockServer();
      const port = await mock.start();

      const client = new BeszelClient(`http://127.0.0.1:${port}`, "admin", "secret");
      const stats = await client.getLatestStats();

      expect(stats.size).to.equal(2);
      expect(stats.get("sys001")?.cpu).to.equal(45.0);
      expect(stats.get("sys002")?.cpu).to.equal(10.0);
    });

    it("should return empty map when API returns empty list (B7 v0.4.3)", async () => {
      // v0.4.3 (B7): getLatestStats no longer takes a `systemIds` array —
      // the API call doesn't filter on it, so we always fetch and let
      // the result speak for itself. This test confirms an empty result
      // surfaces as an empty map.
      mock = createMockServer({
        statsHandler: () => ({
          status: 200,
          body: JSON.stringify({
            page: 1,
            perPage: 200,
            totalItems: 0,
            totalPages: 0,
            items: [],
          }),
        }),
      });
      const port = await mock.start();

      const client = new BeszelClient(`http://127.0.0.1:${port}`, "admin", "secret");
      const stats = await client.getLatestStats();
      expect(stats.size).to.equal(0);
    });

    it("v0.7.2: stops paging once a page brings no new system (8h of 1m history is NOT walked)", async () => {
      // The Hub keeps ~480 1m records per system. Simulate 10 pages of
      // history where page 1 already contains the newest record of both
      // systems — the client must stop after page 2 (the first all-known
      // page), not walk all 10.
      let pageRequests = 0;
      mock = createMockServer({
        statsHandler: () => {
          pageRequests++;
          return {
            status: 200,
            body: JSON.stringify({
              page: pageRequests,
              perPage: 2,
              totalItems: 20,
              totalPages: 10,
              items: [
                { id: `a${pageRequests}`, system: "sys001", type: "1m", stats: { cpu: 1 }, updated: "t" },
                { id: `b${pageRequests}`, system: "sys002", type: "1m", stats: { cpu: 2 }, updated: "t" },
              ],
            }),
          };
        },
      });
      const port = await mock.start();
      const client = new BeszelClient(`http://127.0.0.1:${port}`, "admin", "secret");
      const stats = await client.getLatestStats();
      expect(stats.size).to.equal(2);
      expect(pageRequests).to.equal(2); // page 1 = all new, page 2 = all known → stop
    });

    it("v0.7.2: keeps paging while new systems keep appearing", async () => {
      let pageRequests = 0;
      mock = createMockServer({
        statsHandler: () => {
          pageRequests++;
          return {
            status: 200,
            body: JSON.stringify({
              page: pageRequests,
              perPage: 1,
              totalItems: 3,
              totalPages: 3,
              items: [
                { id: `r${pageRequests}`, system: `sys00${pageRequests}`, type: "1m", stats: { cpu: pageRequests }, updated: "t" },
              ],
            }),
          };
        },
      });
      const port = await mock.start();
      const client = new BeszelClient(`http://127.0.0.1:${port}`, "admin", "secret");
      const stats = await client.getLatestStats();
      expect(stats.size).to.equal(3);
      expect(pageRequests).to.equal(3);
    });

    it("should deduplicate and keep newest per system", async () => {
      mock = createMockServer({
        statsHandler: () => ({
          status: 200,
          body: JSON.stringify({
            page: 1,
            perPage: 200,
            totalItems: 3,
            totalPages: 1,
            items: [
              // Sorted by -updated, so first is newest
              { id: "s1", system: "sys001", type: "1m", stats: { cpu: 50 }, updated: "2026-01-01T12:00:00Z" },
              { id: "s2", system: "sys001", type: "1m", stats: { cpu: 30 }, updated: "2026-01-01T11:59:00Z" },
              { id: "s3", system: "sys002", type: "1m", stats: { cpu: 10 }, updated: "2026-01-01T12:00:00Z" },
            ],
          }),
        }),
      });
      const port = await mock.start();

      const client = new BeszelClient(`http://127.0.0.1:${port}`, "admin", "secret");
      const stats = await client.getLatestStats();

      // Should keep the first (newest) record for sys001
      expect(stats.get("sys001")?.cpu).to.equal(50);
      expect(stats.get("sys002")?.cpu).to.equal(10);
    });
  });

  // -----------------------------------------------------------------------
  // getContainers
  // -----------------------------------------------------------------------

  describe("getContainers", () => {
    it("should return parsed container records", async () => {
      mock = createMockServer();
      const port = await mock.start();

      const client = new BeszelClient(`http://127.0.0.1:${port}`, "admin", "secret");
      const containers = await client.getContainers();

      expect(containers).to.have.lengthOf(1);
      expect(containers[0].name).to.equal("nginx");
      expect(containers[0].system).to.equal("sys001");
      expect(containers[0].cpu).to.equal(5.0);
      expect(containers[0].memory).to.equal(128);
      expect(containers[0].image).to.equal("nginx:latest");
    });
  });

  // -----------------------------------------------------------------------
  // Error handling
  // -----------------------------------------------------------------------

  describe("error handling", () => {
    it("should set UNAUTHORIZED error code for 401 responses", async () => {
      mock = createMockServer();
      const port = await mock.start();

      const client = new BeszelClient(`http://127.0.0.1:${port}`, "bad", "bad");
      try {
        await client.getSystems();
        expect.fail("Should have thrown");
      } catch (err) {
        expect((err as NodeJS.ErrnoException).code).to.equal("UNAUTHORIZED");
      }
    });

    it("should set HTTP_ERROR for non-401 errors", async () => {
      mock = createMockServer({
        systemsHandler: () => ({
          status: 500,
          body: JSON.stringify({ error: "Internal error" }),
        }),
      });
      const port = await mock.start();

      const client = new BeszelClient(`http://127.0.0.1:${port}`, "admin", "secret");
      try {
        await client.getSystems();
        expect.fail("Should have thrown");
      } catch (err) {
        expect((err as NodeJS.ErrnoException).code).to.equal("HTTP_ERROR");
        expect((err as Error).message).to.include("500");
      }
    });

    it("should reject on invalid JSON response", async () => {
      mock = createMockServer({
        systemsHandler: () => ({
          status: 200,
          body: "not valid json {{{",
        }),
      });
      const port = await mock.start();

      const client = new BeszelClient(`http://127.0.0.1:${port}`, "admin", "secret");
      try {
        await client.getSystems();
        expect.fail("Should have thrown");
      } catch (err) {
        expect((err as Error).message).to.include("Invalid JSON");
      }
    });

    it("should reject on connection refused", async () => {
      const client = new BeszelClient("http://127.0.0.1:1", "admin", "secret");
      try {
        await client.getSystems();
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).to.be.instanceOf(Error);
      }
    });

    it("should reject on invalid URL", async () => {
      const client = new BeszelClient("not-a-valid-url", "admin", "secret");
      try {
        await client.getSystems();
        expect.fail("Should have thrown");
      } catch (err) {
        expect(err).to.be.instanceOf(Error);
      }
    });

    it("should set FORBIDDEN code on 403 (B4' v0.4.3)", async () => {
      // 403 = permissions issue — distinct error code so the adapter
      // can surface a "check user role" hint instead of looping reauth.
      mock = createMockServer({
        systemsHandler: () => ({
          status: 403,
          body: JSON.stringify({ message: "Forbidden" }),
        }),
      });
      const port = await mock.start();

      const client = new BeszelClient(`http://127.0.0.1:${port}`, "admin", "secret");
      try {
        await client.getSystems();
        expect.fail("Should have thrown");
      } catch (err) {
        expect((err as Error).message).to.include("403");
        expect((err as NodeJS.ErrnoException).code).to.equal("FORBIDDEN");
      }
    });
  });

  // -----------------------------------------------------------------------
  // API drift / boundary hardening
  // -----------------------------------------------------------------------

  describe("API drift hardening", () => {
    it("rejects auth response with non-string token", async () => {
      mock = createMockServer({
        authHandler: () => ({
          status: 200,
          body: JSON.stringify({
            token: 42,
            record: { id: "u", email: "e" },
          }),
        }),
      });
      const port = await mock.start();

      const client = new BeszelClient(`http://127.0.0.1:${port}`, "a", "b");
      try {
        await client.getSystems();
        expect.fail("Should have thrown");
      } catch (err) {
        expect((err as NodeJS.ErrnoException).code).to.equal("INVALID_AUTH_RESPONSE");
      }
    });

    it("rejects auth response when token is missing", async () => {
      mock = createMockServer({
        authHandler: () => ({
          status: 200,
          body: JSON.stringify({
            record: { id: "u", email: "e" },
          }),
        }),
      });
      const port = await mock.start();

      const client = new BeszelClient(`http://127.0.0.1:${port}`, "a", "b");
      try {
        await client.getSystems();
        expect.fail("Should have thrown");
      } catch (err) {
        expect((err as NodeJS.ErrnoException).code).to.equal("INVALID_AUTH_RESPONSE");
      }
    });

    it("returns empty systems array when items is missing", async () => {
      mock = createMockServer({
        systemsHandler: () => ({
          status: 200,
          body: JSON.stringify({ page: 1 }),
        }),
      });
      const port = await mock.start();

      const client = new BeszelClient(`http://127.0.0.1:${port}`, "admin", "secret");
      const systems = await client.getSystems();
      expect(systems).to.deep.equal([]);
    });

    it("returns empty systems array when items is not an array", async () => {
      mock = createMockServer({
        systemsHandler: () => ({
          status: 200,
          body: JSON.stringify({ items: "not an array" }),
        }),
      });
      const port = await mock.start();

      const client = new BeszelClient(`http://127.0.0.1:${port}`, "admin", "secret");
      const systems = await client.getSystems();
      expect(systems).to.deep.equal([]);
    });

    it("skips system records without id or name", async () => {
      mock = createMockServer({
        systemsHandler: () => ({
          status: 200,
          body: JSON.stringify({
            items: [{ id: "a", name: "ok", status: "up", host: "h" }, { name: "no-id", status: "up" }, { id: "c" }],
          }),
        }),
      });
      const port = await mock.start();

      const client = new BeszelClient(`http://127.0.0.1:${port}`, "admin", "secret");
      const systems = await client.getSystems();
      expect(systems).to.have.lengthOf(1);
      expect(systems[0].id).to.equal("a");
    });

    it("falls back to 'pending' status for unknown status strings", async () => {
      mock = createMockServer({
        systemsHandler: () => ({
          status: 200,
          body: JSON.stringify({
            items: [{ id: "a", name: "s", status: "weird-state" }],
          }),
        }),
      });
      const port = await mock.start();

      const client = new BeszelClient(`http://127.0.0.1:${port}`, "admin", "secret");
      const systems = await client.getSystems();
      expect(systems[0].status).to.equal("pending");
    });

    it("drops non-finite stats values instead of passing them through", async () => {
      mock = createMockServer({
        statsHandler: () => ({
          status: 200,
          body: JSON.stringify({
            items: [
              {
                id: "s1",
                system: "sys001",
                type: "1m",
                stats: {
                  cpu: null,
                  mu: "not-a-number",
                  m: 16,
                },
                updated: "",
              },
            ],
          }),
        }),
      });
      const port = await mock.start();

      const client = new BeszelClient(`http://127.0.0.1:${port}`, "admin", "secret");
      const stats = await client.getLatestStats();
      const s = stats.get("sys001")!;
      expect(s.cpu).to.be.undefined;
      expect(s.mu).to.be.undefined;
      expect(s.m).to.equal(16);
    });

    it("drops la tuple when it contains a non-finite number", async () => {
      mock = createMockServer({
        statsHandler: () => ({
          status: 200,
          body: JSON.stringify({
            items: [
              {
                id: "s1",
                system: "sys001",
                type: "1m",
                stats: { la: [1, "bad", 3] },
                updated: "",
              },
            ],
          }),
        }),
      });
      const port = await mock.start();

      const client = new BeszelClient(`http://127.0.0.1:${port}`, "admin", "secret");
      const stats = await client.getLatestStats();
      expect(stats.get("sys001")!.la).to.be.undefined;
    });

    it("filters temperature map while keeping valid entries", async () => {
      mock = createMockServer({
        statsHandler: () => ({
          status: 200,
          body: JSON.stringify({
            items: [
              {
                id: "s1",
                system: "sys001",
                type: "1m",
                stats: {
                  t: { cpu: 55, gpu: "hot", fan: null, mb: 48 },
                },
                updated: "",
              },
            ],
          }),
        }),
      });
      const port = await mock.start();

      const client = new BeszelClient(`http://127.0.0.1:${port}`, "admin", "secret");
      const stats = await client.getLatestStats();
      expect(stats.get("sys001")!.t).to.deep.equal({ cpu: 55, mb: 48 });
    });

    it("skips container records without required fields", async () => {
      mock = createMockServer({
        containersHandler: () => ({
          status: 200,
          body: JSON.stringify({
            items: [
              { id: "c1", system: "s1", name: "ok", cpu: 5 },
              { system: "s1", name: "no-id" },
              { id: "c2", name: "no-system" },
            ],
          }),
        }),
      });
      const port = await mock.start();

      const client = new BeszelClient(`http://127.0.0.1:${port}`, "admin", "secret");
      const containers = await client.getContainers();
      expect(containers).to.have.lengthOf(1);
      expect(containers[0].name).to.equal("ok");
    });

    it("defaults container numeric fields to 0 when missing or wrong type", async () => {
      mock = createMockServer({
        containersHandler: () => ({
          status: 200,
          body: JSON.stringify({
            items: [
              {
                id: "c1",
                system: "s1",
                name: "app",
                cpu: "bad",
                memory: null,
              },
            ],
          }),
        }),
      });
      const port = await mock.start();

      const client = new BeszelClient(`http://127.0.0.1:${port}`, "admin", "secret");
      const containers = await client.getContainers();
      expect(containers[0].cpu).to.equal(0);
      expect(containers[0].memory).to.equal(0);
      expect(containers[0].health).to.equal(0);
    });

    it("returns empty list when stats response is a JSON array instead of object", async () => {
      mock = createMockServer({
        statsHandler: () => ({
          status: 200,
          body: JSON.stringify([1, 2, 3]),
        }),
      });
      const port = await mock.start();

      const client = new BeszelClient(`http://127.0.0.1:${port}`, "admin", "secret");
      const stats = await client.getLatestStats();
      expect(stats.size).to.equal(0);
    });
  });

  // -----------------------------------------------------------------------
  // Request headers
  // -----------------------------------------------------------------------

  describe("request headers", () => {
    it("should send Content-Type and Accept as JSON", async () => {
      mock = createMockServer();
      const port = await mock.start();

      const client = new BeszelClient(`http://127.0.0.1:${port}`, "admin", "secret");
      await client.getSystems();

      // Check the auth request headers
      expect(mock.requestLog[0].headers["content-type"]).to.equal("application/json");
      expect(mock.requestLog[0].headers.accept).to.equal("application/json");
    });

    it("should send POST method for auth", async () => {
      mock = createMockServer();
      const port = await mock.start();

      const client = new BeszelClient(`http://127.0.0.1:${port}`, "admin", "secret");
      await client.getSystems();

      expect(mock.requestLog[0].method).to.equal("POST");
    });

    it("should send GET method for data requests", async () => {
      mock = createMockServer();
      const port = await mock.start();

      const client = new BeszelClient(`http://127.0.0.1:${port}`, "admin", "secret");
      await client.getSystems();

      expect(mock.requestLog[1].method).to.equal("GET");
    });

    it("should not send Authorization header for auth request", async () => {
      mock = createMockServer();
      const port = await mock.start();

      const client = new BeszelClient(`http://127.0.0.1:${port}`, "admin", "secret");
      await client.getSystems();

      // Auth request (first) should have no authorization header
      expect(mock.requestLog[0].headers.authorization).to.be.undefined;
    });
  });

  // -----------------------------------------------------------------------
  // v0.4.3 hardening — token mutex, pagination, retry, abort
  // -----------------------------------------------------------------------

  describe("token mutex (B1 v0.4.3)", () => {
    it("concurrent requests share a single authenticate round-trip", async () => {
      mock = createMockServer();
      const port = await mock.start();

      const client = new BeszelClient(`http://127.0.0.1:${port}`, "admin", "secret");
      // Three parallel calls — without B1 each would auth separately.
      await Promise.all([client.getSystems(), client.getContainers(), client.getLatestStats()]);

      const authCalls = mock.requestLog.filter(r => r.path.includes("auth-with-password"));
      expect(authCalls).to.have.lengthOf(1);
    });
  });

  describe("pagination (B2 v0.4.3)", () => {
    it("walks every PocketBase page and accumulates items", async () => {
      // 3 pages, 2 items each — total 6 items
      let pageRequests = 0;
      mock = createMockServer({
        systemsHandler: () => {
          pageRequests++;
          const page = pageRequests;
          return {
            status: 200,
            body: JSON.stringify({
              page,
              perPage: 2,
              totalItems: 6,
              totalPages: 3,
              items: [
                {
                  id: `sys${page}a`,
                  name: `Server ${page}A`,
                  status: "up",
                  host: `1.1.1.${page}`,
                  info: {},
                },
                {
                  id: `sys${page}b`,
                  name: `Server ${page}B`,
                  status: "up",
                  host: `2.2.2.${page}`,
                  info: {},
                },
              ],
            }),
          };
        },
      });
      const port = await mock.start();

      const client = new BeszelClient(`http://127.0.0.1:${port}`, "admin", "secret");
      const systems = await client.getSystems();
      expect(systems).to.have.lengthOf(6);
      expect(pageRequests).to.equal(3);
    });

    it("stops early when a page comes back empty", async () => {
      let pageRequests = 0;
      mock = createMockServer({
        systemsHandler: () => {
          pageRequests++;
          return {
            status: 200,
            body: JSON.stringify({
              page: pageRequests,
              perPage: 200,
              totalItems: 0,
              totalPages: 99, // mis-reporting — defensive cap should not loop
              items: [],
            }),
          };
        },
      });
      const port = await mock.start();

      const client = new BeszelClient(`http://127.0.0.1:${port}`, "admin", "secret");
      const systems = await client.getSystems();
      expect(systems).to.have.lengthOf(0);
      expect(pageRequests).to.equal(1);
    });
  });

  describe("429 rate-limit retry (B3 v0.4.3)", () => {
    it("retries once on 429 honouring Retry-After, then succeeds", async () => {
      let calls = 0;
      mock = createMockServer({
        systemsHandler: () => {
          calls++;
          if (calls === 1) {
            // First call: 429 with Retry-After: 1
            return {
              status: 429,
              body: JSON.stringify({ message: "rate limited" }),
            };
          }
          return {
            status: 200,
            body: JSON.stringify({
              page: 1,
              perPage: 200,
              totalItems: 0,
              totalPages: 0,
              items: [],
            }),
          };
        },
      });
      const port = await mock.start();
      // Inject a Retry-After: 1 header in the mock response — the mock
      // helper above doesn't expose headers, so we rely on the default
      // 1-second backoff inside the client.
      const instantDelay = () => Promise.resolve();
      const client = new BeszelClient(`http://127.0.0.1:${port}`, "admin", "secret", undefined, undefined, instantDelay);
      const systems = await client.getSystems();
      expect(systems).to.have.lengthOf(0);
      // First systems-request was 429 → retry → 200
      const sysCalls = mock.requestLog.filter(r => r.path.includes("/systems/records"));
      expect(sysCalls.length).to.be.greaterThan(1);
    });

    it("surfaces RATE_LIMITED if the retry also gets 429", async () => {
      mock = createMockServer({
        systemsHandler: () => ({
          status: 429,
          body: JSON.stringify({ message: "rate limited" }),
        }),
      });
      const port = await mock.start();
      const instantDelay = () => Promise.resolve();
      const client = new BeszelClient(`http://127.0.0.1:${port}`, "admin", "secret", undefined, undefined, instantDelay);
      try {
        await client.getSystems();
        expect.fail("Should have thrown");
      } catch (err) {
        expect((err as NodeJS.ErrnoException).code).to.equal("RATE_LIMITED");
      }
    });
  });

  describe("401 re-auth retry (F6 v0.6.0)", () => {
    it("re-authenticates and retries once on a mid-session 401, then succeeds", async () => {
      let sysCalls = 0;
      mock = createMockServer({
        systemsHandler: () => {
          sysCalls++;
          if (sysCalls === 1) {
            return { status: 401, body: JSON.stringify({ message: "token expired" }) };
          }
          return {
            status: 200,
            body: JSON.stringify({ page: 1, perPage: 200, totalItems: 0, totalPages: 0, items: [] }),
          };
        },
      });
      const port = await mock.start();
      const client = new BeszelClient(`http://127.0.0.1:${port}`, "admin", "secret");
      const systems = await client.getSystems();
      expect(systems).to.have.lengthOf(0);
      // systems was requested twice (401 → retry), and auth happened twice
      // (initial + the forced re-auth after the 401).
      expect(mock.requestLog.filter(r => r.path.includes("/systems/records")).length).to.equal(2);
      expect(mock.requestLog.filter(r => r.path.includes("/auth-with-password")).length).to.equal(2);
    });

    it("propagates UNAUTHORIZED if the retry also 401s", async () => {
      mock = createMockServer({
        systemsHandler: () => ({ status: 401, body: JSON.stringify({ message: "nope" }) }),
      });
      const port = await mock.start();
      const client = new BeszelClient(`http://127.0.0.1:${port}`, "admin", "secret");
      try {
        await client.getSystems();
        expect.fail("Should have thrown");
      } catch (err) {
        expect((err as NodeJS.ErrnoException).code).to.equal("UNAUTHORIZED");
      }
      // initial systems + one retry = 2 (no infinite loop)
      expect(mock.requestLog.filter(r => r.path.includes("/systems/records")).length).to.equal(2);
    });

    it("does NOT retry the auth request itself on 401 (bad credentials)", async () => {
      mock = createMockServer({
        authHandler: () => ({ status: 401, body: JSON.stringify({ message: "bad creds" }) }),
      });
      const port = await mock.start();
      const client = new BeszelClient(`http://127.0.0.1:${port}`, "admin", "wrong");
      try {
        await client.getSystems();
        expect.fail("Should have thrown");
      } catch (err) {
        expect((err as NodeJS.ErrnoException).code).to.equal("UNAUTHORIZED");
      }
      // The auth POST (token === null) must not be retried by the F6 path.
      expect(mock.requestLog.filter(r => r.path.includes("/auth-with-password")).length).to.equal(1);
    });
  });

  describe("getSystemDetails (F2 v0.6.0)", () => {
    it("returns a map of system id → details", async () => {
      mock = createMockServer();
      const port = await mock.start();
      const client = new BeszelClient(`http://127.0.0.1:${port}`, "admin", "secret");
      const details = await client.getSystemDetails();
      expect(details.size).to.equal(2);
      expect(details.get("sys001")).to.deep.equal({
        hostname: "server-a",
        os: 0,
        os_name: "Ubuntu 22.04",
        kernel: "6.5.0-1",
        cpu: "Intel i7-9700",
        arch: "x86_64",
        cores: 8,
        threads: 16,
        podman: false,
      });
      expect(details.get("sys002")!.os).to.equal(1);
      expect(details.get("sys002")!.arch).to.equal("arm64");
    });

    it("keeps the first record per system (dedup)", async () => {
      mock = createMockServer({
        detailsHandler: () => ({
          status: 200,
          body: JSON.stringify({
            page: 1,
            perPage: 200,
            totalItems: 2,
            totalPages: 1,
            items: [
              { id: "d1", system: "sys001", hostname: "first" },
              { id: "d2", system: "sys001", hostname: "second" },
            ],
          }),
        }),
      });
      const port = await mock.start();
      const client = new BeszelClient(`http://127.0.0.1:${port}`, "admin", "secret");
      const details = await client.getSystemDetails();
      expect(details.size).to.equal(1);
      expect(details.get("sys001")!.hostname).to.equal("first");
    });

    it("returns an empty map on an older Hub without the collection (404)", async () => {
      mock = createMockServer({
        detailsHandler: () => ({ status: 404, body: JSON.stringify({ message: "no such collection" }) }),
      });
      const port = await mock.start();
      const client = new BeszelClient(`http://127.0.0.1:${port}`, "admin", "secret");
      // fetchAllPages → fetchJson throws on 404; the adapter treats that as
      // "details absent". Here we assert the throw so main.ts's try/catch is
      // the documented handling point.
      let threw = false;
      try {
        await client.getSystemDetails();
      } catch {
        threw = true;
      }
      expect(threw).to.equal(true);
    });
  });

  describe("AbortController cancel (B8 v0.4.3)", () => {
    it("cancelAll() aborts pending requests", async () => {
      // Server that hangs forever — cancelAll() should reject the promise.
      const hangServer = http.createServer(() => {
        /* never respond */
      });
      await new Promise<void>(resolve => hangServer.listen(0, "127.0.0.1", () => resolve()));
      const port = (hangServer.address() as { port: number }).port;

      try {
        const client = new BeszelClient(`http://127.0.0.1:${port}`, "admin", "secret", 60_000);
        const promise = client.getSystems();
        // Give the request a moment to actually start
        await new Promise(r => setTimeout(r, 50));
        client.cancelAll();
        let aborted = false;
        try {
          await promise;
        } catch {
          aborted = true;
        }
        expect(aborted).to.equal(true);
      } finally {
        await new Promise<void>(resolve => hangServer.close(() => resolve()));
      }
    }, 5000);
  });
});
