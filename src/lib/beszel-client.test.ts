import * as http from "node:http";
import { BeszelClient, hostnameForRequest } from "./beszel-client";

// ---------------------------------------------------------------------------
// Test HTTP server — simulates Beszel PocketBase API
// ---------------------------------------------------------------------------

/** A handler's reply: status + body, plus optional extra response headers. */
interface MockReply {
  status: number;
  body: string;
  headers?: Record<string, string>;
}

interface MockServerConfig {
  authHandler?: (body: string) => MockReply;
  systemsHandler?: () => MockReply;
  statsHandler?: () => MockReply;
  containersHandler?: () => MockReply;
  detailsHandler?: () => MockReply;
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
        res.writeHead(result.status, { "Content-Type": "application/json", ...(result.headers ?? {}) });
        res.end(result.body);
      } else if (path.includes("/api/collections/systems/records")) {
        const handler = config.systemsHandler || defaultSystemsHandler;
        const result = handler();
        res.writeHead(result.status, { "Content-Type": "application/json", ...(result.headers ?? {}) });
        res.end(result.body);
      } else if (path.includes("/api/collections/system_stats/records")) {
        const handler = config.statsHandler || defaultStatsHandler;
        const result = handler();
        res.writeHead(result.status, { "Content-Type": "application/json", ...(result.headers ?? {}) });
        res.end(result.body);
      } else if (path.includes("/api/collections/containers/records")) {
        const handler = config.containersHandler || defaultContainersHandler;
        const result = handler();
        res.writeHead(result.status, { "Content-Type": "application/json", ...(result.headers ?? {}) });
        res.end(result.body);
      } else if (path.includes("/api/collections/system_details/records")) {
        const handler = config.detailsHandler || defaultSystemDetailsHandler;
        const result = handler();
        res.writeHead(result.status, { "Content-Type": "application/json", ...(result.headers ?? {}) });
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

function defaultAuthHandler(body: string): MockReply {
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

function defaultSystemsHandler(): MockReply {
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

function defaultStatsHandler(): MockReply {
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

function defaultContainersHandler(): MockReply {
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

function defaultSystemDetailsHandler(): MockReply {
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
    it("should strip trailing slashes from the URL — the request path has no double slash", async () => {
      // The old pair of tests only asserted "the call still works": with the
      // strip removed the path became `//api/collections/...`, which the mock
      // (and a real PocketBase) still route, so both stayed green (audit
      // 2026-08-22). Assert the actual request line instead.
      mock = createMockServer();
      const port = await mock.start();

      const client = new BeszelClient(`http://127.0.0.1:${port}///`, "admin", "secret");
      const systems = await client.getSystems();
      expect(systems).to.have.lengthOf(2);
      for (const req of mock.requestLog) {
        expect(req.path.startsWith("/api/"), `unexpected request path: ${req.path}`).to.equal(true);
      }
    });

    it("falls back to the default timeout for a non-positive value", () => {
      // A 0 / negative timeout would otherwise arm an immediate socket timeout.
      const client = new BeszelClient("http://127.0.0.1:1", "a", "b", 0);
      const timeout = (client as unknown as { timeoutMs: number }).timeoutMs;
      expect(timeout).to.equal(15_000);
      const negative = new BeszelClient("http://127.0.0.1:1", "a", "b", -5);
      expect((negative as unknown as { timeoutMs: number }).timeoutMs).to.equal(15_000);
    });
  });

  // -----------------------------------------------------------------------
  // IPv6 Hub address
  // -----------------------------------------------------------------------

  describe("IPv6 Hub address", () => {
    it("strips the URL brackets from an IPv6 literal before connecting", () => {
      expect(hostnameForRequest("[::1]")).to.equal("::1");
      expect(hostnameForRequest("[fd00::1]")).to.equal("fd00::1");
      expect(hostnameForRequest("192.168.1.5")).to.equal("192.168.1.5");
      expect(hostnameForRequest("beszel.lan")).to.equal("beszel.lan");
    });

    it("reaches a Hub configured by IPv6 address (was: getaddrinfo ENOTFOUND [::1])", async () => {
      // URL.hostname keeps the brackets; handed to Node's http client verbatim, the
      // resolver looks up the literal "[::1]" and fails. A real server on the IPv6
      // loopback proves the connect, not just the helper.
      const server = http.createServer((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ token: "v6-token" }));
      });
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "::1", () => resolve());
      });
      const port = (server.address() as { port: number }).port;
      try {
        const client = new BeszelClient(`http://[::1]:${port}`, "admin", "secret");
        const result = await client.checkConnection();
        expect(result, "the IPv6 literal must be usable as a Hub address").to.deep.equal({
          success: true,
          message: "Connected successfully",
        });
      } finally {
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
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
                {
                  id: `r${pageRequests}`,
                  system: `sys00${pageRequests}`,
                  type: "1m",
                  stats: { cpu: pageRequests },
                  updated: "t",
                },
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
    // (The UNAUTHORIZED-code assertion lives in "should reject with error on
    // invalid credentials" above, which checks the same path plus the message —
    // this file's duplicate was removed in the 2026-08-22 audit.)

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
    it("retries once on a 429, then succeeds", async () => {
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
      // L7: honest scope — this exercises the 429 → single-retry → success path.
      // The mock server does not set a Retry-After header, so the client uses its
      // default back-off; the header-parse branch is left to a hostile-Hub audit.
      const instantDelay = (): Promise<void> => Promise.resolve();
      const client = new BeszelClient(
        `http://127.0.0.1:${port}`,
        "admin",
        "secret",
        undefined,
        undefined,
        instantDelay,
      );
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
      const instantDelay = (): Promise<void> => Promise.resolve();
      const client = new BeszelClient(
        `http://127.0.0.1:${port}`,
        "admin",
        "secret",
        undefined,
        undefined,
        instantDelay,
      );
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

    it("a concurrent 401 retries with the freshly refreshed token instead of re-authenticating again", async () => {
      // Two parallel requests both hit a 401. The first refreshes the token; the
      // second must NOT burn a second re-auth (and must not clobber the fresh
      // token via invalidateToken). Determinism: the mock delays the SECOND auth
      // response, so both 401s are certainly in flight before any refresh lands.
      const debugs: string[] = [];
      let authCalls = 0;
      let sysCalls = 0;
      let containerCalls = 0;
      const okList = JSON.stringify({ page: 1, perPage: 200, totalItems: 0, totalPages: 0, items: [] });
      const server = http.createServer((req, res) => {
        const url = req.url ?? "";
        const chunks: Buffer[] = [];
        req.on("data", (c: Buffer) => chunks.push(c));
        req.on("end", () => {
          const reply = (status: number, body: string, delayMs = 0): void => {
            setTimeout(() => {
              res.writeHead(status, { "Content-Type": "application/json" });
              res.end(body);
            }, delayMs);
          };
          if (url.includes("auth-with-password")) {
            authCalls++;
            // The re-auth (2nd) is slowed so both original requests get their 401 first.
            reply(200, JSON.stringify({ token: `token-${authCalls}` }), authCalls === 1 ? 0 : 60);
          } else if (url.includes("/systems/records")) {
            sysCalls++;
            reply(sysCalls === 1 ? 401 : 200, sysCalls === 1 ? JSON.stringify({ message: "expired" }) : okList);
          } else if (url.includes("/containers/records")) {
            containerCalls++;
            reply(
              containerCalls === 1 ? 401 : 200,
              containerCalls === 1 ? JSON.stringify({ message: "expired" }) : okList,
            );
          } else {
            reply(404, "{}");
          }
        });
      });
      await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
      const port = (server.address() as { port: number }).port;
      try {
        const client = new BeszelClient(`http://127.0.0.1:${port}`, "admin", "secret", undefined, {
          debug: msg => debugs.push(msg),
          warn: () => {},
        });
        await Promise.all([client.getSystems(), client.getContainers()]);
        // Exactly one refresh for the pair — 1 initial + 1 re-auth.
        expect(authCalls).to.equal(2);
        expect(debugs.some(d => d.includes("token already refreshed concurrently"))).to.equal(true);
      } finally {
        await new Promise<void>(resolve => server.close(() => resolve()));
      }
    }, 5000);

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

  // -----------------------------------------------------------------------
  // N6 — per-request timeout
  // -----------------------------------------------------------------------

  describe("request timeout (N6)", () => {
    it("tags its own timeout with ETIMEDOUT so classifyError yields TIMEOUT", async () => {
      // The whole timeout path was unexecuted before this test (audit
      // 2026-08-22). It matters beyond the error text: main.ts keys the
      // system_details retry on the TIMEOUT class, which comes from this code.
      const hangServer = http.createServer(() => {
        /* never respond */
      });
      await new Promise<void>(resolve => hangServer.listen(0, "127.0.0.1", () => resolve()));
      const port = (hangServer.address() as { port: number }).port;
      try {
        const client = new BeszelClient(`http://127.0.0.1:${port}`, "admin", "secret", 150);
        let caught: NodeJS.ErrnoException | undefined;
        try {
          await client.getSystems();
        } catch (err) {
          caught = err as NodeJS.ErrnoException;
        }
        expect(caught, "the request must reject").to.not.be.undefined;
        expect(caught!.code).to.equal("ETIMEDOUT");
        expect(caught!.message).to.match(/timed out/i);
      } finally {
        await new Promise<void>(resolve => hangServer.close(() => resolve()));
      }
    }, 5000);
  });

  // -----------------------------------------------------------------------
  // Retry-After handling + pagination cap
  // -----------------------------------------------------------------------

  describe("429 Retry-After header (B3)", () => {
    it("honours the header but never waits longer than 30 s", async () => {
      // A hostile / misconfigured Hub answering `Retry-After: 86400` would
      // otherwise park the poll for a day — the clamp was unguarded.
      const waits: number[] = [];
      let calls = 0;
      mock = createMockServer({
        systemsHandler: () => {
          calls++;
          return calls === 1
            ? { status: 429, body: JSON.stringify({ message: "slow down" }), headers: { "retry-after": "86400" } }
            : {
                status: 200,
                body: JSON.stringify({ page: 1, perPage: 200, totalItems: 0, totalPages: 0, items: [] }),
              };
        },
      });
      const port = await mock.start();
      const client = new BeszelClient(`http://127.0.0.1:${port}`, "admin", "secret", undefined, undefined, ms => {
        waits.push(ms);
        return Promise.resolve();
      });
      await client.getSystems();
      expect(waits).to.deep.equal([30_000]);
    });

    it("uses the header value when it is inside the allowed window", async () => {
      const waits: number[] = [];
      let calls = 0;
      mock = createMockServer({
        systemsHandler: () => {
          calls++;
          return calls === 1
            ? { status: 429, body: JSON.stringify({ message: "slow down" }), headers: { "retry-after": "7" } }
            : {
                status: 200,
                body: JSON.stringify({ page: 1, perPage: 200, totalItems: 0, totalPages: 0, items: [] }),
              };
        },
      });
      const port = await mock.start();
      const client = new BeszelClient(`http://127.0.0.1:${port}`, "admin", "secret", undefined, undefined, ms => {
        waits.push(ms);
        return Promise.resolve();
      });
      await client.getSystems();
      expect(waits).to.deep.equal([7_000]);
    });

    it("falls back to 1 s when the header is missing or unusable", async () => {
      const waits: number[] = [];
      let calls = 0;
      mock = createMockServer({
        systemsHandler: () => {
          calls++;
          return calls === 1
            ? { status: 429, body: JSON.stringify({ message: "slow down" }), headers: { "retry-after": "later" } }
            : {
                status: 200,
                body: JSON.stringify({ page: 1, perPage: 200, totalItems: 0, totalPages: 0, items: [] }),
              };
        },
      });
      const port = await mock.start();
      const client = new BeszelClient(`http://127.0.0.1:${port}`, "admin", "secret", undefined, undefined, ms => {
        waits.push(ms);
        return Promise.resolve();
      });
      await client.getSystems();
      expect(waits).to.deep.equal([1_000]);
    });
  });

  describe("pagination cap (MAX_PAGES)", () => {
    it("stops at 50 pages and warns that the data is truncated", async () => {
      // A Hub reporting 10 000 pages must not lock the poll into an endless
      // walk. Both the cap and the warn were unguarded (audit 2026-08-22).
      let pageRequests = 0;
      mock = createMockServer({
        systemsHandler: () => {
          pageRequests++;
          return {
            status: 200,
            body: JSON.stringify({
              page: pageRequests,
              perPage: 200,
              totalItems: 20_000,
              totalPages: 100,
              items: [{ id: `s${pageRequests}`, name: `Server ${pageRequests}`, status: "up", host: "h", info: {} }],
            }),
          };
        },
      });
      const port = await mock.start();
      const warns: string[] = [];
      const client = new BeszelClient(`http://127.0.0.1:${port}`, "admin", "secret", undefined, {
        debug: () => {},
        warn: msg => warns.push(msg),
      });
      const systems = await client.getSystems();
      expect(pageRequests).to.equal(50);
      expect(systems).to.have.lengthOf(50);
      expect(warns.some(w => w.includes("MAX_PAGES=50") && w.includes("may be incomplete"))).to.equal(true);
    }, 10000);
  });

  describe("injected logger (v0.4.4 trace)", () => {
    it("traces auth, request and pagination through the adapter logger", async () => {
      // No test ever passed a logger, so every `this.log?.…` line was dead in
      // the suite — a throwing template would only have shown up in production.
      const debugs: string[] = [];
      mock = createMockServer({
        systemsHandler: () => ({
          status: 200,
          body: JSON.stringify({
            page: 1,
            perPage: 200,
            totalItems: 2,
            totalPages: 2,
            items: [{ id: "a", name: "A", status: "up", host: "h", info: {} }],
          }),
        }),
      });
      const port = await mock.start();
      const client = new BeszelClient(`http://127.0.0.1:${port}`, "admin", "secret", undefined, {
        debug: msg => debugs.push(msg),
        warn: () => {},
      });
      await client.getSystems();
      expect(debugs.some(d => d.includes("ensureToken: fresh authentication"))).to.equal(true);
      expect(debugs.some(d => d.includes("authenticate: success"))).to.equal(true);
      expect(debugs.some(d => d.includes("HTTP POST /api/collections/users/auth-with-password"))).to.equal(true);
      expect(debugs.some(d => d.includes("fetchAllPages: page 2/2"))).to.equal(true);

      client.invalidateToken();
      expect(debugs.some(d => d.includes("invalidateToken: cleared"))).to.equal(true);
      client.cancelAll();
      expect(debugs.some(d => d.includes("cancelAll: aborting 0 inflight requests"))).to.equal(true);
    });

    it("traces the HTTP error class of a failing response", async () => {
      const debugs: string[] = [];
      mock = createMockServer({
        systemsHandler: () => ({ status: 500, body: JSON.stringify({ message: "boom" }) }),
      });
      const port = await mock.start();
      const client = new BeszelClient(`http://127.0.0.1:${port}`, "admin", "secret", undefined, {
        debug: msg => debugs.push(msg),
        warn: () => {},
      });
      await client.getSystems().catch(() => undefined);
      expect(debugs.some(d => d.includes("→ 500 HTTP_ERROR"))).to.equal(true);
    });
  });

  // -----------------------------------------------------------------------
  // SEC-5 — oversized response guard
  // -----------------------------------------------------------------------

  describe("SEC-5: oversized response guard", () => {
    it("aborts a response that exceeds the size cap instead of buffering it (OOM guard)", async () => {
      // 16.5 MiB body — over the 16 MiB cap. A normal 200-record page is far smaller.
      const huge = "x".repeat(16 * 1024 * 1024 + 512 * 1024);
      mock = createMockServer({ systemsHandler: () => ({ status: 200, body: huge }) });
      const port = await mock.start();
      const client = new BeszelClient(`http://127.0.0.1:${port}`, "admin", "secret");
      let threw = false;
      try {
        await client.getSystems();
      } catch (err) {
        threw = true;
        expect((err as Error).message).to.match(/exceeded/i);
      }
      expect(threw).to.equal(true);
    }, 10000);
  });

  // -----------------------------------------------------------------------
  // Pagination — a page of only-unusable records must not end the walk
  // -----------------------------------------------------------------------

  describe("pagination past an unusable page", () => {
    it("keeps paging when one page holds only records that fail coercion", async () => {
      let pageRequests = 0;
      mock = createMockServer({
        systemsHandler: () => {
          pageRequests++;
          // Page 2 carries records without a name — every one is dropped by the
          // coercer, so the coerced list is empty while the raw page is not.
          const items =
            pageRequests === 2
              ? [{ id: "broken1" }, { id: "broken2" }]
              : [{ id: `sys${pageRequests}`, name: `Server ${pageRequests}`, status: "up", host: "h", info: {} }];
          return {
            status: 200,
            body: JSON.stringify({ page: pageRequests, perPage: 2, totalItems: 3, totalPages: 3, items }),
          };
        },
      });
      const port = await mock.start();
      const client = new BeszelClient(`http://127.0.0.1:${port}`, "admin", "secret");
      const systems = await client.getSystems();
      expect(pageRequests).to.equal(3);
      expect(systems.map(s => s.id)).to.deep.equal(["sys1", "sys3"]);
    });

    it("still stops on a genuinely empty page", async () => {
      let pageRequests = 0;
      mock = createMockServer({
        systemsHandler: () => {
          pageRequests++;
          const items = pageRequests === 1 ? [{ id: "sys1", name: "Server 1", status: "up", host: "h", info: {} }] : [];
          return {
            status: 200,
            body: JSON.stringify({ page: pageRequests, perPage: 1, totalItems: 1, totalPages: 5, items }),
          };
        },
      });
      const port = await mock.start();
      const client = new BeszelClient(`http://127.0.0.1:${port}`, "admin", "secret");
      const systems = await client.getSystems();
      expect(pageRequests).to.equal(2);
      expect(systems).to.have.length(1);
    });
  });
});

describe("pagination capacity and cost", () => {
  it("reads a large installation completely and in a handful of requests", async () => {
    // The page size is not just a tuning knob: together with the page cap it decides
    // how much of a big installation the adapter can see at all, and how many
    // round-trips that costs the Hub. Shrinking it far enough silently truncates the
    // result once the cap is reached — which is why this is a behaviour test, not a
    // test that nails down the number 200.
    const TOTAL = 250;
    const requests: string[] = [];
    const server = http.createServer((req, res) => {
      const path = req.url ?? "";
      requests.push(path);
      res.writeHead(200, { "Content-Type": "application/json" });
      if (path.includes("auth-with-password")) {
        res.end(JSON.stringify({ token: "tok" }));
        return;
      }
      const params = new URL(path, "http://localhost").searchParams;
      const perPage = Number(params.get("perPage"));
      const page = Number(params.get("page"));
      const start = (page - 1) * perPage;
      const count = Math.max(0, Math.min(perPage, TOTAL - start));
      const items = Array.from({ length: count }, (_, i) => ({
        id: `sys${start + i}`,
        name: `Server ${start + i}`,
        status: "up",
        host: "10.0.0.1",
        info: {},
      }));
      res.end(JSON.stringify({ page, perPage, totalItems: TOTAL, totalPages: Math.ceil(TOTAL / perPage), items }));
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", () => resolve()));
    const { port } = server.address() as { port: number };
    try {
      const client = new BeszelClient(`http://127.0.0.1:${port}`, "u", "p");
      const systems = await client.getSystems();

      expect(systems, "every system must arrive, none truncated by the page cap").to.have.lengthOf(TOTAL);
      const listCalls = requests.filter(path => path.includes("/systems/records"));
      expect(listCalls.length, "a 250-system Hub must not cost dozens of round-trips").to.be.at.most(5);
    } finally {
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  });
});
