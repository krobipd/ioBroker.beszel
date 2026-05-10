"use strict";
var __create = Object.create;
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
var __getProtoOf = Object.getPrototypeOf;
var __hasOwnProp = Object.prototype.hasOwnProperty;
var __export = (target, all) => {
  for (var name in all)
    __defProp(target, name, { get: all[name], enumerable: true });
};
var __copyProps = (to, from, except, desc) => {
  if (from && typeof from === "object" || typeof from === "function") {
    for (let key of __getOwnPropNames(from))
      if (!__hasOwnProp.call(to, key) && key !== except)
        __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
  }
  return to;
};
var __toESM = (mod, isNodeMode, target) => (target = mod != null ? __create(__getProtoOf(mod)) : {}, __copyProps(
  // If the importer is in node compatibility mode or this is not an ESM
  // file that has been converted to a CommonJS file using a Babel-
  // compatible transform (i.e. "__esModule" has not been set), then set
  // "default" to the CommonJS "module.exports" for node compatibility.
  isNodeMode || !mod || !mod.__esModule ? __defProp(target, "default", { value: mod, enumerable: true }) : target,
  mod
));
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var beszel_client_exports = {};
__export(beszel_client_exports, {
  BeszelClient: () => BeszelClient
});
module.exports = __toCommonJS(beszel_client_exports);
var http = __toESM(require("node:http"));
var https = __toESM(require("node:https"));
var import_node_url = require("node:url");
var import_coerce = require("./coerce");
const TOKEN_REFRESH_MS = 23 * 60 * 60 * 1e3;
const DEFAULT_TIMEOUT_MS = 15e3;
const PAGE_SIZE = 200;
const MAX_PAGES = 50;
class BeszelClient {
  baseUrl;
  username;
  password;
  token = null;
  tokenTime = 0;
  /**
   * v0.4.3 (B1): in-flight authenticate-promise so concurrent requests
   * share a single auth round-trip.
   */
  authInFlight = null;
  /** v0.4.3 (B5): per-request timeout in ms (default 15 s). */
  timeoutMs;
  /**
   * v0.4.3 (B8): set of in-flight `AbortController`s. `cancelAll()` aborts
   * every running request — called from `onUnload`.
   */
  inflight = /* @__PURE__ */ new Set();
  /**
   * @param url Beszel Hub base URL, e.g. http://192.168.1.100:8090
   * @param username Login username
   * @param password Login password
   * @param timeoutMs Per-request HTTP timeout in milliseconds (default 15 000)
   */
  constructor(url, username, password, timeoutMs = DEFAULT_TIMEOUT_MS) {
    this.baseUrl = url.replace(/\/+$/, "");
    this.username = username;
    this.password = password;
    this.timeoutMs = timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
  }
  /** Force token re-authentication on the next request */
  invalidateToken() {
    this.token = null;
    this.tokenTime = 0;
  }
  /**
   * v0.4.3 (B8): abort every in-flight request. Called from `onUnload`
   * so a slow Hub doesn't keep the adapter alive past js-controller's
   * 4-second kill deadline.
   */
  cancelAll() {
    for (const ctrl of this.inflight) {
      ctrl.abort();
    }
  }
  /**
   * Test the connection to Beszel.
   * Returns { success: true } or { success: false, message: reason }.
   */
  async checkConnection() {
    try {
      this.invalidateToken();
      await this.authenticate();
      return { success: true, message: "Connected successfully" };
    } catch (err) {
      return { success: false, message: (0, import_coerce.errText)(err) };
    }
  }
  /** Fetch all systems (paginated, B2 v0.4.3) */
  async getSystems() {
    await this.ensureToken();
    const items = await this.fetchAllPages("/api/collections/systems/records?sort=name", import_coerce.coerceSystem);
    return items.filter((s) => s !== null);
  }
  /**
   * Fetch the latest 1m stats per system.
   * Returns a Map<systemId, SystemStats>.
   *
   * v0.4.3 (B7+M3): no longer takes a `systemIds` array — the API call
   * doesn't filter on it server-side. Removing the param lets the caller
   * fetch this concurrently with `getSystems()`.
   *
   * v0.4.3 (B2): paginated so big setups (200+ systems) aren't truncated.
   */
  async getLatestStats() {
    await this.ensureToken();
    const items = await this.fetchAllPages(
      "/api/collections/system_stats/records?sort=-updated&filter=type%3D'1m'",
      import_coerce.coerceSystemStatsRecord
    );
    const result = /* @__PURE__ */ new Map();
    for (const record of items) {
      if (record && !result.has(record.system)) {
        result.set(record.system, record.stats);
      }
    }
    return result;
  }
  /** Fetch all containers (paginated, B2 v0.4.3) */
  async getContainers() {
    await this.ensureToken();
    const items = await this.fetchAllPages("/api/collections/containers/records?sort=system%2Cname", import_coerce.coerceContainer);
    return items.filter((c) => c !== null);
  }
  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------
  async ensureToken() {
    const now = Date.now();
    if (this.token && now - this.tokenTime < TOKEN_REFRESH_MS) {
      return;
    }
    if (this.authInFlight) {
      await this.authInFlight;
      return;
    }
    this.authInFlight = this.authenticate().finally(() => {
      this.authInFlight = null;
    });
    await this.authInFlight;
  }
  async authenticate() {
    const body = JSON.stringify({
      identity: this.username,
      password: this.password
    });
    const raw = await this.request(
      "POST",
      "/api/collections/users/auth-with-password",
      body,
      null
      // no auth token yet
    );
    const auth = (0, import_coerce.coerceAuthResponse)(raw);
    if (auth === null) {
      const err = new Error("Auth response missing valid token");
      err.code = "INVALID_AUTH_RESPONSE";
      throw err;
    }
    this.token = auth.token;
    this.tokenTime = Date.now();
  }
  async fetchJson(path) {
    return this.request("GET", path, null, this.token);
  }
  /**
   * v0.4.3 (B2): walk every PocketBase page and accumulate the items.
   * Stops at `MAX_PAGES` defensively. Splits `path` on `?` so we can
   * always append our own `page=` and `perPage=`.
   *
   * @param path The collection-records path (with or without query string).
   * @param itemCoercer Per-item coercer; `null` items are dropped by the caller.
   */
  async fetchAllPages(path, itemCoercer) {
    const sep = path.includes("?") ? "&" : "?";
    const out = [];
    let totalPages = 1;
    for (let page = 1; page <= Math.min(totalPages, MAX_PAGES); page++) {
      const pagedPath = `${path}${sep}page=${page}&perPage=${PAGE_SIZE}`;
      const raw = await this.fetchJson(pagedPath);
      const list = (0, import_coerce.coercePocketBaseList)(raw, itemCoercer);
      out.push(...list.items);
      totalPages = list.totalPages > 0 ? list.totalPages : 1;
      if (list.items.length === 0) {
        break;
      }
    }
    return out;
  }
  async request(method, path, body, token) {
    var _a;
    try {
      return await this.requestOnce(method, path, body, token);
    } catch (err) {
      const e = err;
      if (e.code !== "RATE_LIMITED") {
        throw err;
      }
      const retrySec = (_a = e.retryAfter) != null ? _a : 1;
      const sleep = Math.min(Math.max(1, retrySec), 30) * 1e3;
      await new Promise((resolve) => setTimeout(resolve, sleep));
      return this.requestOnce(method, path, body, token);
    }
  }
  requestOnce(method, path, body, token) {
    return new Promise((resolve, reject) => {
      let parsedUrl;
      try {
        parsedUrl = new import_node_url.URL(this.baseUrl + path);
      } catch {
        reject(new Error(`Invalid URL: ${this.baseUrl + path}`));
        return;
      }
      const isHttps = parsedUrl.protocol === "https:";
      const transport = isHttps ? https : http;
      const headers = {
        "Content-Type": "application/json",
        Accept: "application/json"
      };
      if (token) {
        headers.Authorization = token;
      }
      if (body !== null) {
        headers["Content-Length"] = Buffer.byteLength(body).toString();
      }
      const options = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method,
        headers,
        timeout: this.timeoutMs
      };
      const ctrl = new AbortController();
      this.inflight.add(ctrl);
      const cleanup = () => {
        this.inflight.delete(ctrl);
      };
      const req = transport.request(options, (res) => {
        const chunks = [];
        res.on("error", (err) => {
          cleanup();
          reject(err);
        });
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          var _a;
          cleanup();
          const raw = Buffer.concat(chunks).toString("utf8");
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            const err = new Error(`HTTP ${(_a = res.statusCode) != null ? _a : "?"}: ${raw.slice(0, 200)}`);
            if (res.statusCode === 401) {
              err.code = "UNAUTHORIZED";
            } else if (res.statusCode === 429) {
              err.code = "RATE_LIMITED";
              const ra = res.headers["retry-after"];
              if (typeof ra === "string") {
                const n = parseInt(ra, 10);
                if (Number.isFinite(n) && n > 0) {
                  err.retryAfter = n;
                }
              }
            } else if (res.statusCode === 403) {
              err.code = "FORBIDDEN";
            } else {
              err.code = "HTTP_ERROR";
            }
            reject(err);
            return;
          }
          try {
            resolve(JSON.parse(raw));
          } catch {
            reject(new Error(`Invalid JSON response from ${path}`));
          }
        });
      });
      ctrl.signal.addEventListener("abort", () => {
        req.destroy(new Error("Request aborted"));
      });
      req.on("timeout", () => {
        req.destroy();
        cleanup();
        reject(new Error(`Request to ${path} timed out`));
      });
      req.on("error", (err) => {
        cleanup();
        reject(err);
      });
      if (body !== null) {
        req.write(body);
      }
      req.end();
    });
  }
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  BeszelClient
});
//# sourceMappingURL=beszel-client.js.map
