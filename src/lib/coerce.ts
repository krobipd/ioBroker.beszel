import type {
  AuthResponse,
  BeszelContainer,
  BeszelSystem,
  BeszelSystemDetailsRecord,
  BeszelSystemStats,
  FsStats,
  GPUData,
  PocketBaseList,
  SystemDetails,
  SystemInfo,
  SystemStats,
} from "./types";

/**
 * Boundary validators for data coming in from the Beszel PocketBase API.
 *
 * Every field that ultimately reaches an ioBroker state goes through a
 * coercer so that API drift (missing fields, wrong types, NaN, Infinity,
 * object instead of primitive) cannot produce bad state values or crash
 * downstream code.
 */

const VALID_SYSTEM_STATUS = ["up", "down", "paused", "pending"] as const;
type SystemStatus = (typeof VALID_SYSTEM_STATUS)[number];

// Strict decimal regex — only optional minus sign + digits + optional fractional
// part. Rejects HEX (`0x...`), exponential (`1e3`), Infinity, and
// leading/trailing whitespace, which plain `Number()` would all accept.
// Same hardening as hassemu (E8, v1.9.0) and homewizard (D8) — fleet-wide
// consistency for the shared coerce-helper.
const DECIMAL_NUMBER_RE = /^-?\d+(\.\d+)?$/;

/**
 * Coerce any value into a finite number, returning null if not possible.
 * Accepts numbers directly; parses strict decimal strings; rejects NaN,
 * Infinity, HEX (`0x...`) and exponential notation (`1e3`).
 *
 * @param value Unknown value from external API
 */
export function coerceFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && DECIMAL_NUMBER_RE.test(value)) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

/**
 * Coerce into a non-empty string, returning null if the value is not a
 * string or is empty. Optionally caps the length to guard against very
 * large payloads.
 *
 * @param value Unknown value from external API
 * @param maxLength Maximum length of returned string
 */
export function coerceString(value: unknown, maxLength = 1024): string | null {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}

/**
 * Extract a log-friendly message from a thrown / rejected value. Centralizes the
 * `err instanceof Error ? err.message : String(err)` pattern that otherwise
 * gets repeated at every catch-site. Plain objects are JSON-stringified so a
 * `[object Object]` log is avoided when callers throw bag-of-fields.
 *
 * @param err Caught value of unknown shape (Error, string, undefined, ...).
 */
export function errText(err: unknown): string {
  if (err instanceof Error) {
    return err.message;
  }
  if (err === null) {
    return "null";
  }
  if (err === undefined) {
    return "undefined";
  }
  if (typeof err === "string") {
    return err;
  }
  if (typeof err === "number" || typeof err === "boolean" || typeof err === "bigint") {
    return String(err);
  }
  // Plain objects + symbols would otherwise stringify to "[object Object]" / fail.
  // Prefer JSON for the common case so the log is at least diagnosable.
  try {
    return JSON.stringify(err);
  } catch {
    return Object.prototype.toString.call(err);
  }
}

/**
 * Coerce into a plain object (non-null, non-array), or null.
 *
 * @param value Unknown value from external API
 */
export function coerceObject(value: unknown): Record<string, unknown> | null {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }
  return null;
}

/**
 * Coerce into an unknown[] array, or null.
 *
 * @param value Unknown value from external API
 */
export function coerceArray(value: unknown): unknown[] | null {
  return Array.isArray(value) ? value : null;
}

/**
 * Coerce into an array of exactly `length` finite numbers, or null if any
 * element is not finite or the array is too short.
 *
 * @param value Unknown value from external API
 * @param length Required tuple length
 */
export function coerceNumberTuple(value: unknown, length: number): number[] | null {
  if (!Array.isArray(value) || value.length < length) {
    return null;
  }
  const out: number[] = [];
  for (let i = 0; i < length; i++) {
    const n = coerceFiniteNumber(value[i]);
    if (n === null) {
      return null;
    }
    out.push(n);
  }
  return out;
}

