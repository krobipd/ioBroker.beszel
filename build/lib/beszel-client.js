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
const TOKEN_REFRESH_MS = 23 * 60 * 60 * 1e3;
class BeszelClient {
  baseUrl;
  username;
  password;
  token = null;
  tokenTime = 0;
  /**
   * @param url Beszel Hub base URL, e.g. http://192.168.1.100:8090
   * @param username Login username
   * @param password Login password
   */
  constructor(url, username, password) {
    this.baseUrl = url.replace(/\/+$/, "");
    this.username = username;
    this.password = password;
  }
  /** Force token re-authentication on the next request */
  invalidateToken() {
    this.token = null;
    this.tokenTime = 0;
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
      return {
        success: false,
        message: err instanceof Error ? err.message : String(err)
      };
    }
  }
  /** Fetch all systems */
  async getSystems() {
    await this.ensureToken();
    const data = await this.fetchJson(
      "/api/collections/systems/records?perPage=200&sort=name"
    );
    return data.items;
  }
  /**
   * Fetch the latest 1m stats per system.
   * Returns a Map<systemId, SystemStats>.
   *
   * @param systemIds List of system IDs to fetch stats for
   */
  async getLatestStats(systemIds) {
    if (systemIds.length === 0) {
      return /* @__PURE__ */ new Map();
    }
    await this.ensureToken();
    const data = await this.fetchJson(
      "/api/collections/system_stats/records?sort=-updated&perPage=200&filter=type%3D'1m'"
    );
    const result = /* @__PURE__ */ new Map();
    for (const record of data.items) {
      if (!result.has(record.system)) {
        result.set(record.system, record.stats);
      }
    }
    return result;
  }
  /** Fetch all containers */
  async getContainers() {
    await this.ensureToken();
    const data = await this.fetchJson(
      "/api/collections/containers/records?perPage=500&sort=system%2Cname"
    );
    return data.items;
  }
  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------
  async ensureToken() {
    const now = Date.now();
    if (this.token && now - this.tokenTime < TOKEN_REFRESH_MS) {
      return;
    }
    await this.authenticate();
  }
  async authenticate() {
    const body = JSON.stringify({
      identity: this.username,
      password: this.password
    });
    const data = await this.request(
      "POST",
      "/api/collections/users/auth-with-password",
      body,
      null
      // no auth token yet
    );
    this.token = data.token;
    this.tokenTime = Date.now();
  }
  async fetchJson(path) {
    return this.request("GET", path, null, this.token);
  }
  request(method, path, body, token) {
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
        timeout: 15e3
      };
      const req = transport.request(options, (res) => {
        const chunks = [];
        res.on("data", (chunk) => chunks.push(chunk));
        res.on("end", () => {
          var _a;
          const raw = Buffer.concat(chunks).toString("utf8");
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            const err = new Error(
              `HTTP ${(_a = res.statusCode) != null ? _a : "?"}: ${raw.slice(0, 200)}`
            );
            err.code = res.statusCode === 401 ? "UNAUTHORIZED" : "HTTP_ERROR";
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
      req.on("timeout", () => {
        req.destroy();
        reject(new Error(`Request to ${path} timed out`));
      });
      req.on("error", (err) => reject(err));
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
