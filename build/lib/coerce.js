"use strict";
var __defProp = Object.defineProperty;
var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
var __getOwnPropNames = Object.getOwnPropertyNames;
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
var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);
var coerce_exports = {};
__export(coerce_exports, {
  coerceArray: () => coerceArray,
  coerceAuthResponse: () => coerceAuthResponse,
  coerceContainer: () => coerceContainer,
  coerceFiniteNumber: () => coerceFiniteNumber,
  coerceNumberArray: () => coerceNumberArray,
  coerceNumberMap: () => coerceNumberMap,
  coerceNumberTuple: () => coerceNumberTuple,
  coerceObject: () => coerceObject,
  coercePocketBaseList: () => coercePocketBaseList,
  coercePollInterval: () => coercePollInterval,
  coerceString: () => coerceString,
  coerceSystem: () => coerceSystem,
  coerceSystemDetailsRecord: () => coerceSystemDetailsRecord,
  coerceSystemStats: () => coerceSystemStats,
  coerceSystemStatsRecord: () => coerceSystemStatsRecord,
  coerceTimeoutMs: () => coerceTimeoutMs,
  errText: () => errText,
  shouldFetchSystemDetails: () => shouldFetchSystemDetails,
  validateHubUrl: () => validateHubUrl
});
module.exports = __toCommonJS(coerce_exports);
const VALID_SYSTEM_STATUS = ["up", "down", "paused", "pending"];
function coerceFiniteNumber(value) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string" && value.length > 0) {
    const n = Number(value);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}