/**
 * Coerce into an array of finite numbers of any length. Non-finite
 * elements cause the whole array to be rejected.
 *
 * @param value Unknown value from external API
 */
export function coerceNumberArray(value: unknown): number[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const out: number[] = [];
  for (const item of value) {
    const n = coerceFiniteNumber(item);
    if (n === null) {
      return null;
    }
    out.push(n);
  }
  return out;
}

/**
 * Coerce into a map of string → finite number. Non-finite values are
 * silently dropped (the temperature sensor map can contain a handful of
 * bad readings without us discarding the whole map).
 *
 * @param value Unknown value from external API
 */
export function coerceNumberMap(value: unknown): Record<string, number> | null {
  const obj = coerceObject(value);
  if (!obj) {
    return null;
  }
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(obj)) {
    const n = coerceFiniteNumber(v);
    if (n !== null) {
      out[k] = n;
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Typed coercers for Beszel API objects
// ---------------------------------------------------------------------------

function coerceSystemInfo(value: unknown): SystemInfo {
  const obj = coerceObject(value);
  if (!obj) {
    return {};
  }
  const info: SystemInfo = {};

  const u = coerceFiniteNumber(obj.u);
  if (u !== null) {
    info.u = u;
  }
  const v = coerceString(obj.v);
  if (v !== null) {
    info.v = v;
  }
  const sv = coerceNumberTuple(obj.sv, 2);
  if (sv) {
    info.sv = [sv[0], sv[1]];
  }
  const la = coerceNumberTuple(obj.la, 3);
  if (la) {
    info.la = [la[0], la[1], la[2]];
  }
  const bat = coerceNumberTuple(obj.bat, 2);
  if (bat) {
    info.bat = [bat[0], bat[1]];
  }
  return info;
}

function coerceStatus(value: unknown): SystemStatus {
  const s = coerceString(value);
  if (s && (VALID_SYSTEM_STATUS as readonly string[]).includes(s)) {
    return s as SystemStatus;
  }
  return "pending";
}

/**
 * Coerce a raw systems record. Returns null if required fields (id, name)
 * are missing or not strings — such records are silently skipped.
 *
 * @param value Unknown record from PocketBase /systems/records
 */
export function coerceSystem(value: unknown): BeszelSystem | null {
  const obj = coerceObject(value);
  if (!obj) {
    return null;
  }
  const id = coerceString(obj.id);
  const name = coerceString(obj.name);
  if (id === null || name === null) {
    return null;
  }
  return {
    id,
    name,
    status: coerceStatus(obj.status),
    host: coerceString(obj.host) ?? "",
    info: coerceSystemInfo(obj.info),
  };
}

/**
 * Coerce the static hardware/OS fields of a system_details record. Each field
 * passes through its own coercer so a missing/wrong-typed column is simply
 * dropped (→ no state created). Reads the columns off the record directly —
 * they are top-level on the record, not nested under a `stats` key.
 *
 * @param obj The (already object-validated) system_details record.
 */
function coerceSystemDetails(obj: Record<string, unknown>): SystemDetails {
  const out: SystemDetails = {};
  const hostname = coerceString(obj.hostname);
  if (hostname !== null) {
    out.hostname = hostname;
  }
  const os = coerceFiniteNumber(obj.os);
  if (os !== null) {
    out.os = os;
  }
  const osName = coerceString(obj.os_name);
  if (osName !== null) {
    out.os_name = osName;
  }
  const kernel = coerceString(obj.kernel);
  if (kernel !== null) {
    out.kernel = kernel;
  }
  const cpu = coerceString(obj.cpu);
  if (cpu !== null) {
    out.cpu = cpu;
  }
  const arch = coerceString(obj.arch);
  if (arch !== null) {
    out.arch = arch;
  }
  const cores = coerceFiniteNumber(obj.cores);
  if (cores !== null) {
    out.cores = cores;
  }
  const threads = coerceFiniteNumber(obj.threads);
  if (threads !== null) {
    out.threads = threads;
  }
  if (typeof obj.podman === "boolean") {
    out.podman = obj.podman;
  }
  return out;
}

/**
 * Coerce a raw system_details record. Returns null if the `system` relation
 * is missing — such records are silently skipped.
 *
 * @param value Unknown record from PocketBase /system_details/records
 */
export function coerceSystemDetailsRecord(value: unknown): BeszelSystemDetailsRecord | null {
  const obj = coerceObject(value);
  if (!obj) {
    return null;
  }
  const system = coerceString(obj.system);
  if (system === null) {
    return null;
  }
  return { system, details: coerceSystemDetails(obj) };
}

function coerceGPUData(value: unknown): GPUData {
  const obj = coerceObject(value);
  if (!obj) {
    return {};
  }
  const out: GPUData = {};
  const n = coerceString(obj.n);
  if (n !== null) {
    out.n = n;
  }
  const u = coerceFiniteNumber(obj.u);
  if (u !== null) {
    out.u = u;
  }
  const mu = coerceFiniteNumber(obj.mu);
  if (mu !== null) {
    out.mu = mu;
  }
  const mt = coerceFiniteNumber(obj.mt);
  if (mt !== null) {
    out.mt = mt;
  }
  const p = coerceFiniteNumber(obj.p);
  if (p !== null) {
    out.p = p;
  }
  const pp = coerceFiniteNumber(obj.pp);
  if (pp !== null) {
    out.pp = pp;
  }
  const e = coerceNumberMap(obj.e);
  if (e && Object.keys(e).length > 0) {
    out.e = e;
  }
  return out;
}

function coerceFsStats(value: unknown): FsStats {
  const obj = coerceObject(value);
  if (!obj) {
    return {};
  }
  const out: FsStats = {};
  const d = coerceFiniteNumber(obj.d);
  if (d !== null) {
    out.d = d;
  }
  const du = coerceFiniteNumber(obj.du);
  if (du !== null) {
    out.du = du;
  }
  const r = coerceFiniteNumber(obj.r);
  if (r !== null) {
    out.r = r;
  }
  const w = coerceFiniteNumber(obj.w);
  if (w !== null) {
    out.w = w;
  }
  return out;
}

function coerceGpuMap(value: unknown): Record<string, GPUData> | undefined {
  const obj = coerceObject(value);
  if (!obj) {
    return undefined;
  }
  const out: Record<string, GPUData> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = coerceGPUData(v);
  }
  return out;
}

function coerceFsMap(value: unknown): Record<string, FsStats> | undefined {
  const obj = coerceObject(value);
  if (!obj) {
    return undefined;
  }
  const out: Record<string, FsStats> = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = coerceFsStats(v);
  }
  return out;
}

