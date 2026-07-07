import * as http from "node:http";
import * as https from "node:https";
import { URL } from "node:url";
import {
  coerceAuthResponse,
  coerceContainer,
  coercePocketBaseList,
  coerceSystem,
  coerceSystemDetailsRecord,
  coerceSystemStatsRecord,
  errText,
  sanitizeForLog,
} from "./coerce";
import type { BeszelContainer, BeszelErrorCode, BeszelSystem, SystemDetails, SystemStats } from "./types";

const TOKEN_REFRESH_MS = 23 * 60 * 60 * 1000; // 23 hours
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * v0.4.4: optional logger injected by the adapter so the HTTP client can
 * trace its own request/response lifecycle, token-auth path, pagination
 * walk and 429-retry behaviour. When omitted (e.g. in tests), every
 * `this.log?.debug(...)` call is a no-op — keeps the existing positional
 * signature backward-compatible.
 */
export interface BeszelClientLogger {
  /** Adapter debug log. Called at most once per request/auth/page decision. */
  debug(message: string): void;
  /** Adapter warn log. Called only for `MAX_PAGES` truncation (rare). */
  warn(message: string): void;
}
/**
 * v0.4.3 (B2): pagination size per page. PocketBase caps perPage at 500;
 * we use 200 and follow `totalPages` to fetch the rest.
 */
const PAGE_SIZE = 200;
/** Defensive cap on pagination round-trips (50 × 200 = 10 000 records). */
const MAX_PAGES = 50;

