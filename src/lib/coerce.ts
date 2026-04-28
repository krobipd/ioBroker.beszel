import type {
  AuthResponse,
  BeszelContainer,
  BeszelSystem,
  BeszelSystemStats,
  FsStats,
  GPUData,
  PocketBaseList,
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

/**
 * Coerce any value into a finite number, returning null if not possible.
 * Handles NaN, Infinity, -Infinity, numeric strings, and rejects everything else.
 *
 * @param value Unknown value from external API
 */
export function coerceFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value.length > 0) {
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
 * Coerce into a boolean, returning null for anything that is not exactly
 * `true` or `false`.
 *
 * @param value Unknown value from external API
 */
export function coerceBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
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

  const cpu = coerceFiniteNumber(obj.cpu);
  if (cpu !== null) {
    s.cpu = cpu;
  }
  const mu = coerceFiniteNumber(obj.mu);
  if (mu !== null) {
    s.mu = mu;
  }
  const m = coerceFiniteNumber(obj.m);
  if (m !== null) {
    s.m = m;
  }
  const mp = coerceFiniteNumber(obj.mp);
  if (mp !== null) {
    s.mp = mp;
  }
  const mb = coerceFiniteNumber(obj.mb);
  if (mb !== null) {
    s.mb = mb;
  }
  const mz = coerceFiniteNumber(obj.mz);
  if (mz !== null) {
    s.mz = mz;
  }
  const su = coerceFiniteNumber(obj.su);
  if (su !== null) {
    s.su = su;
  }
  const sw = coerceFiniteNumber(obj.s);
  if (sw !== null) {
    s.s = sw;
  }
  const du = coerceFiniteNumber(obj.du);
  if (du !== null) {
    s.du = du;
  }
  const d = coerceFiniteNumber(obj.d);
  if (d !== null) {
    s.d = d;
  }
  const dp = coerceFiniteNumber(obj.dp);
  if (dp !== null) {
    s.dp = dp;
  }
  const dr = coerceFiniteNumber(obj.dr);
  if (dr !== null) {
    s.dr = dr;
  }
  const dw = coerceFiniteNumber(obj.dw);
  if (dw !== null) {
    s.dw = dw;
  }
  const ns = coerceFiniteNumber(obj.ns);
  if (ns !== null) {
    s.ns = ns;
  }
  const nr = coerceFiniteNumber(obj.nr);
  if (nr !== null) {
    s.nr = nr;
  }
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
  return {
    id,
    system,
    name,
    status: coerceString(obj.status) ?? "unknown",
    health: coerceFiniteNumber(obj.health) ?? 0,
    cpu: coerceFiniteNumber(obj.cpu) ?? 0,
    memory: coerceFiniteNumber(obj.memory) ?? 0,
    image: coerceString(obj.image) ?? "",
  };
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
  const recordObj = coerceObject(obj.record) ?? {};
  const id = coerceString(recordObj.id) ?? "";
  const email = coerceString(recordObj.email) ?? "";
  return {
    token,
    record: { ...recordObj, id, email },
  };
}