/**
 * Coerce a raw stats object. All numeric fields pass through
 * coerceFiniteNumber so NaN/Infinity can never reach a state.
 *
 * @param value Unknown stats object from PocketBase record
 */
export function coerceSystemStats(value: unknown): SystemStats {
  const obj = coerceObject(value);
  if (!obj) {
    return {};
  }
  const s: SystemStats = {};

  // Single finite-number fields — one loop (each value through coerceFiniteNumber
  // so NaN/Infinity/wrong-type never reach a state; a field absent on an older
  // Beszel version is simply skipped). Includes the v0.18.7 peak values.
  const NUMBER_FIELDS: (keyof SystemStats)[] = [
    "cpu",
    "mu",
    "m",
    "mp",
    "mb",
    "mz",
    "su",
    "s",
    "du",
    "d",
    "dp",
    "dr",
    "dw",
    "ns",
    "nr",
    "cpum",
    "mm",
    "drm",
    "dwm",
    "nsm",
    "nrm",
  ];
  for (const k of NUMBER_FIELDS) {
    const n = coerceFiniteNumber(obj[k]);
    if (n !== null) {
      (s as Record<string, number>)[k] = n;
    }
  }

  // Tuple / map / array fields.
  const t = coerceNumberMap(obj.t);
  if (t) {
    s.t = t;
  }
  const la = coerceNumberTuple(obj.la, 3);
  if (la) {
    s.la = [la[0], la[1], la[2]];
  }
  const g = coerceGpuMap(obj.g);
  if (g) {
    s.g = g;
  }
  const efs = coerceFsMap(obj.efs);
  if (efs) {
    s.efs = efs;
  }
  const bat = coerceNumberTuple(obj.bat, 2);
  if (bat) {
    s.bat = [bat[0], bat[1]];
  }
  const cpub = coerceNumberArray(obj.cpub);
  if (cpub) {
    s.cpub = cpub;
  }
  // v0.18.7: variable-length number arrays — per-core usage + disk-IO stats.
  // (b/bm/dio/diom byte-rate tuples are intentionally not coerced; they
  // duplicate ns/nr and dr/dw — see types.ts.)
  const cpus = coerceNumberArray(obj.cpus);
  if (cpus) {
    s.cpus = cpus;
  }
  const dios = coerceNumberArray(obj.dios);
  if (dios) {
    s.dios = dios;
  }
  // v0.18.7: per-interface [up, down, total up, total down] bytes.
  const niObj = coerceObject(obj.ni);
  if (niObj) {
    const ni: Record<string, [number, number, number, number]> = {};
    for (const [k, v] of Object.entries(niObj)) {
      const tup = coerceNumberTuple(v, 4);
      if (tup) {
        ni[k] = [tup[0], tup[1], tup[2], tup[3]];
      }
    }
    if (Object.keys(ni).length > 0) {
      s.ni = ni;
    }
  }
  return s;
}

