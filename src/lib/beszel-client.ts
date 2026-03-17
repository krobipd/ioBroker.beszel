import * as http from "http";
import * as https from "https";
import { URL } from "url";
import type {
  AuthResponse,
  BeszelContainer,
  BeszelSystem,
  BeszelSystemStats,
  PocketBaseList,
  SystemStats,
} from "./types.js";

const TOKEN_REFRESH_MS = 23 * 60 * 60 * 1000; // 23 hours

/**
 * HTTP client for the Beszel PocketBase REST API.
 * Uses only Node.js built-in http/https — no extra dependencies.
 */
export class BeszelClient {
  private readonly baseUrl: string;
  private readonly username: string;
  private readonly password: string;

  private token: string | null = null;
  private tokenTime = 0;

  constructor(url: string, username: string, password: string) {
    // Strip trailing slash
    this.baseUrl = url.replace(/\/+$/, "");
    this.username = username;
    this.password = password;
  }

  /** Force token re-authentication on the next request */
  public invalidateToken(): void {
    this.token = null;
    this.tokenTime = 0;
  }

  /**
   * Test the connection to Beszel.
   * Returns { success: true } or { success: false, message: reason }.
   */
  public async checkConnection(): Promise<{
    success: boolean;
    message: string;
  }> {
    try {
      this.invalidateToken();
      await this.authenticate();
      return { success: true, message: "Connected successfully" };
    } catch (err) {
      return {
        success: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  /** Fetch all systems */
  public async getSystems(): Promise<BeszelSystem[]> {
    await this.ensureToken();
    const data = await this.fetchJson<PocketBaseList<BeszelSystem>>(
      "/api/collections/systems/records?perPage=200&sort=name",
    );
    return data.items;
  }

  /**
   * Fetch the latest 1m stats per system.
   * Returns a Map<systemId, SystemStats>.
   *
   * @param systemIds
   */
  public async getLatestStats(
    systemIds: string[],
  ): Promise<Map<string, SystemStats>> {
    if (systemIds.length === 0) {
      return new Map();
    }
    await this.ensureToken();
    const data = await this.fetchJson<PocketBaseList<BeszelSystemStats>>(
      "/api/collections/system_stats/records?sort=-updated&perPage=200&filter=type%3D'1m'",
    );

    // Deduplicate: keep the newest record per system
    const result = new Map<string, SystemStats>();
    for (const record of data.items) {
      if (!result.has(record.system)) {
        result.set(record.system, record.stats);
      }
    }
    return result;
  }

  /** Fetch all containers */
  public async getContainers(): Promise<BeszelContainer[]> {
    await this.ensureToken();
    const data = await this.fetchJson<PocketBaseList<BeszelContainer>>(
      "/api/collections/containers/records?perPage=500&sort=system%2Cname",
    );
    return data.items;
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async ensureToken(): Promise<void> {
    const now = Date.now();
    if (this.token && now - this.tokenTime < TOKEN_REFRESH_MS) {
      return;
    }
    await this.authenticate();
  }

  private async authenticate(): Promise<void> {
    const body = JSON.stringify({
      identity: this.username,
      password: this.password,
    });

    const data = await this.request<AuthResponse>(
      "POST",
      "/api/collections/users/auth-with-password",
      body,
      null, // no auth token yet
    );

    this.token = data.token;
    this.tokenTime = Date.now();
  }

  private async fetchJson<T>(path: string): Promise<T> {
    return this.request<T>("GET", path, null, this.token);
  }

  private request<T>(
    method: string,
    path: string,
    body: string | null,
    token: string | null,
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(this.baseUrl + path);
      } catch {
        reject(new Error(`Invalid URL: ${this.baseUrl + path}`));
        return;
      }

      const isHttps = parsedUrl.protocol === "https:";
      const transport = isHttps ? https : http;

      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        Accept: "application/json",
      };
      if (token) {
        headers.Authorization = token;
      }
      if (body !== null) {
        headers["Content-Length"] = Buffer.byteLength(body).toString();
      }

      const options: http.RequestOptions = {
        hostname: parsedUrl.hostname,
        port: parsedUrl.port || (isHttps ? 443 : 80),
        path: parsedUrl.pathname + parsedUrl.search,
        method,
        headers,
        timeout: 15000,
      };

      const req = transport.request(options, (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const raw = Buffer.concat(chunks).toString("utf8");
          if (
            !res.statusCode ||
            res.statusCode < 200 ||
            res.statusCode >= 300
          ) {
            // Propagate 401 specifically so caller can re-auth
            const err = new Error(
              `HTTP ${res.statusCode ?? "?"}: ${raw.slice(0, 200)}`,
            );
            (err as NodeJS.ErrnoException).code =
              res.statusCode === 401 ? "UNAUTHORIZED" : "HTTP_ERROR";
            reject(err);
            return;
          }
          try {
            resolve(JSON.parse(raw) as T);
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
