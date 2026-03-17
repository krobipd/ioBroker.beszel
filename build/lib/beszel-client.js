"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.BeszelClient = void 0;
const http = __importStar(require("http"));
const https = __importStar(require("https"));
const url_1 = require("url");
const TOKEN_REFRESH_MS = 23 * 60 * 60 * 1000; // 23 hours
/**
 * HTTP client for the Beszel PocketBase REST API.
 * Uses only Node.js built-in http/https — no extra dependencies.
 */
class BeszelClient {
    baseUrl;
    username;
    password;
    token = null;
    tokenTime = 0;
    constructor(url, username, password) {
        // Strip trailing slash
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
        }
        catch (err) {
            return {
                success: false,
                message: err instanceof Error ? err.message : String(err),
            };
        }
    }
    /** Fetch all systems */
    async getSystems() {
        await this.ensureToken();
        const data = await this.fetchJson("/api/collections/systems/records?perPage=200&sort=name");
        return data.items;
    }
    /**
     * Fetch the latest 1m stats per system.
     * Returns a Map<systemId, SystemStats>.
     *
     * @param systemIds
     */
    async getLatestStats(systemIds) {
        if (systemIds.length === 0) {
            return new Map();
        }
        await this.ensureToken();
        const data = await this.fetchJson("/api/collections/system_stats/records?sort=-updated&perPage=200&filter=type%3D'1m'");
        // Deduplicate: keep the newest record per system
        const result = new Map();
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
        const data = await this.fetchJson("/api/collections/containers/records?perPage=500&sort=system%2Cname");
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
            password: this.password,
        });
        const data = await this.request("POST", "/api/collections/users/auth-with-password", body, null);
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
                parsedUrl = new url_1.URL(this.baseUrl + path);
            }
            catch {
                reject(new Error(`Invalid URL: ${this.baseUrl + path}`));
                return;
            }
            const isHttps = parsedUrl.protocol === "https:";
            const transport = isHttps ? https : http;
            const headers = {
                "Content-Type": "application/json",
                Accept: "application/json",
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
                timeout: 15000,
            };
            const req = transport.request(options, (res) => {
                const chunks = [];
                res.on("data", (chunk) => chunks.push(chunk));
                res.on("end", () => {
                    const raw = Buffer.concat(chunks).toString("utf8");
                    if (!res.statusCode ||
                        res.statusCode < 200 ||
                        res.statusCode >= 300) {
                        // Propagate 401 specifically so caller can re-auth
                        const err = new Error(`HTTP ${res.statusCode ?? "?"}: ${raw.slice(0, 200)}`);
                        err.code =
                            res.statusCode === 401 ? "UNAUTHORIZED" : "HTTP_ERROR";
                        reject(err);
                        return;
                    }
                    try {
                        resolve(JSON.parse(raw));
                    }
                    catch {
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
exports.BeszelClient = BeszelClient;