function coerceString(value, maxLength = 1024) {
  if (typeof value !== "string" || value.length === 0) {
    return null;
  }
  return value.length > maxLength ? value.slice(0, maxLength) : value;
}
function errText(err) {
  if (err instanceof Error) {
    return err.message;
  }
  if (err === null) {
    return "null";
  }
  if (err === void 0) {
    return "undefined";
  }
  if (typeof err === "string") {
    return err;
  }
  if (typeof err === "number" || typeof err === "boolean" || typeof err === "bigint") {
    return String(err);
  }
  try {
    return JSON.stringify(err);
  } catch {
    return Object.prototype.toString.call(err);
  }
}
function coerceObject(value) {
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    return value;
  }
  return null;
}
function coerceArray(value) {
  return Array.isArray(value) ? value : null;
}
function coerceNumberTuple(value, length) {
  if (!Array.isArray(value) || value.length < length) {
    return null;
  }
  const out = [];
  for (let i = 0; i < length; i++) {
    const n = coerceFiniteNumber(value[i]);
    if (n === null) {
      return null;
    }
    out.push(n);
  }
  return out;
}
function coerceNumberArray(value) {
  if (!Array.isArray(value)) {
    return null;
  }
  const out = [];
  for (const item of value) {
    const n = coerceFiniteNumber(item);
    if (n === null) {
      return null;
    }
    out.push(n);
  }
  return out;
}
function coerceNumberMap(value) {
  const obj = coerceObject(value);
  if (!obj) {
    return null;
  }
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    const n = coerceFiniteNumber(v);
    if (n !== null) {
      out[k] = n;
    }
  }
  return out;
}
function coerceSystemInfo(value) {
  const obj = coerceObject(value);
  if (!obj) {
    return {};
  }
  const info = {};
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
function coerceStatus(value) {
  const s = coerceString(value);
  if (s && VALID_SYSTEM_STATUS.includes(s)) {
    return s;
  }
  return "pending";
}
function coerceSystem(value) {
  var _a;
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
    host: (_a = coerceString(obj.host)) != null ? _a : "",
    info: coerceSystemInfo(obj.info)
  };
}
function coerceSystemDetails(obj) {
  const out = {};
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
function coerceSystemDetailsRecord(value) {
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
function coerceGPUData(value) {
  const obj = coerceObject(value);
  if (!obj) {
    return {};
  }
  const out = {};
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
function coerceFsStats(value) {
  const obj = coerceObject(value);
  if (!obj) {
    return {};
  }
  const out = {};
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
function coerceGpuMap(value) {
  const obj = coerceObject(value);
  if (!obj) {
    return void 0;
  }
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = coerceGPUData(v);
  }
  return out;
}
function coerceFsMap(value) {
  const obj = coerceObject(value);
  if (!obj) {
    return void 0;
  }
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = coerceFsStats(v);
  }
  return out;
}
function coerceSystemStats(value) {
  const obj = coerceObject(value);
  if (!obj) {
    return {};
  }
  const s = {};
  const NUMBER_FIELDS = [
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
    "nrm"
  ];
  for (const k of NUMBER_FIELDS) {
    const n = coerceFiniteNumber(obj[k]);
    if (n !== null) {
      s[k] = n;
    }
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
  const cpus = coerceNumberArray(obj.cpus);
  if (cpus) {
    s.cpus = cpus;
  }
  const dios = coerceNumberArray(obj.dios);
  if (dios) {
    s.dios = dios;
  }
  const niObj = coerceObject(obj.ni);
  if (niObj) {
    const ni = {};
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
function coerceSystemStatsRecord(value) {
  var _a, _b;
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
    type: (_a = coerceString(obj.type)) != null ? _a : "",
    stats: coerceSystemStats(obj.stats),
    updated: (_b = coerceString(obj.updated)) != null ? _b : ""
  };
}
function coerceContainer(value) {
  var _a, _b, _c, _d, _e;
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
  const container = {
    id,
    system,
    name,
    status: (_a = coerceString(obj.status)) != null ? _a : "unknown",
    health: (_b = coerceFiniteNumber(obj.health)) != null ? _b : 0,
    cpu: (_c = coerceFiniteNumber(obj.cpu)) != null ? _c : 0,
    memory: (_d = coerceFiniteNumber(obj.memory)) != null ? _d : 0,
    image: (_e = coerceString(obj.image)) != null ? _e : ""
  };
  const net = coerceFiniteNumber(obj.net);
  if (net !== null) {
    container.net = net;
  }
  return container;
}
function validateHubUrl(url) {
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
function coercePollInterval(raw) {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? parseFloat(raw) : NaN;
  if (!Number.isFinite(n)) {
    return 60;
  }
  return Math.max(10, Math.min(300, Math.floor(n)));
}
function shouldFetchSystemDetails(systemIds, attempted) {
  return systemIds.some((id) => !attempted.has(id));
}
function coerceTimeoutMs(raw) {
  const n = typeof raw === "number" ? raw : typeof raw === "string" ? parseFloat(raw) : NaN;
  if (!Number.isFinite(n)) {
    return 15e3;
  }
  return Math.max(5, Math.min(120, Math.floor(n))) * 1e3;
}
function coercePocketBaseList(value, itemCoercer) {
  var _a, _b, _c, _d, _e;
  const obj = coerceObject(value);
  if (!obj) {
    return { page: 0, perPage: 0, totalItems: 0, totalPages: 0, items: [] };
  }
  const rawItems = (_a = coerceArray(obj.items)) != null ? _a : [];
  const items = [];
  for (const raw of rawItems) {
    const item = itemCoercer(raw);
    if (item !== null) {
      items.push(item);
    }
  }
  return {
    page: (_b = coerceFiniteNumber(obj.page)) != null ? _b : 0,
    perPage: (_c = coerceFiniteNumber(obj.perPage)) != null ? _c : 0,
    totalItems: (_d = coerceFiniteNumber(obj.totalItems)) != null ? _d : 0,
    totalPages: (_e = coerceFiniteNumber(obj.totalPages)) != null ? _e : 0,
    items
  };
}
function coerceAuthResponse(value) {
  const obj = coerceObject(value);
  if (!obj) {
    return null;
  }
  const token = coerceString(obj.token);
  if (token === null) {
    return null;
  }
  return { token };
}
// Annotate the CommonJS export names for ESM import in node:
0 && (module.exports = {
  coerceArray,
  coerceAuthResponse,
  coerceContainer,
  coerceFiniteNumber,
  coerceNumberArray,
  coerceNumberMap,
  coerceNumberTuple,
  coerceObject,
  coercePocketBaseList,
  coercePollInterval,
  coerceString,
  coerceSystem,
  coerceSystemDetailsRecord,
  coerceSystemStats,
  coerceSystemStatsRecord,
  coerceTimeoutMs,
  errText,
  shouldFetchSystemDetails,
  validateHubUrl
});
//# sourceMappingURL=coerce.js.map
