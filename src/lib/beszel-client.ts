import * as http from "node:http";
import * as https from "node:https";
import { URL } from "node:url";
import {
  coerceAuthResponse,
  coerceContainer,
  coerceSmartDevice,
  coerceSystemdService,
  coerceZfsPoolDetail,
  coerceObject,
  coercePocketBaseList,
  coerceSystem,
  coerceSystemDetailsRecord,
  coerceSystemStatsRecord,
  errText,
  sanitizeForLog,
} from "./coerce";
import type {
  BeszelContainer,
  BeszelErrorCode,
  BeszelSystem,
  SmartDevice,
  SystemDetails,
  SystemdService,
  SystemStats,
  ZfsPoolDetail,
} from "./types";

/**
 * Upper bound for re-using a token. The real lifetime comes from the token's own `exp`
 * claim (a `users` token lives 5 days by default — PocketBase
 * `collection_model_auth_options.go`, measured on a 0.20.0 Hub); this cap only matters
 * when `exp` is unreadable.
 */
const TOKEN_REFRESH_MS = 23 * 60 * 60 * 1000; // 23 hours
/** Renew this long before the token's `exp`, so no request races the expiry. */
const TOKEN_EXPIRY_MARGIN_MS = 5 * 60 * 1000;
const DEFAULT_TIMEOUT_MS = 15_000;

/**
 * Expiry (epoch ms) from a PocketBase JWT's `exp` claim, or `null` when the token is not
 * a readable JWT. Only the payload is decoded — the signature is the Hub's business.
 *
 * @param token The auth token.
 */
export function tokenExpiryMs(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3) {
    return null;
  }
  try {
    const payload: unknown = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    const exp = coerceObject(payload)?.exp;
    return typeof exp === "number" && Number.isFinite(exp) && exp > 0 ? exp * 1000 : null;
  } catch {
    return null;
  }
}

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
 * Page size of a list read. PocketBase caps `perPage` at 1000 (`tools/search/provider.go`
 * `MaxPerPage`; a request for 2000 is answered with 1000, measured), so a whole
 * collection normally arrives in one request.
 */
const PAGE_SIZE = 1000;
/**
 * Page size of the two newest-first walks (`system_stats`, `network_monitor_stats`):
 * they stop as soon as a page brings nothing new, so a small page is the cheaper one —
 * the Hub keeps an hour of minute records per system and the walk needs only the head.
 */
const WALK_PAGE_SIZE = 200;
/**
 * Defensive cap on pagination round-trips (50 × 1000 = 50 000 records). Hitting it
 * throws `TRUNCATED` instead of handing out a partial list: a partial list reads as
 * "these records are gone" and prunes datapoints that still exist on the Hub.
 */
const MAX_PAGES = 50;

/**
 * SEC-5: defensive cap on a single HTTP response body. A page of 200 PocketBase
 * records is well under 16 MiB; a larger response implies a compromised / MITM /
 * buggy Hub and is aborted before buffering it can OOM the adapter — the
 * per-request timeout only bounds socket inactivity, not total bytes.
 */
const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

/**
 * Host name to hand to the socket connect. `URL.hostname` keeps the brackets of an
 * IPv6 literal (`http://[fd00::1]:8090` → `[fd00::1]`), and Node's http client passes
 * that to the resolver verbatim — `getaddrinfo ENOTFOUND [fd00::1]` (measured on
 * Node 22), so a Hub configured by IPv6 address was never reachable.
 * `url.urlToHttpOptions` strips the brackets the same way.
 *
 * @param hostname `URL.hostname` of the Hub URL
 */
export function hostnameForRequest(hostname: string): string {
  return hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
}

/**
 * Port to hand to the socket connect. `URL.port` is the EMPTY STRING when the URL
 * carries no explicit port (`http://hub/`), and handing that to Node means port 0 —
 * a connect that can never succeed. The scheme's default fills in instead.
 *
 * Exported so the rule can be measured directly: a test that instead points the client
 * at `http://127.0.0.1` and expects "connection refused" measures the machine it runs
 * on, not this rule — the GitHub Windows runner answers HTTP 404 on port 80.
 *
 * @param parsedUrl Parsed Hub URL
 */