/**
 * Coerce a raw system_stats record. Returns null if required references
 * (id, system) are missing.
 *
 * @param value Unknown record from PocketBase /system_stats/records
 */
export function coerceSystemStatsRecord(value: unknown): BeszelSystemStats | null {
  const obj = coerceObject(value);
  if (!obj) {
    return null;
  }
  const id = coerceString(obj.id);
  const system = coerceString(obj.system);
  if (id === null || system === null) {
    return null;
  }
  return {
    id,
    system,
    type: coerceString(obj.type) ?? "",
    stats: coerceSystemStats(obj.stats),
    updated: coerceString(obj.updated) ?? "",
  };
}

/**
 * Coerce a raw container record. Returns null if required fields
 * (id, system, name) are missing or not strings. Numeric fields that are
 * missing default to 0.
 *
 * @param value Unknown record from PocketBase /containers/records
 */
export function coerceContainer(value: unknown): BeszelContainer | null {
  const obj = coerceObject(value);
  if (!obj) {
    return null;
  }
  const id = coerceString(obj.id);
  const system = coerceString(obj.system);
  const name = coerceString(obj.name);
  if (id === null || system === null || name === null) {
    return null;
  }
  const container: BeszelContainer = {
    id,
    system,
    name,
    status: coerceString(obj.status) ?? "unknown",
    health: coerceFiniteNumber(obj.health) ?? 0,
    cpu: coerceFiniteNumber(obj.cpu) ?? 0,
    memory: coerceFiniteNumber(obj.memory) ?? 0,
    image: coerceString(obj.image) ?? "",
  };
  // Optional combined network throughput (bytes/s) — only set when present so
  // an older Hub without the `net` column yields no empty container state.
  const net = coerceFiniteNumber(obj.net);
  if (net !== null) {
    container.net = net;
  }
  return container;
}

/**
 * v0.5.0 (S1): URL-shape validator. Returns a short reason string when the
 * URL is unusable, or null when it's OK to hand to the client. Moved from
 * main.ts so the validator can be unit-tested without an adapter instance.
 *
 * @param url The raw URL value from admin config.
 */
