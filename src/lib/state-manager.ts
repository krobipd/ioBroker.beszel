import type * as utils from "@iobroker/adapter-core";
import { errText, sanitizeDisplayName, sanitizeForLog } from "./coerce";
import { deviceIcon } from "./device-icons";
import { tDesc, tName } from "./i18n";
import {
  buildMetricDefs,
  commonFor,
  containerHealthLabel,
  serviceStateLabel,
  serviceSubLabel,
  percentCommon,
  numCommon,
  textCommon,
  boolCommon,
  clampPercent,
  channelName,
  leafCommon,
  bytesToMib,
  bytesToGib,
  usedPercent,
  DYNAMIC_CHANNEL_PATTERNS,
  DYNAMIC_CHANNEL_TOGGLES,
  DYNAMIC_LEAF_PATTERNS,
  DYNAMIC_SUBCHANNEL_TOGGLES,
  METRIC_DEPENDENCIES,
  systemStatusStates,
  SYSTEM_STATUS_UNKNOWN,
} from "./metric-registry";
import type { LocalizedName, MetricDef } from "./metric-registry";
import type {
  AdapterConfig,
  BeszelContainer,
  BeszelSystem,
  SmartDevice,
  SystemStats,
  SystemdService,
  ZfsDataset,
  ZfsPoolDetail,
  ZfsVdev,
} from "./types";

/**
 * Objects whose name comes from the Hub, the agent or the OS — sensors, fans, batteries,
 * GPU engines, and the channels of interfaces, GPUs, filesystems and containers — carry this
 * marker in `native`. The fleet's inventory gate then treats the plain, single-language name
 * as what it is (the device's own name in the system language, krobi 2026-09-04: "als API
 * ist in diesem legitim") instead of demanding a translation object that would claim eleven
 * languages for one text. Design 31.
 */
const API_NAMED = { nameSource: "api" } as const;

/**
 * v0.17.0 — the records of the three detail collections that belong to ONE system,
 * already filtered by the poll. A field left `undefined` means "not read this round",
 * which is deliberately different from an empty array: an empty array prunes, `undefined`
 * leaves the existing datapoints untouched (same rule as `containersAvailable`).
 */
export interface SystemExtras {
  /** `zfs_pools` records of this system */
  zfsPools?: ZfsPoolDetail[];
  /** `smart_devices` records of this system */
  smartDevices?: SmartDevice[];
  /** `systemd_services` records of this system */
  systemdServices?: SystemdService[];
}

/**
 * State ids (relative to the system device) that a release retired. Swept from the
 * startup snapshot: an id that exists gets deleted, an id that does not costs nothing.
 *
 * 0.18.0: the six peak datapoints and `info.uptime_text`. The adapter created a peak only
 * when its field was present (v0.6.0–v0.17.1, `available: st => st?.cpum != null`), and the
 * agent never sends one (`cbor:"-"` since at least Beszel 0.18.7) — for an agent of the old
 * JSON transport that is not provable, so the entries stay; each costs nothing (one lookup
 * in the startup snapshot). `info.uptime_text` was a second rendering of `info.uptime`
 * (krobi 2026-09-15: pointless) and sits on every install that ran 0.4.x–0.17.x — the
 * ioBroker statistics still count installations on 0.7.2 and 0.12.2 (2026-09-24), so the
 * sweep has to stay for as long as such an upgrade can come in.
 */
const RETIRED_STATE_IDS = [
  "cpu.peak",
  "memory.peak",
  "disk.read_peak",
  "disk.write_peak",
  "network.sent_peak",
  "network.recv_peak",
  "info.uptime_text",
] as const;

/**
 * Manages creation, update and cleanup of ioBroker objects and states for Beszel systems.
 */
export class StateManager {
  private readonly adapter: utils.AdapterInstance;
  /**
   * Tracks IDs whose object we already wrote this run. Skipping the write on
   * subsequent polls avoids a redundant js-controller round-trip per state per
   * system per minute — the object write happens once per id per restart.
   */
  private readonly createdIds = new Set<string>();

  /**
   * Set by {@link stop} when the adapter unloads. A system update still running in the
   * parallel fan-out must not write `info.online = true` over the offline markers the
   * shutdown writes.
   */
  private stopped = false;

  /**
   * The storage pools the per-poll summary (`stats.z`) reported for each system in THIS
   * poll: pool key → channel id. The detail writer uses exactly these ids and nothing else
   * — a `zfs_pools` row outlives its pool until the Hub's next full refresh, and a detail
   * write for a pool the summary already pruned used to bring its channel back for good.
   */
  private readonly activePoolIds = new Map<string, Map<string, string>>();

  /**
   * Which member owns the BARE id of a dynamic group when two members sanitize to the same
   * segment (`<group>.<bare>` → the member's stable key). The owner keeps the bare id for
   * as long as it exists; the other one gets the hash suffix — no matter in which order the
   * Hub lists them. Unowned collisions go to the smaller key, so the outcome is fixed too.
   */
  private readonly groupOwners = new Map<string, string>();

  /** Hub ids whose system name gave no usable id segment — warned once each. */
  private readonly warnedNameFallback = new Set<string>();

  /**
   * v0.4.3 (SM5): per-poll resolved safeName per system.id. Built once via
   * `prepareForPoll(systems)` before per-system updates run in parallel.
   */
  private readonly resolvedSafeNames = new Map<string, string>();

  /** L5: collision bases already warned about — the warn fires once, not every poll. */
  private readonly warnedCollisions = new Set<string>();

  /**
   * v0.7.2: per dynamic group (`<sysId>.<group>` → set of child segments seen
   * in the last poll). Used by {@link pruneDynamicChildren} to delete states
   * of disappeared members (renamed interface, removed GPU/sensor/fan/battery/
   * filesystem, stopped container) without a DB round-trip per poll — the object view is
   * queried only once per group after adapter start (reconciles zombies from
   * previous runs), afterwards the in-memory diff does the work.
   */
  private readonly dynamicChildren = new Map<string, Set<string>>();

  /**
   * H2: per dynamic group (`<sysId>.<group>`, incl. containers) → was the group
   * empty on the previous poll. Debounces the drop-to-zero prune: a single empty
   * response (the `g/efs/t/ni` maps are `omitempty` on the wire, so a transient
   * gap drops the key) must not wipe the group's states — only a second
   * consecutive empty confirms removal. Replaces the old global `lastContainersEmpty`.
   */
  private readonly lastGroupEmpty = new Map<string, boolean>();

  /**
   * Per `goneWhenAbsent: "stats"` state id → was its field absent on the previous poll
   * while a record was there. The same two-poll debounce as {@link lastGroupEmpty}: the
   * state is removed only when the hardware is missing on two consecutive samples.
   */
  private readonly absentLastPoll = new Map<string, boolean>();

  /**
   * Stored state objects that carry `unit: ""` — the placeholder v0.17.x wrote on its
   * unitless counters. `extendObject` is a deep merge: a key the new common no longer
   * carries stays as it is, and `null` would be stored as null, not removed (js-controller
   * merges with `node.extend`, which copies null and skips only undefined). The one write
   * that clears it replaces the whole stored object, so the snapshot keeps exactly these.
   * Replacing, not delete + recreate: `delObject` strips the id from every enum (the
   * user's room/function assignment), a plain replace touches neither value nor enums.
   */
  private readonly staleUnitObjects = new Map<string, ioBroker.StateObject>();

  /**
   * v0.7.2: last-written device-object signature per sysId ({@link deviceSignature}).
   * `updateSystem` used to extendObject the device on EVERY poll — one write
   * + objectChange event per system per minute for data that practically
   * never changes. Now the write happens only when the signature differs.
   *
   * v0.18.0: primed from the startup snapshot with the signature of the STORED object,
   * so a restart with unchanged data writes nothing, and a field that arrived with a
   * release (the icon) is written exactly once per existing device — the stored object
   * lacks it, so the signatures differ once and then agree.
   */
  private readonly deviceWritten = new Map<string, string>();

  /** The `common.icon` each device object currently carries (snapshot, then every write). */
  private readonly deviceIcons = new Map<string, string | undefined>();

  /**
   * Hub id that owns each bare `systems.<safeName>` device object (`native.id` from the
   * snapshot / the last write). When two systems sanitize to the same name, the owner
   * keeps it and the newcomer gets the hash suffix — regardless of how their ids sort.
   */
  private readonly deviceOwners = new Map<string, string>();

  /**
   * v0.11.0: datapoint-change bookkeeping behind the user-facing "created /
   * removed N datapoint(s)" log line. `knownStateIds` starts as a snapshot of
   * every state that already existed at adapter start and is kept in sync from
   * then on, so the every-restart `extendObject` retrofit in `createAndSetState`
   * is NOT miscounted as a creation — only a state that did not exist before
   * counts. Removed ids leave the set again, so a later re-appearance counts as
   * a genuine new creation.
   */
  private readonly knownStateIds = new Set<string>();
  /**
   * The channels that exist, starting from the startup snapshot.
   *
   * v0.16.0: kept in sync from then on, exactly like {@link knownStateIds} —
   * {@link ensureChannel} adds, {@link dropCacheUnder} removes. Until then the set was
   * only ever filled and never pruned, and {@link refreshDynamicObjects} re-created every
   * channel it still found in there: a group the cleanup had just deleted came back as an
   * empty channel on the first poll of any system without a reading, and did so again
   * after every restart. It is now also what answers "does this channel exist" instead of
   * an object read (see {@link snapshotExistingStates}).
   */
  private readonly knownChannelIds = new Set<string>();
  /**
   * v0.16.0: the system DEVICE objects that exist, same bookkeeping as the two sets above.
   * `getExistingSystemNames` used to run an object view for this — once at startup and
   * once per poll from `cleanupSystems`.
   */
  private readonly knownDeviceIds = new Set<string>();
  /** Whether {@link snapshotExistingStates} has run — the retired-state sweep depends on it. */
  private snapshotTaken = false;
  private createdStatesCount = 0;
  private removedStatesCount = 0;

  /**
   * @param adapter The ioBroker adapter instance
   */
  constructor(adapter: utils.AdapterInstance) {
    this.adapter = adapter;
  }

  /**
   * v0.11.0: snapshot every existing object of this instance once at startup
   * (one object list). Must run before the first cleanup/poll — anything created
   * or deleted before it would be miscounted.
   *
   * v0.16.0: this is the adapter's ONLY object read in normal operation. States,
   * channels and devices arrive in the same round-trip and are kept in sync from here
   * on (create adds, delete removes), so every later "does this object exist" question
   * — the startup cleanup, the channel deletes, the recursive-delete count, the
   * dynamic-group reconcile, the system enumeration — is answered from memory. Before
   * that the adapter asked the objects DB again for what it had just read: 43 reads per
   * system on every start, plus one view per dynamic group and one per poll for the
   * device list.
   *
   * The one thing the snapshot cannot see is somebody deleting an object in the admin
   * while the adapter runs; the `createdIds` cache had exactly the same blind spot
   * before, and the next start reconciles it.
   */
  public async snapshotExistingStates(): Promise<void> {
    // One object LIST instead of a per-type view: it carries every type in the
    // same round-trip, which is what lets the retired-state sweep run without probing
    // ids one by one (and made the `info.legacyMigrated` marker obsolete).
    const list = await this.adapter.getObjectListAsync({
      startkey: `${this.adapter.namespace}.`,
      endkey: `${this.adapter.namespace}.\uFFFF`,
    });
    for (const row of list?.rows ?? []) {
      const id = this.stripNamespace(row.id);
      if (row.value?.type === "state") {
        this.knownStateIds.add(id);
        if (row.value.common?.unit === "") {
          this.staleUnitObjects.set(id, row.value);
        }
      } else if (row.value?.type === "channel") {
        this.knownChannelIds.add(id);
      } else if (row.value?.type === "device") {
        this.knownDeviceIds.add(id);
        this.primeDevice(id, row.value);
      }
    }
    this.snapshotTaken = true;
  }