/**
 * SEC-5: defensive cap on a single HTTP response body. A page of 200 PocketBase
 * records is well under 16 MiB; a larger response implies a compromised / MITM /
 * buggy Hub and is aborted before buffering it can OOM the adapter — the
 * per-request timeout only bounds socket inactivity, not total bytes.
 */
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

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
  /**
   * v0.4.3 (B1): in-flight authenticate-promise so concurrent requests
   * share a single auth round-trip.
   */
  private authInFlight: Promise<void> | null = null;
  /** v0.4.3 (B5): per-request timeout in ms (default 15 s). */
  private readonly timeoutMs: number;
  /**
   * v0.4.3 (B8): set of in-flight `AbortController`s. `cancelAll()` aborts
   * every running request — called from `onUnload`.
   */
  private readonly inflight = new Set<AbortController>();
  /** v0.4.4: optional logger for the HTTP-layer / auth / pagination trace. */
  private readonly log?: BeszelClientLogger;
  /**
   * Injected delay — production passes the adapter-managed `this.delay.bind(this)`
   * (auto-cancels on unload). When omitted (only outside the adapter, e.g. a bare
   * unit-test client), it degrades to an immediate resolve — i.e. the 429-retry
   * fires without back-off rather than pulling in a plain `setTimeout`.
   */
  private readonly delay: (ms: number) => Promise<void>;

  /**
   * @param url Beszel Hub base URL, e.g. http://192.168.1.100:8090
   * @param username Login username
   * @param password Login password
   * @param timeoutMs Per-request HTTP timeout in milliseconds (default 15 000)
   * @param log Optional adapter logger for HTTP/auth/pagination trace (v0.4.4)
   * @param delay Injected delay function — adapter passes `this.delay.bind(this)` (auto-cancels on unload)
   */
  constructor(
    url: string,
    username: string,
    password: string,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    log?: BeszelClientLogger,
    delay?: (ms: number) => Promise<void>,
  ) {
    // Strip trailing slash
    this.baseUrl = url.replace(/\/+$/, "");
    this.username = username;
    this.password = password;
    this.timeoutMs = timeoutMs > 0 ? timeoutMs : DEFAULT_TIMEOUT_MS;
    this.log = log;
    // Default is a no-back-off immediate resolve — NOT a plain setTimeout. In the
    // adapter the real (cancel-on-unload) delay is always injected (main.ts +
    // makeTestClientFactory), so this fallback is never used in production.
    this.delay = delay ?? ((): Promise<void> => Promise.resolve());
  }

  /** Force token re-authentication on the next request */
  public invalidateToken(): void {
    // v0.4.4 (B5): trace the explicit invalidation — usually called from the
    // poll-loop after a 401, so this is the breadcrumb that connects "auth
    // failure" to "fresh-auth attempt on next request".
    this.log?.debug("invalidateToken: cleared (forces fresh auth on next request)");
    this.token = null;
    this.tokenTime = 0;
  }

  /**
   * v0.4.3 (B8): abort every in-flight request. Called from `onUnload`
   * so a slow Hub doesn't keep the adapter alive past js-controller's
   * 4-second kill deadline.
   */
  public cancelAll(): void {
    // v0.4.4 (A12): trace shutdown anchor with the count of aborts.
    this.log?.debug(`cancelAll: aborting ${this.inflight.size} inflight requests`);
    for (const ctrl of this.inflight) {
      ctrl.abort();
    }
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
      return { success: false, message: errText(err) };
    }
  }

  /** Fetch all systems (paginated, B2 v0.4.3) */
  public async getSystems(): Promise<BeszelSystem[]> {
    await this.ensureToken();
    const items = await this.fetchAllPages("/api/collections/systems/records?sort=name", coerceSystem);
    return items.filter((s): s is BeszelSystem => s !== null);
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
   *
   * v0.7.2: early-exit — the Hub keeps ~8 h of 1m records (480 per system),
   * but only the newest record per system is consumed, and `sort=-updated`
   * puts those on the earliest pages. Walking the full history burned one
   * round-trip per 200 stale records on every poll. We stop as soon as a
   * page contributes no new system to the map. Trade-off: a system whose
   * last 1m record is hours old (agent down) no longer gets those stale
   * stats applied — it is offline via `status` anyway and its states simply
   * keep their last values.
   */
  public async getLatestStats(): Promise<Map<string, SystemStats>> {
    await this.ensureToken();
    const result = new Map<string, SystemStats>();
    await this.fetchAllPages(
      "/api/collections/system_stats/records?sort=-updated&filter=type%3D'1m'",
      coerceSystemStatsRecord,
      pageItems => {
        // Deduplicate: keep the newest record per system.
        let addedNew = false;
        for (const record of pageItems) {
          if (record && !result.has(record.system)) {
            result.set(record.system, record.stats);
            addedNew = true;
          }
        }
        return addedNew; // a page of only-known systems ends the walk
      },
    );
    return result;
  }

  /**
   * Fetch static system details (Beszel v0.18.0+), keyed by system id.
   * Returns an empty Map on an older Hub without the collection (the list
   * endpoint 404s → caught by the caller, which treats details as absent).
   *
   * Access is scoped to the user's own systems (same `systemScopedReadRule`
   * as system_stats), so the regular auth token used everywhere else works.
   * Called rarely (start + new-system), not in every poll — the data is
   * static (changes only on agent restart/upgrade).
   */
  public async getSystemDetails(): Promise<Map<string, SystemDetails>> {
    await this.ensureToken();
    const items = await this.fetchAllPages("/api/collections/system_details/records", coerceSystemDetailsRecord);
    const result = new Map<string, SystemDetails>();
    for (const rec of items) {
      if (rec && !result.has(rec.system)) {
        result.set(rec.system, rec.details);
      }
    }
    return result;
  }

  /** Fetch all containers (paginated, B2 v0.4.3) */
  public async getContainers(): Promise<BeszelContainer[]> {
    await this.ensureToken();
    const items = await this.fetchAllPages("/api/collections/containers/records?sort=system%2Cname", coerceContainer);
    return items.filter((c): c is BeszelContainer => c !== null);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async ensureToken(): Promise<void> {
    const now = Date.now();
    if (this.token && now - this.tokenTime < TOKEN_REFRESH_MS) {
      // v0.4.4: cache-hit deliberately NOT logged — runs on every request,
      // would flood the debug log with no diagnostic value.
      return;
    }
    if (this.authInFlight) {
      // v0.4.4 (B1): trace concurrent-request wait. Diagnostically wertvoll
      // weil B1 (token-mutex) garantiert dass mehrere parallel-Requests
      // sich EINE auth-Roundtrip teilen — bei Bug-Report "weird auth burst"
      // erkennt der Maintainer ob der mutex greift.
      this.log?.debug("ensureToken: waiting for in-flight authenticate");
      await this.authInFlight;
      return;
    }
    // v0.4.4 (B2): trace fresh-auth start with token-age (oder "none" wenn
    // noch keiner da war). Maintainer sieht "token expired after 23h" oder
    // "no token yet (first request)" eindeutig.
    const tokenAge = this.token ? `${Date.now() - this.tokenTime}ms` : "none";
    this.log?.debug(`ensureToken: fresh authentication (previous token age=${tokenAge})`);
    this.authInFlight = this.authenticate().finally(() => {
      this.authInFlight = null;
    });
    await this.authInFlight;
  }

  private async authenticate(): Promise<void> {
    const body = JSON.stringify({
      identity: this.username,
      password: this.password,
    });

    const raw = await this.request<unknown>(
      "POST",
      "/api/collections/users/auth-with-password",
      body,
      null, // no auth token yet
    );

    const auth = coerceAuthResponse(raw);
    if (auth === null) {
      // v0.4.4 (B4): trace API-drift in the auth response (e.g. PocketBase
      // schema change, partial response). Without this the throw lands as
      // a generic INVALID_AUTH_RESPONSE without anchor for what was missing.
      this.log?.debug("authenticate: response missing valid token (drift), throwing INVALID_AUTH_RESPONSE");
      const err = new Error("Auth response missing valid token");
      (err as NodeJS.ErrnoException).code = "INVALID_AUTH_RESPONSE" satisfies BeszelErrorCode;
      throw err;
    }
    this.token = auth.token;
    this.tokenTime = Date.now();
    // v0.4.4 (B3): trace successful authentication with the cache-window.
    this.log?.debug(`authenticate: success (token cached for ${TOKEN_REFRESH_MS}ms)`);
  }

  private async fetchJson<T>(path: string): Promise<T> {
    return this.request<T>("GET", path, null, this.token);
  }

  /**
   * v0.4.3 (B2): walk every PocketBase page and accumulate the items.
   * Stops at `MAX_PAGES` defensively. Splits `path` on `?` so we can
   * always append our own `page=` and `perPage=`.
   *
   * @param path The collection-records path (with or without query string).
   * @param itemCoercer Per-item coercer; `null` items are dropped by the caller.
   * @param consumePage Optional per-page consumer (v0.7.2). Receives each
   *   page's coerced items; returning `false` stops the walk early — used by
   *   `getLatestStats` to stop once a page contributes nothing new instead
   *   of paging through hours of historical records on every poll.
   */
  private async fetchAllPages<T>(
    path: string,
    itemCoercer: (raw: unknown) => T | null,
    consumePage?: (pageItems: (T | null)[]) => boolean,
  ): Promise<(T | null)[]> {
    const sep = path.includes("?") ? "&" : "?";
    const out: (T | null)[] = [];
    let totalPages = 1;
    for (let page = 1; page <= Math.min(totalPages, MAX_PAGES); page++) {
      const pagedPath = `${path}${sep}page=${page}&perPage=${PAGE_SIZE}`;
      const raw = await this.fetchJson<unknown>(pagedPath);
      const list = coercePocketBaseList(raw, itemCoercer);
      out.push(...list.items);
      totalPages = list.totalPages > 0 ? list.totalPages : 1;
      // v0.4.4 (C1): trace multi-page walk (page 2+). Single-page setups
      // stay silent — only big installs (>200 records) emit one line per page.
      if (page > 1) {
        this.log?.debug(`fetchAllPages: page ${page}/${totalPages} for ${path}`);
      }
      if (list.items.length === 0) {
        break;
      }
      if (consumePage && !consumePage(list.items)) {
        this.log?.debug(`fetchAllPages: early-exit at page ${page}/${totalPages} for ${path} (no new entries)`);
        return out;
      }
    }
    // v0.4.4 (C2): warn (not debug) when totalPages exceeds MAX_PAGES — the
    // returned list is truncated, so users with 200+ system installs would
    // silently lose data. Rare event (>10k records), no spam-risk at warn.
    if (totalPages > MAX_PAGES) {
      this.log?.warn(
        `fetchAllPages: truncated at MAX_PAGES=${MAX_PAGES} (totalPages=${totalPages}, data may be incomplete) for ${path}`,
      );
    }
    return out;
  }

  private async request<T>(method: string, path: string, body: string | null, token: string | null): Promise<T> {
    // v0.4.3 (B3): one transparent retry on 429 honouring `Retry-After`.
    try {
      return await this.requestOnce<T>(method, path, body, token);
    } catch (err) {
      const e = err as NodeJS.ErrnoException & { retryAfter?: number };
      // F6: token expired mid-life (401 on an authenticated request) → reauth
      // once and retry transparently so a single expiry doesn't burn a whole
      // poll. The auth request itself (token === null) is never retried here,
      // and if the retry also 401s it propagates to the poll's auth-backoff.
      if (e.code === "UNAUTHORIZED" && token !== null) {
        // INFO: only re-auth if the token that got the 401 is still current.
        // Under parallel 401s the first request refreshes the token; the rest
        // must retry with the fresh token instead of each burning a redundant
        // re-auth (and clobbering the just-refreshed token via invalidateToken).
        if (this.token === token) {
          this.log?.debug(`request: 401 on ${path} — re-authenticating and retrying once`);
          this.invalidateToken();
          await this.ensureToken();
        } else {
          this.log?.debug(`request: 401 on ${path} — token already refreshed concurrently, retrying`);
        }
        return this.requestOnce<T>(method, path, body, this.token);
      }
      if (e.code !== "RATE_LIMITED") {
        throw err;
      }
      const retrySec = e.retryAfter ?? 1;
      const retryMs = Math.min(Math.max(1, retrySec), 30) * 1000;
      this.log?.debug(`request: 429 retry for ${path}, waiting ${retryMs}ms`);
      await this.delay(retryMs);
      return this.requestOnce<T>(method, path, body, token);
    }
  }

  private requestOnce<T>(method: string, path: string, body: string | null, token: string | null): Promise<T> {
    // v0.4.4 (A0): start timestamp for elapsed-ms in success/timeout/error
    // log lines. 1 LOC, no behavior change.
    const startedAt = Date.now();
    // v0.4.4 (A1): trace request entry. Cadence ~4 calls/poll × 1440 polls
    // /day at default 60s interval = ~5760 lines/day — acceptable at debug.
    this.log?.debug(`HTTP ${method} ${path}${body ? " (body)" : ""}`);
    return new Promise((resolve, reject) => {
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(this.baseUrl + path);
      } catch {
        // v0.4.4 (A10): trace invalid-URL drift before throwing.
        this.log?.debug(`HTTP invalid URL: ${this.baseUrl + path}`);
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
        // Beszel/PocketBase wants the bare token without "Bearer " prefix
        // (verified in Ressourcen/beszel/api-referenz.md:23).
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
        timeout: this.timeoutMs,
      };

      // v0.4.3 (B8): per-request AbortController so `cancelAll()` can abort
      // everything pending without waiting for the configured timeout.
      const ctrl = new AbortController();
      this.inflight.add(ctrl);
      const cleanup = (): void => {
        this.inflight.delete(ctrl);
      };

      const req = transport.request(options, res => {
        const chunks: Buffer[] = [];
        let received = 0;
        res.on("error", err => {
          cleanup();
          reject(err);
        });
        res.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > MAX_RESPONSE_BYTES) {
            // SEC-5: abort an oversized response before buffering it can OOM the
            // adapter (the per-request timeout bounds inactivity, not total bytes).
            // req.destroy(err) surfaces through req.on("error") below → reject.
            req.destroy(new Error(`Response from ${path} exceeded ${MAX_RESPONSE_BYTES} bytes`));
            return;
          }
          chunks.push(chunk);
        });
        res.on("end", () => {
          cleanup();
          const raw = Buffer.concat(chunks).toString("utf8");
          if (!res.statusCode || res.statusCode < 200 || res.statusCode >= 300) {
            // L4/SEC-8: the Hub-controlled body can carry CR/LF — run it through
            // sanitizeForLog so a hostile/MITM Hub cannot forge extra log lines via
            // the error message (which propagates to the poll's debug log).
            const err = new Error(
              `HTTP ${res.statusCode ?? "?"}: ${sanitizeForLog(raw.slice(0, 200))}`,
            ) as NodeJS.ErrnoException & {
              retryAfter?: number;
            };
            // v0.4.3 (B3+B4'): distinct error classes — 401 reauth, 429 backoff,
            // 403 perms hint, anything else generic. F4: the codes are typed.
            if (res.statusCode === 401) {
              err.code = "UNAUTHORIZED" satisfies BeszelErrorCode;
            } else if (res.statusCode === 429) {
              err.code = "RATE_LIMITED" satisfies BeszelErrorCode;
              const ra = res.headers["retry-after"];
              if (typeof ra === "string") {
                const n = parseInt(ra, 10);
                if (Number.isFinite(n) && n > 0) {
                  err.retryAfter = n;
                }
              }
            } else if (res.statusCode === 403) {
              err.code = "FORBIDDEN" satisfies BeszelErrorCode;
            } else {
              err.code = "HTTP_ERROR" satisfies BeszelErrorCode;
            }
            // v0.4.4 (A3): trace 4xx/5xx with status + error-code + body-snippet.
            this.log?.debug(
              `HTTP ${method} ${path} → ${res.statusCode} ${err.code} (body=${sanitizeForLog(raw.slice(0, 200))})`,
            );
            reject(err);
            return;
          }
          try {
            const parsed = JSON.parse(raw) as T;
            // v0.4.4 (A2): trace successful response with elapsed-ms + bytes.
            this.log?.debug(`HTTP ${method} ${path} → ${res.statusCode} (${Date.now() - startedAt}ms, ${raw.length}B)`);
            resolve(parsed);
          } catch {
            // v0.4.4 (A8): trace JSON parse-fail with body-snippet.
            this.log?.debug(`HTTP JSON parse fail ${path}: ${sanitizeForLog(raw.slice(0, 200))}`);
            reject(new Error(`Invalid JSON response from ${path}`));
          }
        });
      });

      ctrl.signal.addEventListener("abort", () => {
        // v0.4.4: A6 deliberately omitted — `req.destroy(Error)` propagates
        // through `req.on("error")` below where A7 already logs it.
        req.destroy(new Error("Request aborted"));
      });

      req.on("timeout", () => {
        req.destroy();
        cleanup();
        // v0.4.4 (A5): trace timeout with elapsed.
        this.log?.debug(`HTTP timeout ${method} ${path} (${Date.now() - startedAt}ms)`);
        // N6: tag the timeout with ETIMEDOUT so classifyError doesn't depend on a
        // message substring — a reworded message would silently degrade TIMEOUT to
        // UNKNOWN and break the F3 system_details retry.
        const timeoutErr = new Error(`Request to ${path} timed out`) as NodeJS.ErrnoException;
        timeoutErr.code = "ETIMEDOUT" satisfies BeszelErrorCode;
        reject(timeoutErr);
      });

      req.on("error", err => {
        cleanup();
        // v0.4.4 (A7): trace network / abort / TLS / DNS errors with elapsed.
        // Also catches the abort case (req.destroy(Error("Request aborted")))
        // — A6 deliberately not emitted to avoid double-log.
        this.log?.debug(`HTTP error ${method} ${path} (${Date.now() - startedAt}ms): ${err.message}`);
        reject(err);
      });

      if (body !== null) {
        req.write(body);
      }
      req.end();
    });
  }
}