export function portForRequest(parsedUrl: URL): number {
  return parsedUrl.port ? Number(parsedUrl.port) : parsedUrl.protocol === "https:" ? 443 : 80;
}

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
  /** When the current token is due for renewal (epoch ms). */
  private tokenRenewAt = 0;
  /**
   * Set by {@link cancelAll}: the client is shutting down, so a request that starts
   * afterwards (a retry, the next step of a poll) is refused at once instead of going
   * out after the abort.
   */
  private closed = false;
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
    // The caller hands the normalised URL; trim + strip once more so a direct caller
    // cannot reintroduce the trailing-space failure.
    this.baseUrl = url.trim().replace(/\/+$/, "");
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
    this.tokenRenewAt = 0;
  }

  /**
   * v0.4.3 (B8): abort every in-flight request. Called from `onUnload`
   * so a slow Hub doesn't keep the adapter alive past js-controller's
   * 4-second kill deadline.
   */
  public cancelAll(): void {
    // v0.4.4 (A12): trace shutdown anchor with the count of aborts.
    this.log?.debug(`cancelAll: aborting ${this.inflight.size} inflight requests`);
    this.closed = true;
    for (const ctrl of this.inflight) {
      ctrl.abort();
    }
  }

  /**
   * Test the connection to Beszel: log in, then ask how many systems this account can
   * see. A login alone proved nothing — an account that is assigned to no system (and a
   * Hub without `SHARE_ALL_SYSTEMS`) logs in fine and then reads an empty list forever.
   * Returns the count, or the raw error text; the caller turns it into the user's language.
   */
  public async checkConnection(): Promise<{ success: true; systems: number } | { success: false; reason: string }> {
    try {
      this.invalidateToken();
      await this.authenticate();
      const raw = await this.fetchJson<unknown>("/api/collections/systems/records?page=1&perPage=1");
      const list = coercePocketBaseList(raw, coerceSystem);
      if (!list.valid) {
        throw BeszelClient.coded(new Error("The Hub's answer is not a record list"), "INVALID_RESPONSE");
      }
      return { success: true, systems: list.totalItems };
    } catch (err) {
      return { success: false, reason: errText(err) };
    }
  }

  /**
   * Tag an error with one of the client's codes.
   *
   * @param err The error.
   * @param code The code.
   */
  private static coded(err: Error, code: BeszelErrorCode): NodeJS.ErrnoException {
    const tagged: NodeJS.ErrnoException = err;
    tagged.code = code;
    return tagged;
  }

  /** Fetch all systems (paginated, B2 v0.4.3) */
  public async getSystems(): Promise<BeszelSystem[]> {
    await this.ensureToken();
    return this.fetchAllPages("/api/collections/systems/records?sort=name", coerceSystem);
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
   * v0.7.2: early-exit — the Hub keeps one hour of 1m records (60 per system,
   * `internal/records/records_deletion.go` of Beszel 0.19.0), but only the newest
   * record per system is consumed, and `sort=-updated` puts those on the earliest
   * pages. Walking the full history burned one round-trip per 200 stale records on
   * every poll. We stop as soon as a page contributes no new system to the map.
   * Trade-off: a system whose last 1m record is older than the walk (agent down) no
   * longer gets those stale stats applied — it is offline via `status` anyway and
   * its states simply keep their last values. With more than ~200 systems a page
   * full of repeats could end the walk before a rarely-sampled system was seen.
   */
  public async getLatestStats(): Promise<Map<string, SystemStats>> {
    await this.ensureToken();
    const result = new Map<string, SystemStats>();
    await this.fetchAllPages(
      "/api/collections/system_stats/records?sort=-updated&filter=type%3D'1m'",
      coerceSystemStatsRecord,
      WALK_PAGE_SIZE,
      pageItems => {
        // Deduplicate: keep the newest record per system.
        let addedNew = false;
        for (const record of pageItems) {
          if (!result.has(record.system)) {
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
    const items = await this.fetchAllPages(
      "/api/collections/system_details/records?sort=system",
      coerceSystemDetailsRecord,
    );
    const result = new Map<string, SystemDetails>();
    for (const rec of items) {
      if (!result.has(rec.system)) {
        result.set(rec.system, rec.details);
      }
    }
    return result;
  }

  /**
   * ZFS pool DETAIL records (`zfs_pools`) — scrub state, vdev error counters and
   * datasets. Separate from the per-poll summary in `stats.z`: the hub refreshes this
   * collection roughly hourly (`system_zfs.go:zfsFetchInterval`), so the adapter reads
   * it on a slow cadence rather than every poll.
   *
   * Read access is the same `systemScopedReadRule` as `system_stats`.
   */
  public async getZfsPoolDetails(): Promise<ZfsPoolDetail[]> {
    await this.ensureToken();
    this.log?.debug("HTTP getZfsPoolDetails");
    return this.fetchAllPages("/api/collections/zfs_pools/records?sort=system%2Cname", coerceZfsPoolDetail);
  }

  /**
   * SMART device records (`smart_devices`) — the overall verdict plus model, serial,
   * temperature, capacity, power-on hours and power cycles. Slow-moving like the ZFS
   * details, so it shares their cadence.
   */
  public async getSmartDevices(): Promise<SmartDevice[]> {
    await this.ensureToken();
    this.log?.debug("HTTP getSmartDevices");
    return this.fetchAllPages("/api/collections/smart_devices/records?sort=system%2Cname", coerceSmartDevice);
  }

  /**
   * systemd unit records (`systemd_services`) — state, sub-state, CPU and memory per
   * unit. The hub rewrites the whole batch on every agent sample, so unlike the two
   * detail collections above this one is read on every poll, next to the containers.
   *
   * ⚠️ Only the `list` rule is granted for this collection (`internal/hub/collections.go`)
   * — paging the list is the only permitted access, a single-record read is refused.
   */
  public async getSystemdServices(): Promise<SystemdService[]> {
    await this.ensureToken();
    this.log?.debug("HTTP getSystemdServices");
    return this.fetchAllPages("/api/collections/systemd_services/records?sort=system%2Cname", coerceSystemdService);
  }

  /** Fetch all containers (paginated, B2 v0.4.3) */
  public async getContainers(): Promise<BeszelContainer[]> {
    await this.ensureToken();
    return this.fetchAllPages("/api/collections/containers/records?sort=system%2Cname", coerceContainer);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async ensureToken(): Promise<void> {
    const now = Date.now();
    if (this.token && now < this.tokenRenewAt) {
      // v0.4.4: cache-hit deliberately NOT logged — runs on every request,
      // would flood the debug log with no diagnostic value.
      return;
    }
    if (this.authInFlight) {
      // v0.4.4 (B1): trace the concurrent-request wait. Worth having: B1 (the token
      // mutex) is what guarantees several parallel requests share ONE auth round-trip,
      // so on a "weird auth burst" report this line shows whether the mutex holds.
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

    let raw: unknown;
    try {
      raw = await this.request<unknown>(
        "POST",
        "/api/collections/users/auth-with-password",
        body,
        null, // no auth token yet
      );
    } catch (err) {
      throw BeszelClient.classifyLoginFailure(err);
    }

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
    const expiry = tokenExpiryMs(auth.token);
    this.tokenRenewAt = Math.min(
      this.tokenTime + TOKEN_REFRESH_MS,
      expiry !== null ? expiry - TOKEN_EXPIRY_MARGIN_MS : Number.POSITIVE_INFINITY,
    );
    // v0.4.4 (B3): trace successful authentication with the cache-window.
    this.log?.debug(
      `authenticate: success (token renewed in ${this.tokenRenewAt - this.tokenTime}ms, exp ${expiry !== null ? "read" : "unreadable"})`,
    );
  }

  /**
   * Turn a failed login into its reason. PocketBase answers a login with a status of
   * its own (measured on a 0.20.0 Hub): 400 for wrong credentials — also a user name in
   * place of the e-mail and superuser credentials against `users` —, 401 with an `mfaId`
   * when one-time-password login is on, 403 when password login is switched off or the
   * account does not meet the auth rule. Before this, 400 read as a generic HTTP error
   * the auth back-off never saw, and every 403 as "check the user role".
   *
   * @param err The rejection of the login request.
   */
  private static classifyLoginFailure(err: unknown): unknown {
    const e = err as NodeJS.ErrnoException & { status?: number; hubMessage?: string; mfa?: boolean };
    if (!(err instanceof Error) || typeof e.status !== "number") {
      return err;
    }
    const said = e.hubMessage ? `: ${e.hubMessage}` : "";
    if (e.status === 400) {
      return BeszelClient.coded(new Error(`Login rejected${said}`), "AUTH_FAILED");
    }
    if (e.status === 401 && e.mfa) {
      return BeszelClient.coded(new Error("Login needs a one-time password (MFA)"), "MFA_REQUIRED");
    }
    if (e.status === 403) {
      const disabled = /not configured to allow password authentication/i.test(e.hubMessage ?? "");
      return BeszelClient.coded(
        new Error(`Login refused${said}`),
        disabled ? "PASSWORD_AUTH_DISABLED" : "AUTH_FORBIDDEN",
      );
    }
    return err;
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
   * @param itemCoercer Per-item coercer; a record it rejects is dropped by
   *   `coercePocketBaseList`, so neither this method nor its callers ever see a
   *   `null` item (v0.16.0 — the nullable type and the callers' re-filtering were
   *   left over from before that).
   * @param perPage Records per request — {@link PAGE_SIZE} for a full read,
   *   {@link WALK_PAGE_SIZE} for a newest-first walk that stops early.
   * @param consumePage Optional per-page consumer (v0.7.2). Receives each
   *   page's coerced items; returning `false` stops the walk early — used by
   *   `getLatestStats` to stop once a page contributes nothing new instead
   *   of paging through hours of historical records on every poll.
   */
  private async fetchAllPages<T>(
    path: string,
    itemCoercer: (raw: unknown) => T | null,
    perPage: number = PAGE_SIZE,
    consumePage?: (pageItems: T[]) => boolean,
  ): Promise<T[]> {
    const sep = path.includes("?") ? "&" : "?";
    const out: T[] = [];
    let totalPages = 1;
    // The walk reached the cap with records still coming — only then is the list partial.
    // A page with no records ends it early (a Hub mis-reporting `totalPages` included).
    let cappedWithMore = false;
    for (let page = 1; page <= Math.min(totalPages, MAX_PAGES); page++) {
      const pagedPath = `${path}${sep}page=${page}&perPage=${perPage}`;
      const raw = await this.fetchJson<unknown>(pagedPath);
      const list = coercePocketBaseList(raw, itemCoercer);
      if (!list.valid) {
        // Not a PocketBase list — a proxy page or another service at the URL. Reading it
        // as "no records" would let the empty-list paths act on a lie.
        throw BeszelClient.coded(new Error(`The answer from ${path} is not a record list`), "INVALID_RESPONSE");
      }
      out.push(...list.items);
      totalPages = list.totalPages > 0 ? list.totalPages : 1;
      // v0.4.4 (C1): trace multi-page walk (page 2+). Single-page setups
      // stay silent — only big installs (>200 records) emit one line per page.
      if (page > 1) {
        this.log?.debug(`fetchAllPages: page ${page}/${totalPages} for ${path}`);
      }
      // Raw count, not the coerced one: a page whose records all failed coercion
      // (a malformed row on the Hub) still means "there is more behind this" —
      // ending the walk there would silently truncate every later page.
      if (list.rawCount === 0) {
        break;
      }
      if (consumePage && !consumePage(list.items)) {
        this.log?.debug(`fetchAllPages: early-exit at page ${page}/${totalPages} for ${path} (no new entries)`);
        return out;
      }
      cappedWithMore = page === MAX_PAGES && totalPages > MAX_PAGES;
    }
    if (cappedWithMore) {
      // A partial list must not leave here as if it were complete: every record behind
      // the cap would read as "gone" and its datapoints would be pruned. The caller
      // freezes instead (and logs once).
      throw BeszelClient.coded(
        new Error(`${path} has ${totalPages} pages, more than the ${MAX_PAGES} the adapter reads`),
        "TRUNCATED",
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
        } else {
          this.log?.debug(`request: 401 on ${path} — token already refreshed concurrently, retrying`);
        }
        // Both ways wait for a token: a concurrent re-auth may have cleared it and still be
        // in flight — sending the retry without one would be a guest request, which
        // PocketBase answers with an empty list instead of an error.
        await this.ensureToken();
        if (this.token === null) {
          throw err;
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
      if (this.closed) {
        reject(BeszelClient.coded(new Error("Request aborted"), "ABORTED"));
        return;
      }
      let parsedUrl: URL;
      try {
        parsedUrl = new URL(this.baseUrl + path);
      } catch {
        // v0.4.4 (A10): trace invalid-URL drift before throwing.
        this.log?.debug(`HTTP invalid URL: ${sanitizeForLog(this.baseUrl + path)}`);
        reject(BeszelClient.coded(new Error(`Invalid URL: ${sanitizeForLog(this.baseUrl + path)}`), "INVALID_URL"));
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
        // (verified against the v0.18.7 API).
        headers.Authorization = token;
      }
      if (body !== null) {
        headers["Content-Length"] = Buffer.byteLength(body).toString();
      }

      const options: http.RequestOptions = {
        hostname: hostnameForRequest(parsedUrl.hostname),
        port: portForRequest(parsedUrl),
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
          // Tear the request down like the timeout path does — without this the socket
          // can linger on the agent until its own keep-alive expires.
          req.destroy();
          cleanup();
          reject(err);
        });
        res.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > MAX_RESPONSE_BYTES) {
            // SEC-5: abort an oversized response before buffering it can OOM the
            // adapter (the per-request timeout bounds inactivity, not total bytes).
            // req.destroy(err) surfaces through req.on("error") below → reject.
            req.destroy(
              BeszelClient.coded(
                new Error(`Response from ${path} exceeded ${MAX_RESPONSE_BYTES} bytes`),
                "RESPONSE_TOO_LARGE",
              ),
            );
            return;
          }
          if (Date.now() - startedAt > this.timeoutMs) {
            // The socket timeout only measures silence: a peer that trickles a byte now
            // and then would hold the poll forever. The request as a whole gets the same
            // budget — no timer of its own, the next chunk is the checkpoint.
            this.log?.debug(`HTTP deadline exceeded ${method} ${path} (${Date.now() - startedAt}ms)`);
            req.destroy(BeszelClient.coded(new Error(`Request to ${path} timed out`), "ETIMEDOUT"));
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
              status?: number;
              hubMessage?: string;
              mfa?: boolean;
            };
            // PocketBase's own words and markers, for the login classification.
            err.status = res.statusCode;
            try {
              const parsedBody = coerceObject(JSON.parse(raw) as unknown);
              if (typeof parsedBody?.message === "string") {
                err.hubMessage = sanitizeForLog(parsedBody.message, 120);
              }
              err.mfa = typeof parsedBody?.mfaId === "string";
            } catch {
              // not JSON — the status alone has to do
            }
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
            } else if (res.statusCode === 404) {
              // A collection this Hub does not have (older release) — the caller may stop
              // asking for it, which a 5xx must never trigger.
              err.code = "NOT_FOUND" satisfies BeszelErrorCode;
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
            reject(BeszelClient.coded(new Error(`Invalid JSON response from ${path}`), "INVALID_RESPONSE"));
          }
        });
      });

      ctrl.signal.addEventListener("abort", () => {
        // v0.4.4: A6 deliberately omitted — `req.destroy(Error)` propagates
        // through `req.on("error")` below where A7 already logs it.
        req.destroy(BeszelClient.coded(new Error("Request aborted"), "ABORTED"));
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
        this.log?.debug(`HTTP error ${method} ${path} (${Date.now() - startedAt}ms): ${errText(err)}`);
        reject(err);
      });

      if (body !== null) {
        req.write(body);
      }
      req.end();
    });
  }
}