  /**
   * Remember what a stored `systems.<safeName>` device object carries, so the first poll
   * compares against it instead of writing every device once per restart.
   *
   * @param id Device id, namespace-relative.
   * @param obj The stored object.
   */
  private primeDevice(id: string, obj: ioBroker.Object): void {
    const segments = id.split(".");
    if (segments.length !== 2 || segments[0] !== "systems") {
      return;
    }
    const native = obj.native as Record<string, unknown> | undefined;
    const hubId = typeof native?.id === "string" ? native.id : "";
    const host = typeof native?.host === "string" ? native.host : "";
    const name = typeof obj.common?.name === "string" ? obj.common.name : "";
    const icon = typeof obj.common?.icon === "string" ? obj.common.icon : undefined;
    this.deviceWritten.set(id, StateManager.deviceSignature(hubId, host, name, icon));
    this.deviceIcons.set(id, icon);
    if (hubId) {
      this.deviceOwners.set(segments[1], hubId);
    }
  }

  /**
   * Everything the device object is built from. An input that is missing from the
   * stored object must be an INPUT here (not derived inside the write), otherwise the
   * primed signature would agree with itself and no existing device would ever be
   * brought up to date.
   *
   * @param hubId Beszel system id.
   * @param host Host as reported by the Hub.
   * @param name Display name.
   * @param icon `common.icon` value, or undefined while unknown.
   */
  private static deviceSignature(hubId: string, host: string, name: string, icon: string | undefined): string {
    return `${hubId}\u0000${host}\u0000${name}\u0000${icon ?? ""}`;
  }

  /**
   * v0.11.0: return and reset the created/removed datapoint counters, so each
   * log line reports exactly one batch of changes.
   */
  public takeChangeCounts(): { created: number; removed: number } {
    const counts = { created: this.createdStatesCount, removed: this.removedStatesCount };
    this.createdStatesCount = 0;
    this.removedStatesCount = 0;
    return counts;
  }

  /**
   * v0.11.0: record that a state object was just created. A state that was
   * already there (restart retrofit) does not count.
   *
   * @param id State id, namespace-relative.
   */
  private noteStateCreated(id: string): void {
    if (!this.knownStateIds.has(id)) {
      this.knownStateIds.add(id);
      this.createdStatesCount++;
    }
  }

  /**
   * v0.11.0: record that a single state object was just deleted.
   *
   * @param id State id, namespace-relative.
   */
  private noteStateRemoved(id: string): void {
    this.knownStateIds.delete(id);
    this.removedStatesCount++;
  }

  /**
   * v0.11.0: record the states removed by a RECURSIVE delete (channel, device,
   * dynamic-group child) — the honest number of datapoints the user loses — and drop
   * them from `knownStateIds` so a later re-appearance counts as a creation. Must be
   * called BEFORE the delete.
   *
   * v0.16.0: counted from `knownStateIds` instead of an object view. The set is the
   * startup snapshot kept in sync ever since, so it answers exactly what the view did,
   * without the round-trip.
   *
   * @param id Object id whose subtree is about to be removed.
   */
  private noteStatesRemovedUnder(id: string): void {
    for (const local of StateManager.idsUnder(this.knownStateIds, id)) {
      this.noteStateRemoved(local);
    }
  }

  /**
   * Ids of `set` that are `prefix` itself or live below it. Materialised into an array
   * so the caller may delete from the set while iterating.
   *
   * @param ids The keys of one of the bookkeeping sets or maps.
   * @param prefix Object id prefix, namespace-relative.
   */
  private static idsUnder(ids: Iterable<string>, prefix: string): string[] {
    const dot = `${prefix}.`;
    const out: string[] = [];
    for (const id of ids) {
      if (id === prefix || id.startsWith(dot)) {
        out.push(id);
      }
    }
    return out;
  }