export function validateHubUrl(url: unknown): string | null {
  if (typeof url !== "string" || url.trim().length === 0) {
    return "URL is empty";
  }
  try {
    const u = new URL(url.trim());
    if (u.protocol !== "http:" && u.protocol !== "https:") {
      return `protocol '${u.protocol}' is not http(s)`;
    }
    if (!u.hostname) {
      return "hostname is missing";
    }
    return null;
  } catch {
    return "URL is malformed";
  }
}

/**
 * v0.5.0 (S1+K15): coerce poll-interval to a finite number of seconds,
 * default 60 s, clamped to [10, 300] — matches admin/jsonConfig.json
 * min/max so a script bypassing the admin UI cannot push the value
 * outside the documented range.
 *
 * @param raw Raw `pollInterval` from admin config (number or numeric string).
 */
export function coercePollInterval(raw: unknown): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? parseFloat(raw) : NaN;
  if (!Number.isFinite(n)) {
    return 60;
  }
  return Math.max(10, Math.min(300, Math.floor(n)));
}

/**
 * v0.6.0 (F2): decide whether the static `system_details` collection needs a
 * (re)fetch this poll. True only when at least one current system id has never
 * been *attempted* — so the first poll fetches, a newly-added system triggers
 * one refetch, and a details-less / older-Hub-404 system (attempted but never
 * in the result) does NOT refetch every poll. Pure so the cadence — which
 * lives in the untested poll loop — can be unit-tested directly.
 *
 * @param systemIds Ids of the systems present in the current poll.
 * @param attempted Ids we've already attempted a details fetch for (grows after
 *   each attempt, success or failure).
 */
export function shouldFetchSystemDetails(systemIds: string[], attempted: ReadonlySet<string>): boolean {
  return systemIds.some(id => !attempted.has(id));
}

/**
 * v0.5.0 (S1): coerce admin's `requestTimeout` (seconds) to ms. Default
 * 15 s when missing/unparseable. Clamped to [5 s, 120 s].
 *
 * @param raw Raw `requestTimeout` from admin config (number or numeric string).
 */
export function coerceTimeoutMs(raw: unknown): number {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? parseFloat(raw) : NaN;
  if (!Number.isFinite(n)) {
    return 15_000;
  }
  return Math.max(5, Math.min(120, Math.floor(n))) * 1000;
}

/**
 * Coerce a PocketBase list response. Each raw item is run through
 * `itemCoercer`; items that fail coercion (return null) are filtered out.
 *
 * @param value Unknown JSON body from a PocketBase list endpoint
 * @param itemCoercer Per-item coercer that returns the typed object or null
 */
export function coercePocketBaseList<T>(value: unknown, itemCoercer: (raw: unknown) => T | null): PocketBaseList<T> {
  const obj = coerceObject(value);
  if (!obj) {
    return { page: 0, perPage: 0, totalItems: 0, totalPages: 0, items: [] };
  }
  const rawItems = coerceArray(obj.items) ?? [];
  const items: T[] = [];
  for (const raw of rawItems) {
    const item = itemCoercer(raw);
    if (item !== null) {
      items.push(item);
    }
  }
  return {
    page: coerceFiniteNumber(obj.page) ?? 0,
    perPage: coerceFiniteNumber(obj.perPage) ?? 0,
    totalItems: coerceFiniteNumber(obj.totalItems) ?? 0,
    totalPages: coerceFiniteNumber(obj.totalPages) ?? 0,
    items,
  };
}

/**
 * Coerce an auth response. Returns null if the token is missing or not a
 * non-empty string.
 *
 * @param value Unknown JSON body from /users/auth-with-password
 */
export function coerceAuthResponse(value: unknown): AuthResponse | null {
  const obj = coerceObject(value);
  if (!obj) {
    return null;
  }
  const token = coerceString(obj.token);
  if (token === null) {
    return null;
  }
  // Only the token is consumed (kept in memory for the Authorization header);
  // the user `record` from the auth response is intentionally not surfaced.
  return { token };
}