  /**
   * Sanitize a name to a valid ioBroker state ID segment (see adapter.FORBIDDEN_CHARS).
   * Lowercase, replace non-alphanumeric with _, max 50 chars, trim underscores.
   * Non-string input is rejected with an empty string so one bad record
   * cannot crash a poll.
   *
   * @param name Raw name to sanitize
   */
  private sanitize(name: unknown): string {
    if (typeof name !== "string") {
      return "";
    }
    return name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "_")
      .replace(/^_+|_+$/g, "")
      .slice(0, 50);
  }

  /**
   * FNV-1a 32-bit short hash → 6 hex chars.
   *
   * @param s Input string to hash.
   */
  private static shortHash(s: string): string {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) {
      h ^= s.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    return (h >>> 0).toString(16).padStart(8, "0").slice(0, 6);
  }

  /**
   * SEC-6: resolve the id segments of a dynamic group's members, disambiguating
   * collisions the same way `prepareForPoll` does for systems. Two members that sanitize
   * to the same segment (`/mnt/data` and `/mnt-data`, two names sharing the first 50
   * chars) must never overwrite each other's states: one keeps the bare segment, the
   * other gets a stable `__<hash>` suffix of its key. WHICH one keeps it no longer depends
   * on the order the Hub lists them in — the current owner keeps it, and an unowned
   * collision goes to the smaller key. An unusable name maps to "" (caller skips it).
   *
   * @param base Group prefix (e.g. `systems.<safeName>.containers`).
   * @param items The members: a stable key (record key / container name) and the raw name.
   * @returns Id segment per key.
   */
  private resolveGroupIds(base: string, items: { key: string; name: string }[]): Map<string, string> {
    const out = new Map<string, string>();
    const byBare = new Map<string, string[]>();
    for (const { key, name } of items) {
      const bare = this.sanitize(name);
      out.set(key, "");
      if (!bare) {
        continue;
      }
      const keys = byBare.get(bare) ?? [];
      keys.push(key);
      byBare.set(bare, keys);
    }
    for (const [bare, keys] of byBare) {
      const ownerKey = `${base}.${bare}`;
      const current = this.groupOwners.get(ownerKey);
      const owner = current !== undefined && keys.includes(current) ? current : [...keys].sort()[0];
      this.groupOwners.set(ownerKey, owner);
      for (const key of keys) {
        out.set(key, key === owner ? bare : `${bare}__${StateManager.shortHash(key)}`);
      }
    }
    return out;
  }

  /**
   * The id segment a system's name gives: the sanitized name, or — when the name has no
   * letter or digit an object id may carry (a Cyrillic or Chinese name) — `sys_<hash>` of
   * its Hub id. Such a system used to be skipped altogether, with a warning every poll.
   *
   * @param system The Beszel system.
   */
  private systemBaseName(system: BeszelSystem): string {
    return this.sanitize(system.name) || `sys_${StateManager.shortHash(system.id)}`;
  }

  /**
   * v0.4.3 (SM5): pre-compute the safeName for every system in this poll,
   * disambiguating collisions. Sorted by id for determinism. The first
   * occurrence keeps the bare safeName (back-compat); later collisions get
   * the `__<hash>` suffix.
   *
   * @param systems Systems to be processed in this poll cycle.
   */
  public prepareForPoll(systems: BeszelSystem[]): void {
    this.resolvedSafeNames.clear();
    // The system that already owns a bare device object keeps it — a newcomer whose
    // id merely sorts first must not take over an existing tree (and its history).
    // Only then id order, so the outcome stays deterministic for two new systems.
    const sorted = [...systems].sort((a, b) => {
      const ownsA = this.deviceOwners.get(this.systemBaseName(a)) === a.id ? 0 : 1;
      const ownsB = this.deviceOwners.get(this.systemBaseName(b)) === b.id ? 0 : 1;
      return ownsA - ownsB || a.id.localeCompare(b.id);
    });
    const seen = new Set<string>();
    const collisions = new Map<string, BeszelSystem[]>();
    for (const sys of sorted) {
      const safe = this.systemBaseName(sys);
      if (!this.sanitize(sys.name) && !this.warnedNameFallback.has(sys.id)) {
        this.warnedNameFallback.add(sys.id);
        this.adapter.log.warn(
          `System '${sanitizeForLog(sys.name)}' has no letter or digit usable in an object id — it appears as systems.${safe}`,
        );
      }
      if (seen.has(safe)) {
        const arr = collisions.get(safe) ?? [];
        arr.push(sys);
        collisions.set(safe, arr);
        this.resolvedSafeNames.set(sys.id, `${safe}__${StateManager.shortHash(sys.id)}`);
      } else {
        seen.add(safe);
        this.resolvedSafeNames.set(sys.id, safe);
      }
    }
    for (const [safe, dupes] of collisions) {
      // L5: warn once per collision base — persistent collisions used to warn every poll.
      if (this.warnedCollisions.has(safe)) {
        continue;
      }
      this.warnedCollisions.add(safe);
      const names = dupes.map(s => `${sanitizeForLog(s.name)}(${s.id.slice(0, 8)})`).join(", ");
      this.adapter.log.warn(
        `Multiple systems sanitize to '${safe}' — ${names} get a hash suffix, the existing '${safe}' keeps its tree. Consider renaming on the Hub.`,
      );
    }
  }

  /**
   * Resolved safeName from `prepareForPoll`, or fresh `sanitize(name)` fallback.
   *
   * @param system The Beszel system whose ID-segment we want.
   */
  private resolvedSafeName(system: BeszelSystem): string {
    const cached = this.resolvedSafeNames.get(system.id);
    return cached !== undefined ? cached : this.systemBaseName(system);
  }

  /**
   * State prefixes (`systems.<safeName>`) of every system that has an `info.online`
   * state — the startup snapshot plus what the polls created since, minus what the
   * cleanup removed. Synchronous and in-memory on purpose: `onUnload` must not await an
   * object view. Derived from the state ids (not the per-poll name cache, which a
   * transient empty Hub answer clears, and not the device ids, which may lack the
   * state), so every id returned is one the offline write can reach.
   */
  public knownSystemIds(): string[] {
    const out: string[] = [];
    for (const id of this.knownStateIds) {
      const m = /^(systems\.[^.]+)\.info\.online$/.exec(id);
      if (m) {
        out.push(m[1]);
      }
    }
    return out;
  }

  /**
   * Reset every system's `info.online` (and the fleet rollup) to "not online".
   *
   * The device object points its `statusStates.onlineId` at `info.online`, and ioBroker
   * keeps a state's last value forever — so a system stays green in the object tree
   * whenever nothing overwrites it. That happens at startup (the previous run's value
   * survives, and a Hub that is unreachable means no poll ever writes one) as well as
   * after an adapter stop. Called at startup and on shutdown; the poll's failure path
   * uses {@link knownSystemIds} instead, which needs no object view.
   *
   * Only states that actually exist are written — `knownStateIds` is the startup
   * snapshot of the object tree, so an id in it always has an object behind it.
   * `info.status` goes to {@link SYSTEM_STATUS_UNKNOWN} alongside: the Hub's own
   * up/down/paused/pending has no member for "nobody is reading right now", so the
   * datapoint carries a fifth value of its own rather than claiming one of the four.
   * The enum is re-written with the value because an install upgrading from an
   * earlier version still has the four-value list on the object.
   */
  public async markAllOffline(): Promise<void> {
    for (const id of this.knownStateIds) {
      if (!id.startsWith("systems.")) {
        continue;
      }
      if (id.endsWith(".info.online")) {
        await this.adapter.setStateChangedAsync(id, { val: false, ack: true });
      } else if (id.endsWith(".info.status")) {
        // The full object, not just the enum: this IS the every-restart refresh of
        // `info.status` (name, description, five-value list), so the first poll does not
        // write the same object a second time. `ensureStateObject` skips what is in
        // `createdIds`.
        await this.ensureStateObject(id, StateManager.systemStatusCommon());
        await this.adapter.setStateChangedAsync(id, { val: SYSTEM_STATUS_UNKNOWN, ack: true });
      }
    }
    // The fleet rollup makes the same claim one level up — "5 of 5 online" while
    // nothing is being read is the identical lie. systemsTotal stays: the last known
    // count is still the best estimate of how many systems exist.
    if (this.knownStateIds.has("info.systemsOnline")) {
      await this.adapter.setStateChangedAsync("info.systemsOnline", { val: 0, ack: true });
    }
    if (this.knownStateIds.has("info.systemsAllUp")) {
      await this.adapter.setStateChangedAsync("info.systemsAllUp", { val: false, ack: true });
    }
  }

  /** `common` of `<sys>.info.status` — one definition for the poll and the offline reset. */
  private static systemStatusCommon(): ioBroker.StateCommon {
    return {
      ...textCommon(tName("status"), "info.status", tDesc("descStatus")),
      states: systemStatusStates(),
    };
  }

  /**
   * Sanitized names of all existing system devices.
   *
   * v0.16.0: read from `knownDeviceIds` (startup snapshot, kept in sync) instead of an
   * object view. `cleanupSystems` calls this on every successful poll, so the view was
   * a per-poll round-trip for a list the adapter already had.
   */
  public getExistingSystemNames(): string[] {
    const names: string[] = [];
    for (const id of this.knownDeviceIds) {
      const parts = id.split(".");
      if (parts.length === 2 && parts[0] === "systems") {
        names.push(parts[1]);
      }
    }
    return names;
  }

  // -------------------------------------------------------------------------
  // Metric registry (K1): single source of truth for every toggled scalar
  // state. Both the create-path (`applyMetrics`) and the cleanup-path
  // (`cleanupMetrics`) iterate this list, so a metric's toggle → state-id
  // mapping can never drift between "create" and "delete".
  //
  // Dynamic groups (per-sensor temperature, per-fan, per-battery, per-GPU,
  // per-filesystem, per-container) are NOT in here — they fan out to N items
  // and stay in their dedicated handlers (`updateDynamicStats`, `updateContainers`).
  // -------------------------------------------------------------------------

  /**
   * Return a config copy where every detail/peak toggle whose category base is
   * disabled is forced to `false` (see `METRIC_DEPENDENCIES`). Applied at the
   * top of `updateSystem` and `cleanupMetrics` so both create- and cleanup-path
   * see the same effective values — a disabled category's sub-states are never
   * created, and existing ones are pruned.
   *
   * @param config Raw adapter configuration.
   */
  private effectiveConfig(config: AdapterConfig): AdapterConfig {
    const out = { ...config };
    for (const detail of Object.keys(METRIC_DEPENDENCIES) as (keyof typeof METRIC_DEPENDENCIES)[]) {
      const base = METRIC_DEPENDENCIES[detail];
      if (!config[base]) {
        out[detail] = false;
      }
    }
    return out;
  }

  /**
   * Shared metric definitions. `extract` returns the value (or null);
   * `available` (default: always) gates state CREATION exactly like the old
   * inline guards (e.g. cpuBreakdown needs `cpub.length >= 5`). Entries that
   * need live stats set `available: hasStats`.
   *
   * Note: `loadAvg` is defined once here and falls back `stats.la ?? info.la`
   * — this unifies the two old code paths (with-stats in updateStatsStates,
   * without-stats in updateSystem) that previously duplicated it.
   */
  private metricDefsCache?: MetricDef[];

  /**
   * INFO: the registry is stateless — every `available`/`extract` predicate
   * takes (system, stats) as args and closes only over pure helpers, so it can
   * be built once and reused across polls/systems instead of rebuilt (and
   * re-`tName`d) on every applyMetrics/cleanupMetrics call.
   */
  private metricDefs(): MetricDef[] {
    return (this.metricDefsCache ??= buildMetricDefs());
  }

  /**
   * Create + set every enabled scalar metric for one system, driven by the
   * registry. Ensures each needed channel once.
   *
   * @param sysId State prefix (`systems.<safeName>`)
   * @param system The Beszel system record
   * @param stats Latest stats, or undefined
   * @param config Current adapter configuration
   * @param detailsAvailable Whether `system_details` was read at least once this process
   */
  private async applyMetrics(
    sysId: string,
    system: BeszelSystem,
    stats: SystemStats | undefined,
    config: AdapterConfig,
    detailsAvailable: boolean,
  ): Promise<void> {
    // Two separate questions per metric, and they must not be answered together:
    // does its OBJECT belong in the tree, and is there a VALUE to write right now.
    // Tying them together is what left a system that is currently down with the old
    // names and no descriptions — its metrics were skipped whole, so the
    // every-restart retrofit never reached them (measured on the live tree, v0.14.1).
    const touched: { def: MetricDef; writeValue: boolean }[] = [];
    // `pending` and `paused` systems carry the Hub's all-zero `Info{}` — nothing in it is a
    // reading, so the defs that read it keep their last value (see MetricDef.readsInfo).
    const infoIsBlank = system.status === "pending" || system.status === "paused";
    for (const d of this.metricDefs()) {
      if (!config[d.toggle]) {
        continue;
      }
      if (infoIsBlank && (d.readsInfo === "always" || (d.readsInfo === "fallback" && !stats))) {
        const frozenId = `${sysId}.${d.id}`;
        if (this.createdIds.has(frozenId) || this.knownStateIds.has(frozenId)) {
          touched.push({ def: d, writeValue: false });
        }
        continue;
      }
      if (!d.available || d.available(stats, system)) {
        this.absentLastPoll.delete(`${sysId}.${d.id}`);
        touched.push({ def: d, writeValue: true });
        continue;
      }
      // Not available. A state that was never created stays uncreated — an older Hub
      // must not gain empty datapoints.
      const id = `${sysId}.${d.id}`;
      if (!this.createdIds.has(id) && !this.knownStateIds.has(id)) {
        continue;
      }
      // It exists, and the reasons for "not available" need different handling:
      //
      // No stats at all (system down / paused, or its newest record is older than the
      // stats walk) — keep the last reading. The dynamic groups freeze in exactly this
      // case too, and "every ioBroker adapter leaves the last values standing" is the
      // line krobi confirmed. The object still gets its refresh.
      //
      // The field is one the machine may simply not have (`goneWhenAbsent`: sensors,
      // battery, swap, ZFS ARC, a load average from an old agent) — the datapoint is
      // meaningless here, so it is REMOVED. Gating creation alone would leave every
      // install that already ran an older version with a permanent-null state. A stats
      // field is judged only when a record is there, and debounced over two polls like
      // the dynamic groups; an `info.*` field lives in the `systems` row itself, which is
      // there on every poll and is the Hub's own bookkeeping, not a sample that can drop
      // a value — a system that is down is judged too, and at once.
      //
      // H2b: the record IS there but a transiently absent field went missing (`dios`/
      // `cpub` are omitzero/omitempty on the wire, so a fully idle disk drops them) —
      // then the state is reset to null instead of freezing the last busy value.
      // `knownStateIds` alongside `createdIds`, because the latter is empty in a fresh
      // process: without it the reset silently stopped working after every restart.
      //
      // The hardware/OS datapoints come from a different collection than the stats:
      // "no details" is unknown (fetch never succeeded → freeze) unless the collection
      // was read and simply has no row / no value for this system (→ null).
      if (d.goneWhenAbsent === "system" || (stats && d.goneWhenAbsent === "stats")) {
        const confirmed = d.goneWhenAbsent === "system" || this.absentLastPoll.get(id) === true;
        if (confirmed) {
          this.absentLastPoll.delete(id);
          await this.deleteStateIfKnown(id);
          await this.deleteChannelIfEmpty(`${sysId}.${d.channel}`);
        } else {
          this.absentLastPoll.set(id, true);
        }
        continue;
      }
      touched.push({ def: d, writeValue: d.toggle === "metrics_agentVersion" ? detailsAvailable : !!stats });
    }

    const channels = new Set(touched.map(t => t.def.channel));
    for (const ch of channels) {
      await this.ensureChannel(`${sysId}.${ch}`, channelName(ch));
    }
    for (const { def, writeValue } of touched) {
      const id = `${sysId}.${def.id}`;
      if (!writeValue) {
        await this.ensureStateObject(id, commonFor(def));
        continue;
      }
      const raw = def.extract(system, stats);
      const value = def.kind === "percent" && typeof raw === "number" ? clampPercent(raw) : raw;
      await this.createAndSetState(id, commonFor(def), value);
    }
  }

  /**
   * The adapter is unloading: no update started after this writes a system's online state.
   */
  public stop(): void {
    this.stopped = true;
  }

  /**
   * Update all states for a single system.
   *
   * @param system Beszel system record
   * @param stats Latest stats for this system, or undefined if unavailable
   * @param containers Container records belonging to this system (pre-filtered by the poll)
   * @param rawConfig Adapter configuration (detail toggles are gated on their category base via effectiveConfig)
   * @param containersAvailable F1: whether the container fetch succeeded this poll. `false`
   *   (403 / timeout) means "unknown" — the container tree is left untouched (frozen), never
   *   pruned. Defaults to `true` so unit tests exercising other metrics need not pass it.
   * @param extras Records of the three detail collections belonging to this system; a field left out means "not read this round" and freezes those datapoints.
   * @param detailsAvailable Whether the `system_details` collection was read successfully at
   *   least once in this process. `false` means the details are UNKNOWN: existing `info.*`
   *   states freeze and the device icon is left as it is. `true` with no `system.details`
   *   means the Hub really has no row (pending system). Defaults to `false`.
   */
  public async updateSystem(
    system: BeszelSystem,
    stats: SystemStats | undefined,
    containers: BeszelContainer[],
    rawConfig: AdapterConfig,
    containersAvailable = true,
    extras: SystemExtras = {},
    detailsAvailable = false,
  ): Promise<void> {
    // Detail toggles inherit their category's base toggle (off category → off
    // detail). Applied once here so applyMetrics + updateDynamicStats + the
    // container path all see the same effective config.
    const config = this.effectiveConfig(rawConfig);
    const safeName = this.resolvedSafeName(system);
    const sysId = `systems.${safeName}`;
    this.activePoolIds.delete(sysId);
    // v0.4.4 (G1): trace the state-tree entry (after safeName resolution but
    // before any extendObjectAsync). Shows the name → safeName mapping —
    // useful when collisions cause SM5 suffix-disambiguation.
    this.adapter.log.debug(`updateSystem state-tree: '${sanitizeForLog(system.name)}' → safeName='${safeName}'`);

    // Create/update the device object with its online indicator and OS pictogram.
    // v0.7.2: only write when something actually changed — extendObject on every poll
    // meant one object write + objectChange event per system per minute for data that
    // practically never changes. The signature is primed from the stored object at
    // start, so a restart with unchanged data writes nothing at all.
    //
    // The icon is an INPUT of the signature, taken from the details when those were
    // read (no row → the generic server), and from the stored object while the details
    // are unknown — a Hub that is slow at start must not swap a correct pictogram for
    // the fallback.
    //
    // No `preserve` on the name (v0.18.0): the Hub is where a system gets its name, and
    // a rename there that keeps the sanitized id ("nas" → "NAS") has to reach the tree.
    // The Hub name is the adapter's own text like every other name it writes.
    const name = sanitizeDisplayName(system.name);
    const icon = detailsAvailable ? deviceIcon(system.details?.os) : this.deviceIcons.get(sysId);
    const deviceSig = StateManager.deviceSignature(system.id, system.host, name, icon);
    if (this.deviceWritten.get(sysId) !== deviceSig) {
      await this.adapter.extendObject(sysId, {
        type: "device",
        common: {
          name,
          ...(icon !== undefined ? { icon } : {}),
          statusStates: {
            onlineId: `${this.adapter.namespace}.${sysId}.info.online`,
          },
        },
        native: { ...API_NAMED, id: system.id, host: system.host },
      });
      this.deviceWritten.set(sysId, deviceSig);
      this.deviceIcons.set(sysId, icon);
      const previousOwner = this.deviceOwners.get(safeName);
      if (previousOwner !== undefined && previousOwner !== system.id) {
        // The system that had this name is gone from the Hub (an owner still there keeps
        // the bare id in prepareForPoll) — the tree, with its history settings, now shows
        // another machine. The user should hear that once.
        this.adapter.log.info(
          `${sysId} now shows the Hub system '${sanitizeForLog(system.name)}' — the system that had this name is no longer on the Hub`,
        );
      }
      this.deviceOwners.set(safeName, system.id);
      // v0.16.0: the device bookkeeping mirrors the tree, so a system the Hub just
      // added has to join it — `getExistingSystemNames` reads this set now.
      this.knownDeviceIds.add(sysId);
    }

    // Info channel (always created)
    await this.ensureChannel(`${sysId}.info`, channelName("info"));

    if (this.stopped) {
      return;
    }
    // Always: online + status
    await this.createAndSetState(
      `${sysId}.info.online`,
      boolCommon(tName("online"), "indicator.reachable", tDesc("descOnline")),
      system.status === "up",
    );
    await this.createAndSetState(`${sysId}.info.status`, StateManager.systemStatusCommon(), system.status);

    // All toggled scalar metrics (info + cpu + memory + disk + network +
    // temperature + battery) are driven by the registry (K1) — single source
    // of truth shared with cleanupMetrics. loadAvg's old with-/without-stats
    // split is unified inside the registry (stats.la ?? info.la fallback).
    await this.applyMetrics(sysId, system, stats, config, detailsAvailable);

    // Dynamic per-item groups (per-sensor temps, per-GPU, per-filesystem)
    // need live stats and fan out to N children — kept in their own handler.
    if (stats) {
      await this.updateDynamicStats(sysId, stats, config);
    } else {
      // No reading: the groups cannot be rebuilt, but their existing datapoints still
      // have to receive corrected names and descriptions.
      await this.refreshDynamicObjects(sysId);
    }

    // Containers and systemd units are LIVE collections: the Hub rewrites their rows on
    // every agent sample and sweeps stale rows — containers 10 minutes, systemd units
    // 20 minutes after the last sample (`internal/records/records_deletion.go`). For a
    // system that is down or paused the Hub therefore returns a SUCCESSFUL empty list,
    // which must not be mistaken for "the containers are gone": both trees are only
    // reconciled while the system is up, and freeze otherwise, exactly like the
    // scalar metrics and the dynamic groups above.
    //
    // F1: a failed container fetch (403 / timeout) arrives as containersAvailable=false
    // — skipped as well, so existing states freeze instead of the prune deleting them.
    // A SUCCESSFUL empty result on an up system still prunes, with the H2 two-poll debounce.
    const live = system.status === "up";
    if (config.metrics_containers && containersAvailable && live) {
      await this.updateContainers(sysId, containers);
    }

    // v0.17.0 — the three extra collections. Each one is skipped unless its records were
    // actually fetched this round (`undefined` = not read, e.g. slow cadence or a failed
    // request): the same rule as the containers above — no reading must never look like
    // "nothing there" to a pruner. ZFS pools and SMART devices are not swept by the Hub,
    // so an empty list there means removed hardware regardless of the system's status.
    if (config.metrics_zfs && config.metrics_zfsDetails && extras.zfsPools) {
      await this.updateZfsDetails(sysId, extras.zfsPools);
    }
    if (config.metrics_smart && extras.smartDevices) {
      await this.updateSmartDevices(sysId, extras.smartDevices);
    }
    if (config.metrics_services && config.metrics_servicesDetails && extras.systemdServices && live) {
      await this.updateSystemdServices(sysId, extras.systemdServices);
    }
  }

  /**
   * Remove device objects for systems that are no longer in Beszel.
   *
   * @param activeSystemNames Sanitized names of currently active systems
   */
  public async cleanupSystems(activeSystemNames: string[]): Promise<void> {
    const activeSet = new Set(activeSystemNames.map(n => this.sanitize(n)));
    // v0.4.3 (SM5): preserve disambiguated suffixed names so SM5-collision
    // entries don't get treated as stale.
    for (const safe of this.resolvedSafeNames.values()) {
      if (safe) {
        activeSet.add(safe);
      }
    }
    const existing = this.getExistingSystemNames();
    const stale = existing.filter(name => !activeSet.has(name));
    // Where each Hub id lives in THIS poll — a stale tree whose owner is still on the Hub
    // under another name was renamed there, which the user should know: the old tree goes
    // with its history and custom settings.
    const safeById = new Map(this.resolvedSafeNames);
    // v0.4.3 (SM1): stale-system removals in parallel.
    await Promise.all(
      stale.map(async name => {
        const owner = this.deviceOwners.get(name);
        const renamedTo = owner !== undefined ? safeById.get(owner) : undefined;
        if (renamedTo !== undefined && renamedTo !== name) {
          this.adapter.log.info(
            `System renamed on the Hub: systems.${name} → systems.${renamedTo} — the old tree and its settings are removed`,
          );
        } else {
          this.adapter.log.info(`System no longer on the Hub: systems.${name} is removed`);
        }
        this.noteStatesRemovedUnder(`systems.${name}`);
        await this.adapter.delObjectAsync(`systems.${name}`, { recursive: true });
        this.dropCacheUnder(`systems.${name}`);
      }),
    );
  }

  /**
   * Drop every cached ID at or under the given prefix. Call after a recursive
   * delObject so subsequent polls re-create the object instead of skipping it.
   *
   * v0.16.0: `knownChannelIds` and `knownDeviceIds` are cleared here too. They were
   * filled by the startup snapshot and never pruned, so `refreshDynamicObjects` kept
   * finding — and `extendObject`-recreating — group channels the cleanup or the
   * drop-to-zero prune had just deleted: an empty `containers` / `gpu` / `cpu.cores` …
   * channel reappeared on the first poll of every system without a reading, and again
   * after each restart (v0.16.0).
   *
   * @param prefix State ID prefix (e.g. `systems.my_server`)
   */
  private dropCacheUnder(prefix: string): void {
    // Every cache keyed by an object id follows the same lifecycle: a removed system
    // that is re-added later must go through the full reconcile/write path again.
    // `idsUnder` copies the matching keys first, so deleting while iterating is safe.
    const caches: (Set<string> | Map<string, unknown>)[] = [
      this.createdIds,
      this.knownChannelIds,
      this.knownDeviceIds,
      this.dynamicChildren,
      this.deviceWritten,
      this.deviceIcons,
      this.lastGroupEmpty,
      this.absentLastPoll,
      this.staleUnitObjects,
      this.groupOwners,
    ];
    for (const cache of caches) {
      for (const id of StateManager.idsUnder(cache.keys(), prefix)) {
        cache.delete(id);
      }
    }
    // Keyed by safeName, not by object id: a removed system gives up its bare name.
    const segments = prefix.split(".");
    if (segments.length === 2 && segments[0] === "systems") {
      this.deviceOwners.delete(segments[1]);
    }
  }

  /**
   * Delete states for metrics that have been disabled in the config.
   * Called on startup to clean up previously-enabled states.
   *
   * v0.16.0: decided entirely from the startup snapshot — `knownStateIds` and
   * `knownChannelIds` answer "does this object exist" for free, where the method used to
   * fire one `getObjectAsync` per disabled metric per system (34 of 53 registry entries
   * on the default configuration), one per channel candidate and an extra view plus one
   * read per GPU. Measured before the change: 43 object reads per system on every start.
   *
   * @param systemId Sanitized system name (the part after "systems.")
   * @param rawConfig Adapter configuration (detail toggles are gated on their category base via effectiveConfig)
   */
  public async cleanupMetrics(systemId: string, rawConfig: AdapterConfig): Promise<void> {
    // Same dependency gating as updateSystem: a disabled category forces its
    // detail toggles off, so their states (and empty channels) get pruned.
    const config = this.effectiveConfig(rawConfig);
    const sysId = `systems.${systemId}`;

    // Scalar metrics: delete the state of every disabled toggle. Driven by the
    // SAME registry as `applyMetrics` (K1) — create- and cleanup-path share one
    // source of truth, so a metric's toggle → state-id mapping can never drift.
    const toDelete = this.metricDefs()
      .filter(def => !config[def.toggle])
      .map(def => `${sysId}.${def.id}`)
      .filter(id => this.knownStateIds.has(id));

    // v0.4.3 (SM2): the deletes run in parallel.
    await Promise.all(toDelete.map(id => this.deleteStateIfKnown(id)));

    // Delete empty channels when all metrics in a group are disabled.
    // v0.7.2: the per-channel toggle lists are DERIVED from the registry
    // (plus the dynamic-group toggles that also write into the channel)
    // instead of hand-maintained boolean chains — a new metric def can no
    // longer drift out of its channel's emptiness condition.
    const channelToggles = new Map<string, Set<keyof AdapterConfig>>();
    for (const def of this.metricDefs()) {
      if (def.channel === "info") {
        continue; // the info channel always exists (online/status) — never deleted
      }
      const set = channelToggles.get(def.channel) ?? new Set<keyof AdapterConfig>();
      set.add(def.toggle);
      channelToggles.set(def.channel, set);
    }
    for (const [channel, extras] of Object.entries(DYNAMIC_CHANNEL_TOGGLES)) {
      const set = channelToggles.get(channel) ?? new Set<keyof AdapterConfig>();
      for (const t of extras) {
        set.add(t);
      }
      channelToggles.set(channel, set);
    }
    for (const [channel, toggles] of channelToggles) {
      if ([...toggles].every(t => !config[t])) {
        await this.deleteChannelIfExists(`${sysId}.${channel}`);
      }
    }

    // Dynamic SUB-channels. v0.16.0: a table like the one above, not a hand-written
    // `if` per channel — the two ways of expressing the same rule were what let a
    // dynamic group be added without a cleanup branch.
    for (const [sub, toggle] of Object.entries(DYNAMIC_SUBCHANNEL_TOGGLES)) {
      if (!config[toggle]) {
        await this.deleteChannelIfExists(`${sysId}.${sub}`);
      }
    }

    // v0.7.2: gpuDetails off (GPU category still on) used to leave the
    // power_package state + engines channel of every GPU behind forever —
    // the only detail toggle without a cleanup branch. The per-GPU ids are
    // dynamic, so enumerate the existing GPU channels from the snapshot.
    // v0.17.0: the same shape one level deeper — ZFS DETAILS off while the ZFS group
    // stays on. The per-pool ids are dynamic, so the pool channels are enumerated from
    // the snapshot exactly like the GPUs below.
    if (config.metrics_zfs && !config.metrics_zfsDetails) {
      const zfsBase = `${sysId}.zfs`;
      for (const id of StateManager.idsUnder(this.knownChannelIds, zfsBase)) {
        const child = id.slice(`${zfsBase}.`.length);
        // Direct pool channels only (`zfs.<pool>`), not their vdevs/datasets channels.
        if (!child || child.includes(".")) {
          continue;
        }
        const pool = `${zfsBase}.${child}`;
        await this.deleteStateIfKnown(`${pool}.scrub_state`);
        await this.deleteStateIfKnown(`${pool}.scrub_progress`);
        await this.deleteStateIfKnown(`${pool}.scrub_errors`);
        await this.deleteChannelIfExists(`${pool}.vdevs`);
        await this.deleteChannelIfExists(`${pool}.datasets`);
      }
    }

    if (config.metrics_gpu && !config.metrics_gpuDetails) {
      const gpuBase = `${sysId}.gpu`;
      for (const id of StateManager.idsUnder(this.knownChannelIds, gpuBase)) {
        const child = id.slice(`${gpuBase}.`.length);
        // Direct GPU channels only (`gpu.<id>`), not the engines channels.
        if (!child || child.includes(".")) {
          continue;
        }
        await this.deleteStateIfKnown(`${gpuBase}.${child}.power_package`);
        await this.deleteChannelIfExists(`${gpuBase}.${child}.engines`);
      }
    }
  }

  /**
   * Delete one state object if the bookkeeping says it exists, and keep the counters
   * and caches in step. No-op otherwise.
   *
   * @param id State id, namespace-relative.
   */
  private async deleteStateIfKnown(id: string): Promise<void> {
    if (!this.knownStateIds.has(id)) {
      return;
    }
    await this.adapter.delObjectAsync(id);
    this.createdIds.delete(id);
    this.noteStateRemoved(id);
  }

  /**
   * Delete a channel whose last datapoint just went away, so no empty `temperature` /
   * `battery` … object lingers — the same H2d rule the dynamic groups apply to their
   * emptied parent. A channel that still carries a state or a sub-channel stays.
   *
   * @param id Channel id, namespace-relative.
   */
  private async deleteChannelIfEmpty(id: string): Promise<void> {
    if (!this.knownChannelIds.has(id)) {
      return;
    }
    const dot = `${id}.`;
    for (const known of [this.knownStateIds, this.knownChannelIds]) {
      for (const other of known) {
        if (other.startsWith(dot)) {
          return;
        }
      }
    }
    await this.adapter.delObjectAsync(id);
    this.dropCacheUnder(id);
  }

  /**
   * Delete the states a release retired ({@link RETIRED_STATE_IDS}) from every existing
   * system, plus the obsolete `info.legacyMigrated` marker. Runs once during onReady,
   * before the first poll.
   *
   * Reads only the startup snapshot — an id that is not in it is skipped without a
   * round-trip, so on an install that never had the objects the sweep costs nothing.
   *
   * @param existingNames Pre-enumerated system device names, or undefined to enumerate here.
   */
  public async removeRetiredStates(existingNames?: string[]): Promise<void> {
    // The sweep reads the snapshot, so it has to exist. onReady always takes it
    // first; a direct caller (unit test) gets it taken here. Idempotent.
    if (!this.snapshotTaken) {
      await this.snapshotExistingStates();
    }
    await this.removeLegacyMigrationMarker();

    const names = existingNames ?? this.getExistingSystemNames();
    let removed = 0;
    for (const name of names) {
      for (const stateId of RETIRED_STATE_IDS) {
        const fullId = `systems.${name}.${stateId}`;
        if (!this.knownStateIds.has(fullId)) {
          continue;
        }
        await this.deleteStateIfKnown(fullId);
        removed++;
      }
    }
    if (removed > 0) {
      this.adapter.log.info(`Removed ${removed} retired state(s)`);
    }
  }

  /**
   * v0.14.0: drop the obsolete `info.legacyMigrated` marker. It guarded a scan that
   * costs nothing any more, and every fresh install created it as well — a technical
   * bookkeeping flag in the user's object tree that says nothing about the system
   * being monitored. Counted like any other removal, so the datapoint line reports it.
   */
  private async removeLegacyMigrationMarker(): Promise<void> {
    const id = "info.legacyMigrated";
    if (!this.knownStateIds.has(id)) {
      return;
    }
    await this.adapter.delObjectAsync(id);
    this.createdIds.delete(id);
    this.noteStateRemoved(id);
    this.adapter.log.debug(`Removed the obsolete migration marker ${id}`);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /**
   * Bring the dynamic groups' names and descriptions up to date WITHOUT live data.
   *
   * `updateDynamicStats` only runs when the Hub delivered a reading, so a system that is
   * currently down never had its container / GPU / interface / filesystem datapoints
   * refreshed — they kept the wording they were created with, and no gate can see that
   * (found on the live tree, v0.14.1). This walks what the bookkeeping already knows:
   * the group channels the adapter names itself, and the leaves of
   * `DYNAMIC_LEAF_PATTERNS`. It creates nothing, deletes nothing, writes no value.
   *
   * v0.16.0: the `common` comes from `leafCommon()` — the SAME table the creation paths
   * below use. Until then this method carried its own copy of all 29 definitions, kept
   * in step by an invariant test that only checked coverage, never equality.
   *
   * @param sysId State prefix (`systems.<safeName>`).
   */
  private async refreshDynamicObjects(sysId: string): Promise<void> {
    const prefix = `${sysId}.`;
    // Group channels the adapter names (temperature.sensors, cpu.cores, containers, …),
    // recognised by their PLACE in the tree. A channel named by the Hub (gpu.<id>,
    // containers.<name>) is skipped even when its name happens to equal a catalog key —
    // a container called `gpu` must keep its name, not become "GPU" on every poll.
    for (const id of this.knownChannelIds) {
      if (!id.startsWith(prefix)) {
        continue;
      }
      const rel = id.slice(prefix.length);
      const group = DYNAMIC_CHANNEL_PATTERNS.find(entry => entry.match.test(rel));
      if (group) {
        await this.ensureChannel(id, channelName(group.key));
      }
    }
    for (const id of this.knownStateIds) {
      if (!id.startsWith(prefix)) {
        continue;
      }
      const rel = id.slice(prefix.length);
      for (const entry of DYNAMIC_LEAF_PATTERNS) {
        const m = rel.match(entry.match);
        if (m) {
          await this.ensureStateObject(id, leafCommon(entry.id, m[1]));
          break;
        }
      }
    }
  }

  private async updateDynamicStats(sysId: string, stats: SystemStats, config: AdapterConfig): Promise<void> {
    // Temperature details — per-sensor. Sensor names come from the agent
    // (e.g. "coretemp_package0") and have no fixed translation — shown as-is.
    // Ensure the parent `temperature` channel here too: the registry only
    // creates it when the average (metrics_temperature) is enabled, but the
    // details can be on with the average off.
    if (config.metrics_temperatureDetails) {
      // v0.7.2 + H2: sensors are pruned even when every one vanished (debounced
      // 2 polls so a transient empty response doesn't wipe them).
      await this.syncDynamicGroup(
        `${sysId}.temperature.sensors`,
        stats.t ? Object.entries(stats.t) : [],
        "state",
        async () => {
          await this.ensureChannel(`${sysId}.temperature`, channelName("temperature"));
          await this.ensureChannel(`${sysId}.temperature.sensors`, channelName("sensors"));
        },
        async (safeSensor, sensor, temp) => {
          await this.createAndSetState(
            `${sysId}.temperature.sensors.${safeSensor}`,
            numCommon(sanitizeDisplayName(sensor), "°C", "value.temperature"),
            temp,
            API_NAMED,
          );
        },
      );
    }

    // Fan speeds (v0.11.0, Beszel 0.18.8+). Fan names come from the agent's
    // hwmon walk (`<chip>_<label-or-fanN>`, may contain spaces) and have no
    // fixed translation — shown as-is. 0 RPM is a real reading (stopped fan).
    // Role: plain `value` — the catalog has no measured-RPM role (`value.speed`
    // is wind, `level.speed` is a writable fan setpoint).
    if (config.metrics_fans) {
      await this.syncDynamicGroup(
        `${sysId}.fans`,
        stats.f ? Object.entries(stats.f) : [],
        "state",
        async () => {
          await this.ensureChannel(`${sysId}.fans`, channelName("fans"));
        },
        async (safeFan, fan, rpm) => {
          await this.createAndSetState(
            `${sysId}.fans.${safeFan}`,
            numCommon(sanitizeDisplayName(fan), "rpm"),
            rpm,
            API_NAMED,
          );
        },
      );
    }

    // Per-battery charge (v0.11.0, Beszel 0.18.8+). Battery names come from the
    // OS (fallback `Battery N`) — shown as-is. Every reported battery gets a
    // state, deliberately without a "only if >= 2" threshold: such a threshold
    // would make a docked laptop dropping from two batteries to one DELETE the
    // children, which reads as a bug. Same shape as temperature.sensors. Rides
    // on the battery toggle (itself opt-in) — no config switch of its own.
    if (config.metrics_battery) {
      await this.syncDynamicGroup(
        `${sysId}.battery.batteries`,
        stats.bats ? Object.entries(stats.bats) : [],
        "state",
        async () => {
          await this.ensureChannel(`${sysId}.battery`, channelName("battery"));
          await this.ensureChannel(`${sysId}.battery.batteries`, channelName("batteries"));
        },
        async (safeBat, bat, percent) => {
          await this.createAndSetState(
            `${sysId}.battery.batteries.${safeBat}`,
            percentCommon(sanitizeDisplayName(bat), "value.battery"),
            clampPercent(percent),
            API_NAMED,
          );
        },
      );
    }

    // Per-core CPU usage (v0.6.0). Core labels are positional (CPU0..), shown as-is.
    if (config.metrics_cpuCores) {
      const cores = stats.cpus ?? [];
      const activeCores = new Set<string>();
      if (cores.length > 0) {
        await this.ensureChannel(`${sysId}.cpu`, channelName("cpu"));
        await this.ensureChannel(`${sysId}.cpu.cores`, channelName("cores"));
        for (let i = 0; i < cores.length; i++) {
          activeCores.add(`core${i}`);
          await this.createAndSetState(
            `${sysId}.cpu.cores.core${i}`,
            // Positional label, but still a translation object: the fleet standard
            // wants one for every object, and `%s` carries the index into each language.
            leafCommon("cpuCore", String(i)),
            clampPercent(cores[i]),
          );
        }
      }
      // v0.7.2 + H2: prune core states beyond the current count (VM resized down).
      await this.pruneGroup(`${sysId}.cpu.cores`, activeCores, "state", cores.length === 0);
    }

    // Per-network-interface (v0.6.0). ni: name -> [up, down, total up, total down] raw bytes.
    // US7: normalized to MB/s (speeds) + GB (totals) so per-interface matches the
    // MiB-based aggregate network.sent/recv scale instead of showing raw bytes.
    if (config.metrics_networkInterfaces) {
      // v0.7.2 + H2: renamed/removed interfaces are pruned on drop-to-zero too (debounced).
      await this.syncDynamicGroup(
        `${sysId}.network.interfaces`,
        stats.ni ? Object.entries(stats.ni) : [],
        "channel",
        async () => {
          await this.ensureChannel(`${sysId}.network`, channelName("network"));
          await this.ensureChannel(`${sysId}.network.interfaces`, channelName("interfaces"));
        },
        async (safeId, iface, vals) => {
          // Interface name is OS-defined (eth0, wlan0, ...) → kept as-is.
          await this.ensureChannel(`${sysId}.network.interfaces.${safeId}`, sanitizeDisplayName(iface), API_NAMED);
          await this.createAndSetState(
            `${sysId}.network.interfaces.${safeId}.up`,
            leafCommon("ifaceUp"),
            bytesToMib(vals[0]),
          );
          await this.createAndSetState(
            `${sysId}.network.interfaces.${safeId}.down`,
            leafCommon("ifaceDown"),
            bytesToMib(vals[1]),
          );
          await this.createAndSetState(
            `${sysId}.network.interfaces.${safeId}.total_up`,
            leafCommon("ifaceTotalUp"),
            bytesToGib(vals[2]),
          );
          await this.createAndSetState(
            `${sysId}.network.interfaces.${safeId}.total_down`,
            leafCommon("ifaceTotalDown"),
            bytesToGib(vals[3]),
          );
        },
      );
    }

    // GPU — gpuData.n is the raw vendor name; we keep it as a plain string.
    // v0.7.2 + H2: a GPU that disappeared from the host (eGPU unplugged, VM
    // passthrough change) used to keep its whole channel forever. Debounced.
    if (config.metrics_gpu) {
      await this.syncDynamicGroup(
        `${sysId}.gpu`,
        stats.g ? Object.entries(stats.g) : [],
        "channel",
        async () => {
          await this.ensureChannel(`${sysId}.gpu`, channelName("gpu"));
        },
        async (safeId, gpuId, gpuData) => {
          await this.ensureChannel(`${sysId}.gpu.${safeId}`, sanitizeDisplayName(gpuData.n ?? gpuId), API_NAMED);
          await this.createAndSetState(
            `${sysId}.gpu.${safeId}.usage`,
            leafCommon("gpuUsage"),
            clampPercent(gpuData.u ?? null),
          );
          // `mu`/`mt` are `omitzero`: a GPU without dedicated memory (Intel/AMD iGPU,
          // Apple) sends neither — the Hub UI draws no VRAM chart then (`mt > 0`), and no
          // datapoint stands at null for it here.
          const hasVram = (gpuData.mt ?? 0) > 0;
          await this.setOrRetire(
            `${sysId}.gpu.${safeId}.memory_used`,
            leafCommon("gpuMemoryUsed"),
            hasVram ? (gpuData.mu ?? 0) : null,
          );
          await this.setOrRetire(
            `${sysId}.gpu.${safeId}.memory_total`,
            leafCommon("gpuMemoryTotal"),
            hasVram ? (gpuData.mt ?? null) : null,
          );
          await this.createAndSetState(`${sysId}.gpu.${safeId}.power`, leafCommon("gpuPower"), gpuData.p ?? null);
          // GPU details (v0.6.0): package power + per-engine usage. Engines the
          // driver stopped reporting get pruned (debounced) — nested group.
          if (config.metrics_gpuDetails) {
            await this.createAndSetState(
              `${sysId}.gpu.${safeId}.power_package`,
              leafCommon("gpuPowerPackage"),
              gpuData.pp ?? null,
            );
            await this.syncDynamicGroup(
              `${sysId}.gpu.${safeId}.engines`,
              gpuData.e ? Object.entries(gpuData.e) : [],
              "state",
              async () => {
                await this.ensureChannel(`${sysId}.gpu.${safeId}.engines`, channelName("engines"));
              },
              async (safeEngine, engine, value) => {
                // Engine name is vendor-defined → kept as-is.
                await this.createAndSetState(
                  `${sysId}.gpu.${safeId}.engines.${safeEngine}`,
                  percentCommon(sanitizeDisplayName(engine)),
                  clampPercent(value),
                  API_NAMED,
                );
              },
            );
          }
        },
      );
    }

    // Extra filesystems — fsName is the raw mount path, kept as plain string.
    // v0.7.2 + H2: an unmounted/renamed extra filesystem used to keep its
    // channel with frozen values forever. Debounced for the drop-to-zero case.
    if (config.metrics_extraFs) {
      await this.syncDynamicGroup(
        `${sysId}.filesystems`,
        stats.efs ? Object.entries(stats.efs) : [],
        "channel",
        async () => {
          await this.ensureChannel(`${sysId}.filesystems`, channelName("filesystems"));
        },
        async (safeId, fsName, fsData) => {
          await this.ensureChannel(`${sysId}.filesystems.${safeId}`, sanitizeDisplayName(fsName), API_NAMED);

          const total = fsData.d ?? null;
          const used = fsData.du ?? null;
          // v0.4.3 (SM8): clamped whole percent, shared with the ZFS pools (usedPercent).
          const percent = usedPercent(total, used);

          await this.createAndSetState(
            `${sysId}.filesystems.${safeId}.disk_percent`,
            leafCommon("fsDiskPercent"),
            percent,
          );
          await this.createAndSetState(`${sysId}.filesystems.${safeId}.disk_used`, leafCommon("fsDiskUsed"), used);
          await this.createAndSetState(`${sysId}.filesystems.${safeId}.disk_total`, leafCommon("fsDiskTotal"), total);
          await this.createAndSetState(
            `${sysId}.filesystems.${safeId}.read_speed`,
            leafCommon("fsReadSpeed"),
            fsData.r ?? null,
          );
          await this.createAndSetState(
            `${sysId}.filesystems.${safeId}.write_speed`,
            leafCommon("fsWriteSpeed"),
            fsData.w ?? null,
          );
          // Beszel 0.19.0: cumulative device counters per filesystem — a volume in GB,
          // gated on presence so an older Hub creates no empty state.
          if (fsData.tr !== undefined) {
            await this.createAndSetState(
              `${sysId}.filesystems.${safeId}.total_read`,
              leafCommon("fsTotalRead"),
              bytesToGib(fsData.tr),
            );
          }
          if (fsData.tw !== undefined) {
            await this.createAndSetState(
              `${sysId}.filesystems.${safeId}.total_write`,
              leafCommon("fsTotalWrite"),
              bytesToGib(fsData.tw),
            );
          }
        },
      );
    }

    // ZFS pools (v0.15.0, Beszel 0.19.0+). Pool names come from `zpool list` — shown
    // as-is (API-named channel). Capacity arrives in GiB like the root disk and is
    // labelled GB by the same convention; throughput arrives in bytes/s and is shown
    // as MB/s like every other rate here (MiB-based, US7) — the Hub omits zero, so
    // absent means idle, not unknown. Health is zpool's own word; `common.states`
    // is a hint for the UI, never a filter.
    if (config.metrics_zfs) {
      const poolIds = new Map<string, string>();
      this.activePoolIds.set(sysId, poolIds);
      await this.syncDynamicGroup(
        `${sysId}.zfs`,
        stats.z ? Object.entries(stats.z) : [],
        "channel",
        async () => {
          await this.ensureChannel(`${sysId}.zfs`, channelName("zfs"));
        },
        async (safeId, poolName, pool) => {
          poolIds.set(poolName, safeId);
          const base = `${sysId}.zfs.${safeId}`;
          await this.ensureChannel(base, StateManager.poolDisplayName(poolName, pool.n), API_NAMED);
          const total = pool.d ?? null;
          const used = pool.du ?? null;
          await this.createAndSetState(`${base}.pool_type`, leafCommon("zfsPoolType"), StateManager.poolType(poolName));
          await this.createAndSetState(`${base}.raw`, leafCommon("zfsRaw"), pool.raw === true);
          if (pool.raw === true) {
            // Raw physical bytes (a btrfs pool whose filesystem figures the agent could not
            // read, RAID copies counted twice): the agent calls them unsuitable for alerts,
            // so no percentage is derived from them.
            await this.deleteStateIfKnown(`${base}.disk_percent`);
          } else {
            await this.createAndSetState(
              `${base}.disk_percent`,
              leafCommon("zfsDiskPercent"),
              usedPercent(total, used),
            );
          }
          await this.createAndSetState(`${base}.disk_used`, leafCommon("zfsDiskUsed"), used);
          await this.createAndSetState(`${base}.disk_total`, leafCommon("zfsDiskTotal"), total);
          await this.createAndSetState(`${base}.read_speed`, leafCommon("zfsReadSpeed"), bytesToMib(pool.rb ?? 0));
          await this.createAndSetState(`${base}.write_speed`, leafCommon("zfsWriteSpeed"), bytesToMib(pool.wb ?? 0));
          await this.createAndSetState(`${base}.health`, leafCommon("zfsHealth"), pool.h ?? null);
        },
      );
    }
  }

  /**
   * The storage stack behind a pool key: Beszel 0.20.0 files a btrfs filesystem under
   * `b:<UUID>` next to the ZFS pools (`agent/storage_pool.go`; the Hub UI tells them apart
   * by the same prefix).
   *
   * @param key The pool key from `stats.z` / `zfs_pools.name`.
   */
  private static poolType(key: string): "zfs" | "btrfs" {
    return key.startsWith("b:") ? "btrfs" : "zfs";
  }

  /**
   * The name a pool channel shows: the agent's display name (a btrfs label, mount point or
   * UUID) where there is one, else the key — a ZFS pool's key IS its name. The channel id
   * stays the key: a label or a mount point can change, the key cannot.
   *
   * @param key The pool key.
   * @param displayName `n` / `display_name`, when the agent sent one.
   */
  private static poolDisplayName(key: string, displayName: string | undefined): string {
    return sanitizeDisplayName(displayName && displayName.length > 0 ? displayName : key);
  }

  /**
   * v0.17.0 — ZFS pool DETAILS from the `zfs_pools` collection: scrub state, the vdev
   * error counters and the datasets. Deliberately does NOT prune the pool level: the
   * per-poll summary in {@link updateDynamicStats} already owns `<sys>.zfs`, and two
   * pruners on one base would fight over every pool the other one has not seen yet.
   * Each subgroup below a pool prunes its own base.
   *
   * @param sysId State prefix (`systems.<safeName>`).
   * @param details Pool detail records of THIS system (already filtered).
   */
  private async updateZfsDetails(sysId: string, details: ZfsPoolDetail[]): Promise<void> {
    // Only the pools the summary reported in this poll, under the ids the summary gave
    // them. No summary this poll (no stats record — the system is down) → freeze.
    const poolIds = this.activePoolIds.get(sysId);
    if (!poolIds) {
      return;
    }
    for (const pool of details) {
      const safeId = poolIds.get(pool.name);
      if (!safeId) {
        continue;
      }
      const base = `${sysId}.zfs.${safeId}`;
      await this.ensureChannel(base, StateManager.poolDisplayName(pool.name, pool.displayName), API_NAMED);

      if (pool.scrubState !== undefined) {
        await this.createAndSetState(`${base}.scrub_state`, leafCommon("scrubState"), pool.scrubState);
        await this.createAndSetState(`${base}.scrub_progress`, leafCommon("scrubProgress"), pool.scrubProgress ?? null);
        await this.createAndSetState(`${base}.scrub_errors`, leafCommon("scrubErrors"), pool.scrubErrors ?? null);
      } else {
        // No scrub record: a ZFS pool never scrubbed, or any btrfs pool (the agent sends
        // none). Three datapoints that could only ever hold null would be hardware the
        // pool does not have — and a record that went away takes its datapoints with it.
        await this.deleteStateIfKnown(`${base}.scrub_state`);
        await this.deleteStateIfKnown(`${base}.scrub_progress`);
        await this.deleteStateIfKnown(`${base}.scrub_errors`);
      }

      await this.syncDynamicGroup(
        `${base}.vdevs`,
        pool.vdevs.map(v => [v.name, v] as [string, ZfsVdev]),
        "channel",
        async () => {
          await this.ensureChannel(`${base}.vdevs`, channelName("vdevs"));
        },
        async (vdevId, rawName, vdev) => {
          const vb = `${base}.vdevs.${vdevId}`;
          await this.ensureChannel(vb, sanitizeDisplayName(rawName), API_NAMED);
          await this.createAndSetState(`${vb}.state`, leafCommon("vdevState"), vdev.state ?? null);
          await this.createAndSetState(`${vb}.read_errors`, leafCommon("vdevRead"), vdev.readErrors);
          await this.createAndSetState(`${vb}.write_errors`, leafCommon("vdevWrite"), vdev.writeErrors);
          await this.createAndSetState(`${vb}.checksum_errors`, leafCommon("vdevChecksum"), vdev.checksumErrors);
        },
      );

      await this.syncDynamicGroup(
        `${base}.datasets`,
        pool.datasets.map(d => [d.name, d] as [string, ZfsDataset]),
        "channel",
        async () => {
          await this.ensureChannel(`${base}.datasets`, channelName("datasets"));
        },
        async (dsId, rawName, ds) => {
          const db = `${base}.datasets.${dsId}`;
          await this.ensureChannel(db, sanitizeDisplayName(rawName), API_NAMED);
          // `used`/`avail` are omitempty: an older Hub leaves out a 0 — a full dataset
          // must read 0 available, not "unknown".
          await this.createAndSetState(`${db}.used`, leafCommon("datasetUsed"), bytesToGib(ds.used ?? 0));
          await this.createAndSetState(`${db}.avail`, leafCommon("datasetAvail"), bytesToGib(ds.avail ?? 0));
          await this.createAndSetState(`${db}.mountpoint`, leafCommon("datasetMount"), ds.mountpoint ?? null);
        },
      );
    }
  }

  /**
   * Write a reading of hardware the machine may not have, and retire it when it is gone:
   * without a value, a state that does not exist is not created, and an existing one is
   * removed on the SECOND poll in a row without a value (one odd sample must not churn the
   * tree — the same debounce as `goneWhenAbsent: "stats"`).
   *
   * @param id State id, namespace-relative.
   * @param common The state's common.
   * @param value The reading, or `null` when there is none.
   */
  private async setOrRetire(id: string, common: ioBroker.StateCommon, value: number | null): Promise<void> {
    if (value !== null) {
      this.absentLastPoll.delete(id);
      await this.createAndSetState(id, common, value);
      return;
    }
    if (!this.createdIds.has(id) && !this.knownStateIds.has(id)) {
      return;
    }
    if (this.absentLastPoll.get(id) === true) {
      this.absentLastPoll.delete(id);
      await this.deleteStateIfKnown(id);
    } else {
      this.absentLastPoll.set(id, true);
    }
  }

  /**
   * Write a reading that a machine may simply not have: without a value, an object that
   * does not exist yet is not created; one that exists gets `null`.
   *
   * @param id State id, namespace-relative.
   * @param common The state's common.
   * @param value The reading, or `null` when there is none.
   */
  private async setOptionalState(id: string, common: ioBroker.StateCommon, value: number | null): Promise<void> {
    if (value === null && !this.createdIds.has(id) && !this.knownStateIds.has(id)) {
      return;
    }
    await this.createAndSetState(id, common, value);
  }

  /**
   * v0.17.0 — SMART devices from the `smart_devices` collection. A text column the Hub
   * leaves empty reads `null`. Temperature and capacity are hardware a drive may not
   * report at all (a USB bridge without temperature, an eMMC module): their datapoints are
   * only created once there is a value — an existing one then reads `null` while the value
   * is missing, instead of a 0 °C / 0 GB that looks like a measurement.
   *
   * @param sysId State prefix (`systems.<safeName>`).
   * @param devices SMART records of THIS system (already filtered).
   */
  private async updateSmartDevices(sysId: string, devices: SmartDevice[]): Promise<void> {
    await this.syncDynamicGroup(
      `${sysId}.smart`,
      devices.map(d => [d.name, d] as [string, SmartDevice]),
      "channel",
      async () => {
        await this.ensureChannel(`${sysId}.smart`, channelName("smart"));
      },
      async (safeId, rawName, dev) => {
        const b = `${sysId}.smart.${safeId}`;
        await this.ensureChannel(b, sanitizeDisplayName(rawName), API_NAMED);
        await this.createAndSetState(`${b}.state`, leafCommon("smartState"), dev.state ?? null);
        await this.createAndSetState(`${b}.model`, leafCommon("smartModel"), dev.model ?? null);
        await this.createAndSetState(`${b}.serial`, leafCommon("smartSerial"), dev.serial ?? null);
        await this.createAndSetState(`${b}.firmware`, leafCommon("smartFirmware"), dev.firmware ?? null);
        await this.createAndSetState(`${b}.interface`, leafCommon("smartType"), dev.type ?? null);
        await this.setOptionalState(`${b}.temperature`, leafCommon("smartTemp"), dev.temperature ?? null);
        await this.setOptionalState(`${b}.capacity`, leafCommon("smartCapacity"), bytesToGib(dev.capacity));
        await this.createAndSetState(`${b}.power_on_hours`, leafCommon("smartHours"), dev.hours ?? null);
        await this.createAndSetState(`${b}.power_cycles`, leafCommon("smartCycles"), dev.cycles ?? null);
      },
    );
  }

  /**
   * v0.17.0 — systemd units from the `systemd_services` collection. The two enums are
   * written as their WORD, like the container health next to them: the number is the
   * Hub's storage detail, the word is what a user reads and what `common.states` lists.
   *
   * @param sysId State prefix (`systems.<safeName>`).
   * @param services Unit records of THIS system (already filtered).
   */
  private async updateSystemdServices(sysId: string, services: SystemdService[]): Promise<void> {
    await this.syncDynamicGroup(
      `${sysId}.services`,
      services.map(u => [u.name, u] as [string, SystemdService]),
      "channel",
      async () => {
        await this.ensureChannel(`${sysId}.services`, channelName("services"));
      },
      async (safeId, rawName, unit) => {
        const b = `${sysId}.services.${safeId}`;
        await this.ensureChannel(b, sanitizeDisplayName(rawName), API_NAMED);
        await this.createAndSetState(`${b}.state`, leafCommon("serviceState"), serviceStateLabel(unit.state));
        await this.createAndSetState(`${b}.sub_state`, leafCommon("serviceSub"), serviceSubLabel(unit.sub));
        await this.createAndSetState(`${b}.cpu`, leafCommon("serviceCpu"), unit.cpu);
        await this.createAndSetState(`${b}.cpu_peak`, leafCommon("serviceCpuPeak"), unit.cpuPeak);
        await this.createAndSetState(`${b}.memory`, leafCommon("serviceMem"), bytesToMib(unit.memory));
        await this.createAndSetState(`${b}.memory_peak`, leafCommon("serviceMemPeak"), bytesToMib(unit.memPeak));
      },
    );
  }

  /**
   * F5: `sysContainers` is already the list belonging to THIS system — the poll
   * groups the global container list by `system` once (O(containers)) instead of
   * each system re-filtering the whole list (O(systems × containers)).
   *
   * @param sysId State prefix (`systems.<safeName>`).
   * @param sysContainers Container records for this system (already filtered).
   */
  private async updateContainers(sysId: string, sysContainers: BeszelContainer[]): Promise<void> {
    // SEC-6: resolve each container's id segment once (keyed by record id),
    // disambiguating any collision so the prune set and the create loop use the
    // SAME id and two same-sanitizing names never overwrite each other.
    // Keyed by NAME: Docker's container id changes on every re-create (`compose up`), so
    // a suffix derived from it would move the container to a new channel each time.
    const resolvedIds = this.resolveGroupIds(
      `${sysId}.containers`,
      sysContainers.map(c => ({ key: c.name, name: c.name })),
    );

    // F1: prune containers that disappeared from the host. Build the active set
    // and prune BEFORE the early-return — otherwise a system that drops to zero
    // containers would keep its old container state-trees forever.
    // H2: routed through the shared pruneGroup so a container drop-to-zero is
    // debounced PER SYSTEM (2 polls), exactly like the other dynamic groups. This
    // replaces the old global-only F2 debounce (`lastContainersEmpty` in main.ts),
    // which missed one system's containers vanishing while others still reported.
    const activeIds = new Set<string>();
    for (const cId of resolvedIds.values()) {
      if (cId) {
        activeIds.add(cId);
      }
    }
    await this.pruneGroup(`${sysId}.containers`, activeIds, "channel", sysContainers.length === 0);

    if (sysContainers.length === 0) {
      return;
    }

    await this.ensureChannel(`${sysId}.containers`, channelName("containers"));

    for (const container of sysContainers) {
      const cId = resolvedIds.get(container.name) ?? "";
      if (cId.length === 0) {
        continue;
      }
      // container.name is user-defined (Docker container name) → keep as-is.
      await this.ensureChannel(`${sysId}.containers.${cId}`, sanitizeDisplayName(container.name), API_NAMED);
      await this.createAndSetState(
        `${sysId}.containers.${cId}.status`,
        leafCommon("containerStatus"),
        container.status,
      );
      // v0.4.3 (SM7): `containerHealthLabel` floors the index — API drift could send a
      // float (e.g. 2.5), which a bare lookup resolves to undefined. The word list and
      // the matching `common.states` hint live together in the registry (v0.16.0).
      await this.createAndSetState(
        `${sysId}.containers.${cId}.health`,
        leafCommon("containerHealth"),
        containerHealthLabel(container.health),
      );
      await this.createAndSetState(`${sysId}.containers.${cId}.cpu`, leafCommon("containerCpu"), container.cpu);
      await this.createAndSetState(
        `${sysId}.containers.${cId}.memory`,
        leafCommon("containerMemory"),
        container.memory,
      );
      await this.createAndSetState(`${sysId}.containers.${cId}.image`, leafCommon("containerImage"), container.image);
      // v0.6.0: combined network throughput (sent + recv, bytes/s). Only when
      // the Hub provides it — older Hubs omit the `net` column.
      if (container.net != null) {
        await this.createAndSetState(
          `${sysId}.containers.${cId}.network`,
          leafCommon("containerNetwork"),
          container.net,
        );
      }
    }
  }

  /**
   * D3: run one dynamic group's lifecycle — the scaffold shared by the sensor /
   * interface / GPU / filesystem / engine groups. Ensures the parent channel(s),
   * iterates the entries with SEC-6 collision-safe child-id resolution, tracks
   * the active ids, and prunes disappeared members (drop-to-zero debounced).
   * Only the parent-ensure and per-item work vary, so they are callbacks. The
   * per-core group stays hand-written: its children are positional (`core0`..),
   * not an `Object.entries` map, so it does not fit this shape.
   *
   * @param base Group prefix (e.g. `systems.<safeName>.gpu`).
   * @param entries The group's `[rawId, data]` pairs (empty array when absent).
   * @param childType Object type of the direct children (`channel` or `state`).
   * @param ensureParents Creates the parent channel(s); run once before the loop.
   * @param perItem Creates the child channel/states for one collision-safe id.
   */
  private async syncDynamicGroup<T>(
    base: string,
    entries: [string, T][],
    childType: "channel" | "state",
    ensureParents: () => Promise<void>,
    perItem: (safeId: string, rawId: string, data: T) => Promise<void>,
  ): Promise<void> {
    const active = new Set<string>();
    if (entries.length > 0) {
      await ensureParents();
      const ids = this.resolveGroupIds(
        base,
        entries.map(([rawId]) => ({ key: rawId, name: rawId })),
      );
      for (const [rawId, data] of entries) {
        const safeId = ids.get(rawId) ?? "";
        if (!safeId) {
          continue;
        }
        active.add(safeId);
        await perItem(safeId, rawId, data);
      }
    }
    await this.pruneGroup(base, active, childType, entries.length === 0);
  }

  /**
   * H2: prune a dynamic group's disappeared children, debounced over two polls — for the
   * whole group AND for each member. An EMPTY group (all members gone) prunes only on the
   * SECOND consecutive empty poll; a single member that is missing from a non-empty group
   * is also only removed when it is still missing on the next poll (a GPU whose
   * temperature reads 0 °C drops out of the sensor map for a sample, a sleeping NVMe, a
   * briefly vanished interface — removing and re-creating it lost its history settings).
   * Used by every dynamic group incl. containers.
   *
   * @param base Group prefix (e.g. `systems.<safeName>.gpu`).
   * @param activeIds Sanitized direct-child segments currently present.
   * @param childType Object type of the direct children (`channel` or `state`).
   * @param isEmpty Whether the group has zero members this poll.
   */
  private async pruneGroup(
    base: string,
    activeIds: Set<string>,
    childType: "channel" | "state",
    isEmpty: boolean,
  ): Promise<void> {
    const wasEmpty = this.lastGroupEmpty.get(base) ?? false;
    this.lastGroupEmpty.set(base, isEmpty);
    if (!isEmpty || wasEmpty) {
      // A group confirmed empty over two polls has served its debounce already.
      await this.pruneDynamicChildren(base, activeIds, childType, isEmpty && wasEmpty);
    }
  }

  /**
   * v0.7.2 (generalised F1): remove children of a dynamic group that are no
   * longer reported by Beszel — stopped container, removed GPU, renamed
   * network interface or sensor, vanished fan or battery, unmounted filesystem,
   * shrunk core count.
   * Before this only containers were pruned; every other dynamic group left
   * zombie states with frozen values behind forever.
   *
   * Cost model: the object view is queried only on the FIRST call per group
   * after adapter start (reconciles leftovers from previous runs). After
   * that the in-memory set diff detects disappearances with zero DB reads.
   *
   * @param base Group prefix (e.g. `systems.<safeName>.containers`)
   * @param activeIds Sanitized direct-child segments currently present
   * @param childType Object type of the direct children (`channel` or `state`)
   * @param confirmed The absence is already confirmed (the whole group was empty twice):
   *   remove at once instead of waiting a poll per member.
   */
  private async pruneDynamicChildren(
    base: string,
    activeIds: Set<string>,
    childType: "channel" | "state",
    confirmed = false,
  ): Promise<void> {
    let known = this.dynamicChildren.get(base);
    if (!known) {
      // First poll for this group since adapter start: reconcile against what the
      // startup snapshot found, so zombies from previous runs (or older versions) get
      // pruned. v0.16.0: from `knownChannelIds`/`knownStateIds` instead of an object
      // view — the snapshot IS that view, taken once for the whole namespace.
      known = new Set<string>();
      const source = childType === "channel" ? this.knownChannelIds : this.knownStateIds;
      for (const id of StateManager.idsUnder(source, base)) {
        if (id === base) {
          continue;
        }
        // Only the direct child segment (`<base>.<cId>`), not deeper ids.
        const cId = id.slice(base.length + 1).split(".")[0];
        if (cId) {
          known.add(cId);
        }
      }
    }
    for (const cId of activeIds) {
      this.absentLastPoll.delete(`${base}.${cId}`);
    }
    const missing = [...known].filter(cId => !activeIds.has(cId));
    // First poll without a member: remember it and keep it; second poll in a row: remove.
    const stale: string[] = [];
    const waiting: string[] = [];
    for (const cId of missing) {
      const key = `${base}.${cId}`;
      if (confirmed || this.absentLastPoll.get(key) === true) {
        this.absentLastPoll.delete(key);
        stale.push(cId);
      } else {
        this.absentLastPoll.set(key, true);
        waiting.push(cId);
      }
    }
    await Promise.all(
      stale.map(async cId => {
        this.adapter.log.debug(`Removing stale ${childType} ${base}.${cId} (no longer reported)`);
        this.noteStatesRemovedUnder(`${base}.${cId}`);
        await this.adapter.delObjectAsync(`${base}.${cId}`, { recursive: true });
        this.dropCacheUnder(`${base}.${cId}`);
      }),
    );
    // H2d: if that removed the LAST child (the group emptied to zero), delete the
    // now-empty parent group channel too — otherwise an empty `<sysId>.gpu` /
    // `.containers` / `.filesystems` … object lingers. Gated on the emptying
    // transition (something was removed AND nothing is left active).
    if (stale.length > 0 && activeIds.size === 0 && waiting.length === 0 && this.knownChannelIds.has(base)) {
      await this.adapter.delObjectAsync(base);
      this.dropCacheUnder(base);
      // …and the parent channel with it when the group was its last member (a machine
      // whose sensors vanished keeps no empty `temperature` channel either).
      await this.deleteChannelIfEmpty(base.slice(0, base.lastIndexOf(".")));
    }
    this.dynamicChildren.set(base, new Set([...activeIds, ...waiting]));
  }

  /**
   * Ensure a channel exists AND carries the current name. `extendObject`, not
   * `setObjectNotExists`: the names are the adapter's own (translated via
   * `admin/i18n`), so a corrected translation has to reach an installation that
   * already has the channel — otherwise it only ever lands on fresh installs
   * while every gate looks green. Runs once per channel per restart
   * (`createdIds`-gated), so it is a startup cost, not a per-poll write.
   *
   * @param id Channel id, namespace-relative.
   * @param name Current display name (translation object).
   * @param native Extra `native` fields, e.g. the API-name marker of a Hub-named object (Design 31).
   */
  private async ensureChannel(id: string, name: LocalizedName, native: Record<string, unknown> = {}): Promise<void> {
    if (this.createdIds.has(id)) {
      return;
    }
    await this.adapter.extendObject(id, {
      type: "channel",
      common: { name },
      native,
    });
    this.createdIds.add(id);
    // v0.16.0: the channel bookkeeping is only a truthful mirror of the tree if a
    // freshly created channel joins it — everything that asks "does this channel
    // exist" now reads this set instead of the objects DB.
    this.knownChannelIds.add(id);
  }

  /**
   * @param id Channel id to delete (recursively) if it exists.
   */
  private async deleteChannelIfExists(id: string): Promise<void> {
    if (!this.knownChannelIds.has(id)) {
      return;
    }
    try {
      this.noteStatesRemovedUnder(id);
      await this.adapter.delObjectAsync(id, { recursive: true });
      this.dropCacheUnder(id);
    } catch (err) {
      // v0.5.0 (S2): a silent catch replaced by a debug trace. A broker that is already
      // down is expected here — keep it out of the user log but leave a breadcrumb.
      this.adapter.log.debug(`deleteChannelIfExists(${id}) ignored: ${errText(err)}`);
    }
  }

  /**
   * Make sure the state object exists and carries the CURRENT common (name,
   * description, role, unit) — without touching its value.
   *
   * Split out of {@link createAndSetState} because a datapoint of a system the Hub has
   * no reading for still has to receive corrected names and descriptions. Tying the
   * object refresh to "there is a value to write" left every currently-down system on
   * the old wording, which no gate can see — only the live tree (v0.14.1).
   *
   * @param id State id, namespace-relative.
   * @param common The state's current common definition.
   * @param native Extra `native` fields, e.g. the API-name marker of a Hub-named object (Design 31).
   */
  private async ensureStateObject(
    id: string,
    common: ioBroker.StateCommon,
    native: Record<string, unknown> = {},
  ): Promise<void> {
    if (this.createdIds.has(id)) {
      return;
    }
    // DP-retrofit: extendObject (not setObjectNotExists) on first touch so a changed
    // `common` (roles, names, descriptions) reaches states that already exist on an
    // upgraded install. Runs once per state per restart (createdIds-gated).
    //
    // v0.14.0: WITHOUT `preserve: { common: ["name"] }`. These names belong to the
    // adapter (translated via `admin/i18n`) or to the Hub (sensor/container/GPU
    // names) — never to the user. Preserving them froze every existing tree on the
    // text it was first created with, so a corrected translation reached fresh
    // installs only, invisible to every gate. The price is that a rename a user
    // typed into the admin is overwritten on the next start (krobi 2026-09-03).
    //
    // Deliberately every restart, NOT gated behind a one-shot schema-version marker.
    // A marker would set "done" after the first successful poll — but a system that is
    // `down`/`paused` at that moment never has its pre-existing states touched, so its
    // old role would be frozen forever. The every-restart extendObject is idempotent,
    // self-healing and only a startup cost. Don't "optimize" it into that regression.
    const stale = this.staleUnitObjects.get(id);
    if (stale && common.unit === undefined) {
      // The stored object carries a `unit: ""` placeholder the current common does not
      // — a merge cannot drop a key (see `staleUnitObjects`), so this one write replaces
      // the object, keeping everything else the store holds (`custom`, `acl`, …).
      // `setForeignObject` with the full id and without a callback (it returns the promise)
      // is the fleet form for exactly this (a state object losing a key); `setObject` and the
      // `…Async` twins are on the checker's deprecated list.
      this.staleUnitObjects.delete(id);
      const kept = { ...stale.common };
      delete kept.unit;
      await this.adapter.setForeignObject(`${this.adapter.namespace}.${id}`, {
        ...stale,
        type: "state",
        common: { ...kept, ...common },
        native: { ...stale.native, ...native },
      });
    } else {
      await this.adapter.extendObject(id, { type: "state", common, native });
    }
    this.createdIds.add(id);
    this.noteStateCreated(id);
  }

  private async createAndSetState(
    id: string,
    common: ioBroker.StateCommon,
    value: ioBroker.StateValue,
    native: Record<string, unknown> = {},
  ): Promise<void> {
    await this.ensureStateObject(id, common, native);
    await this.adapter.setStateChangedAsync(id, { val: value, ack: true });
  }

  // -------------------------------------------------------------------------
  // State common factories
  // -------------------------------------------------------------------------

  /**
   * N1: strip the adapter namespace prefix (`beszel.0.`) from a full object id.
   *
   * @param id Full object id.
   */
  private stripNamespace(id: string): string {
    return id.slice(this.adapter.namespace.length + 1);
  }
}
