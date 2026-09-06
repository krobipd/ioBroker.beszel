import type * as utils from "@iobroker/adapter-core";
import { errText, sanitizeDisplayName, sanitizeForLog } from "./coerce";
import { tDesc, tName } from "./i18n";
import {
  buildMetricDefs,
  commonFor,
  containerHealthLabel,
  percentCommon,
  numCommon,
  textCommon,
  boolCommon,
  clampPercent,
  channelName,
  isChannelKey,
  leafCommon,
  bytesToMib,
  bytesToGib,
  usedPercent,
  DYNAMIC_CHANNEL_TOGGLES,
  DYNAMIC_LEAF_PATTERNS,
  DYNAMIC_SUBCHANNEL_TOGGLES,
  METRIC_DEPENDENCIES,
  systemStatusStates,
  SYSTEM_STATUS_UNKNOWN,
} from "./metric-registry";
import type { LocalizedName, MetricDef } from "./metric-registry";
import type { AdapterConfig, BeszelContainer, BeszelSystem, SystemStats } from "./types";

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
 * Flat state ids used before 0.3.0, when every metric lived directly under the
 * system device instead of a channel. Swept once from the startup snapshot.
 */
const LEGACY_FLAT_STATE_IDS = [
  "online",
  "status",
  "uptime",
  "uptime_text",
  "agent_version",
  "services_total",
  "services_failed",
  "cpu_usage",
  "load_avg_1m",
  "load_avg_5m",
  "load_avg_15m",
  "cpu_user",
  "cpu_system",
  "cpu_iowait",
  "cpu_steal",
  "cpu_idle",
  "memory_percent",
  "memory_used",
  "memory_total",
  "buffers",
  "zfs_arc",
  "swap_used",
  "swap_total",
  "disk_percent",
  "disk_used",
  "disk_total",
  "disk_read",
  "disk_write",
  "network_sent",
  "network_recv",
  "temperature",
  "battery_percent",
  "battery_charging",
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
   * v0.7.2: last-written device-object signature per sysId (`id|host|name`).
   * `updateSystem` used to extendObject the device on EVERY poll — one write
   * + objectChange event per system per minute for data that practically
   * never changes. Now the write happens only when the signature differs.
   */
  private readonly deviceWritten = new Map<string, string>();

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
  /** Whether {@link snapshotExistingStates} has run — the legacy sweep depends on it. */
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
    // same round-trip, which is what lets the pre-0.3.0 sweep run without probing
    // ids one by one (and made the `info.legacyMigrated` marker obsolete).
    const list = await this.adapter.getObjectListAsync({
      startkey: `${this.adapter.namespace}.`,
      endkey: `${this.adapter.namespace}.\uFFFF`,
    });
    for (const row of list?.rows ?? []) {
      const id = this.stripNamespace(row.id);
      if (row.value?.type === "state") {
        this.knownStateIds.add(id);
      } else if (row.value?.type === "channel") {
        this.knownChannelIds.add(id);
      } else if (row.value?.type === "device") {
        this.knownDeviceIds.add(id);
      }
    }
    this.snapshotTaken = true;
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
   * @param set One of the bookkeeping sets (states / channels / devices).
   * @param prefix Object id prefix, namespace-relative.
   */
  private static idsUnder(set: ReadonlySet<string>, prefix: string): string[] {
    const dot = `${prefix}.`;
    const out: string[] = [];
    for (const id of set) {
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
   * v0.4.3 (SM5): Sanitize + suffix with a stable hash of `uniqueKey` so two
   * records with the same post-sanitize name don't overwrite each other.
   *
   * @param name Raw display name to sanitize.
   * @param uniqueKey Stable identifier (e.g. PocketBase record id) used to
   *   derive the suffix.
   */
  private sanitizeWithSuffix(name: unknown, uniqueKey: string): string {
    const base = this.sanitize(name);
    if (!base) {
      return "";
    }
    return `${base}__${StateManager.shortHash(uniqueKey)}`;
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
   * SEC-6: resolve one dynamic-group child id segment, disambiguating collisions
   * the same way `prepareForPoll` does for systems. The first member with a given
   * sanitized base keeps it; a later member that sanitizes to the SAME base (e.g.
   * `/mnt/data` and `/mnt-data` both → `mnt_data`, or two names sharing the first
   * 50 chars) gets a stable `__<hash>` suffix so they never overwrite each other's
   * states. Returns "" when the name is unusable (caller skips it).
   *
   * @param rawName Raw member name from the Hub.
   * @param stableKey Stable unique key for the suffix (record id, or the raw name).
   * @param seen Sanitized bases already used in this group's pass (mutated).
   */
  private resolveChildId(rawName: string, stableKey: string, seen: Set<string>): string {
    const base = this.sanitize(rawName);
    if (!base) {
      return "";
    }
    if (seen.has(base)) {
      return this.sanitizeWithSuffix(rawName, stableKey);
    }
    seen.add(base);
    return base;
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
    const sorted = [...systems].sort((a, b) => a.id.localeCompare(b.id));
    const seen = new Set<string>();
    const collisions = new Map<string, BeszelSystem[]>();
    for (const sys of sorted) {
      const safe = this.sanitize(sys.name);
      if (!safe) {
        this.resolvedSafeNames.set(sys.id, "");
        continue;
      }
      if (seen.has(safe)) {
        const arr = collisions.get(safe) ?? [];
        arr.push(sys);
        collisions.set(safe, arr);
        this.resolvedSafeNames.set(sys.id, this.sanitizeWithSuffix(sys.name, sys.id));
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
        `Multiple systems sanitize to '${safe}' (${names}) — adding hash suffix to disambiguate. Consider renaming on the Hub.`,
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
    return cached !== undefined ? cached : this.sanitize(system.name);
  }

  /**
   * State prefixes (`systems.<safeName>`) of the systems resolved for the current poll.
   * Synchronous and in-memory on purpose: `onUnload` must not await an object view.
   * Empty until the first poll got far enough to call {@link prepareForPoll}.
   */
  public knownSystemIds(): string[] {
    const out: string[] = [];
    for (const safe of this.resolvedSafeNames.values()) {
      if (safe) {
        out.push(`systems.${safe}`);
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
        await this.adapter.extendObject(id, {
          type: "state",
          common: { states: systemStatusStates() },
          native: {},
        });
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
   */
  private async applyMetrics(
    sysId: string,
    system: BeszelSystem,
    stats: SystemStats | undefined,
    config: AdapterConfig,
  ): Promise<void> {
    // Two separate questions per metric, and they must not be answered together:
    // does its OBJECT belong in the tree, and is there a VALUE to write right now.
    // Tying them together is what left a system that is currently down with the old
    // names and no descriptions — its metrics were skipped whole, so the
    // every-restart retrofit never reached them (measured on the live tree, v0.14.1).
    const touched: { def: MetricDef; writeValue: boolean }[] = [];
    for (const d of this.metricDefs()) {
      if (!config[d.toggle]) {
        continue;
      }
      if (!d.available || d.available(stats, system)) {
        touched.push({ def: d, writeValue: true });
        continue;
      }
      // Not available. A state that was never created stays uncreated — an older Hub
      // must not gain empty datapoints.
      const id = `${sysId}.${d.id}`;
      if (!this.createdIds.has(id) && !this.knownStateIds.has(id)) {
        continue;
      }
      // It exists, so its object gets refreshed either way. Only the VALUE differs,
      // and the two reasons for "not available" need opposite handling:
      //
      // No stats at all (system down / paused, or its newest record is older than the
      // stats walk) — keep the last reading. The dynamic groups freeze in exactly this
      // case too, and "every ioBroker adapter leaves the last values standing" is the
      // line krobi confirmed.
      //
      // H2b: the record IS there but one field went absent (`dios`/`cpub` are
      // omitzero/omitempty on the wire, so a fully idle disk drops them) — then the
      // state must be reset to null instead of freezing the last busy value.
      // `knownStateIds` alongside `createdIds`, because the latter is empty in a fresh
      // process: without it the reset silently stopped working after every restart.
      touched.push({ def: d, writeValue: !!stats });
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
   * Update all states for a single system.
   *
   * @param system Beszel system record
   * @param stats Latest stats for this system, or undefined if unavailable
   * @param containers Container records belonging to this system (pre-filtered by the poll)
   * @param rawConfig Adapter configuration (detail toggles are gated on their category base via effectiveConfig)
   * @param containersAvailable F1: whether the container fetch succeeded this poll. `false`
   *   (403 / timeout) means "unknown" — the container tree is left untouched (frozen), never
   *   pruned. Defaults to `true` so unit tests exercising other metrics need not pass it.
   */
  public async updateSystem(
    system: BeszelSystem,
    stats: SystemStats | undefined,
    containers: BeszelContainer[],
    rawConfig: AdapterConfig,
    containersAvailable = true,
  ): Promise<void> {
    // Detail toggles inherit their category's base toggle (off category → off
    // detail). Applied once here so applyMetrics + updateDynamicStats + the
    // container path all see the same effective config.
    const config = this.effectiveConfig(rawConfig);
    const safeName = this.resolvedSafeName(system);
    if (safeName.length === 0) {
      this.adapter.log.warn(
        `Skipping system with unusable name: ${sanitizeForLog(typeof system.name === "string" ? system.name : JSON.stringify(system.name))}`,
      );
      return;
    }
    const sysId = `systems.${safeName}`;
    // v0.4.4 (G1): trace the state-tree entry (after safeName resolution but
    // before any extendObjectAsync). Shows the name → safeName mapping —
    // useful when collisions cause SM5 suffix-disambiguation.
    this.adapter.log.debug(`updateSystem state-tree: '${sanitizeForLog(system.name)}' → safeName='${safeName}'`);

    // Create/update device object with online indicator. v0.7.2: only write
    // when id/host/name actually changed — extendObject on every poll meant
    // one object write + objectChange event per system per minute for data
    // that practically never changes.
    const deviceSig = `${system.id} ${system.host} ${system.name}`;
    if (this.deviceWritten.get(sysId) !== deviceSig) {
      await this.adapter.extendObject(
        sysId,
        {
          type: "device",
          common: {
            name: system.name,
            statusStates: {
              onlineId: `${this.adapter.namespace}.${sysId}.info.online`,
            },
          },
          native: { id: system.id, host: system.host },
        },
        // The only object that KEEPS `preserve`. Its name is the system name from
        // the Hub, and renaming a system there produces a different sanitized id —
        // i.e. a new device object anyway. So preserving here can only ever protect
        // a rename the user typed in the admin, and never blocks anything the
        // adapter itself ships (unlike the channels/states below, v0.14.0).
        { preserve: { common: ["name"] } },
      );
      this.deviceWritten.set(sysId, deviceSig);
      // v0.16.0: the device bookkeeping mirrors the tree, so a system the Hub just
      // added has to join it — `getExistingSystemNames` reads this set now.
      this.knownDeviceIds.add(sysId);
    }

    // Info channel (always created)
    await this.ensureChannel(`${sysId}.info`, channelName("info"));

    // Always: online + status
    await this.createAndSetState(
      `${sysId}.info.online`,
      boolCommon(tName("online"), "indicator.reachable"),
      system.status === "up",
    );
    await this.createAndSetState(
      `${sysId}.info.status`,
      {
        ...textCommon(tName("status"), "info.status", tDesc("descStatus")),
        states: systemStatusStates(),
      },
      system.status,
    );

    // All toggled scalar metrics (info + cpu + memory + disk + network +
    // temperature + battery) are driven by the registry (K1) — single source
    // of truth shared with cleanupMetrics. loadAvg's old with-/without-stats
    // split is unified inside the registry (stats.la ?? info.la fallback).
    await this.applyMetrics(sysId, system, stats, config);

    // Dynamic per-item groups (per-sensor temps, per-GPU, per-filesystem)
    // need live stats and fan out to N children — kept in their own handler.
    if (stats) {
      await this.updateDynamicStats(sysId, stats, config);
    } else {
      // No reading: the groups cannot be rebuilt, but their existing datapoints still
      // have to receive corrected names and descriptions.
      await this.refreshDynamicObjects(sysId);
    }

    // Containers. F1: only touch the container tree when the fetch actually
    // succeeded this poll. A failed fetch (403 / timeout) arrives as
    // containersAvailable=false — skip entirely so existing states freeze (what
    // the changelog promises with "skipped") instead of the prune deleting them.
    // A SUCCESSFUL empty result (containersAvailable=true, containers=[]) still
    // prunes, with the H2 two-poll debounce.
    if (config.metrics_containers && containersAvailable) {
      await this.updateContainers(sysId, containers);
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
    // v0.4.3 (SM1): stale-system removals in parallel.
    await Promise.all(
      stale.map(async name => {
        this.adapter.log.debug(`Removing stale system: systems.${name}`);
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
    const exact = prefix;
    const dot = `${prefix}.`;
    // v0.4.3 (SM4): snapshot to array first — defensive against any future
    // engine that diverges from spec on Set.delete during for-of iteration.
    for (const id of [...this.createdIds]) {
      if (id === exact || id.startsWith(dot)) {
        this.createdIds.delete(id);
      }
    }
    for (const id of StateManager.idsUnder(this.knownChannelIds, prefix)) {
      this.knownChannelIds.delete(id);
    }
    for (const id of StateManager.idsUnder(this.knownDeviceIds, prefix)) {
      this.knownDeviceIds.delete(id);
    }
    // v0.7.2: the dynamic-group and device-signature caches must follow the
    // same lifecycle — a removed system that is re-added later must go
    // through the full reconcile/write path again.
    for (const key of [...this.dynamicChildren.keys()]) {
      if (key === exact || key.startsWith(dot)) {
        this.dynamicChildren.delete(key);
      }
    }
    for (const key of [...this.deviceWritten.keys()]) {
      if (key === exact || key.startsWith(dot)) {
        this.deviceWritten.delete(key);
      }
    }
    for (const key of [...this.lastGroupEmpty.keys()]) {
      if (key === exact || key.startsWith(dot)) {
        this.lastGroupEmpty.delete(key);
      }
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
   * Remove legacy flat state paths from pre-0.3.0 installations.
   * Must be called once during onReady before the first poll.
   *
   * v0.14.0: decided entirely from the startup snapshot — no probing of dozens of
   * legacy ids per system, and therefore no `info.legacyMigrated` marker any more.
   * The marker only ever existed to skip that probing; since v0.11.0 the snapshot
   * reads every existing object once anyway (and runs BEFORE this), so the whole
   * sweep is free and the marker datapoint was pure bookkeeping in the user's tree.
   * An install that still carries it gets it removed here.
   *
   * F3: `existingNames` may be passed in when the caller (onReady) has already
   * enumerated the system devices — then this method reuses that list instead of
   * running the same object view a second time. Omitted (e.g. in unit tests) it
   * enumerates on its own.
   *
   * @param existingNames Pre-enumerated system device names, or undefined to enumerate here.
   */
  public async migrateLegacyStates(existingNames?: string[]): Promise<void> {
    // The sweep reads the snapshot, so it has to exist. onReady always takes it
    // first; a direct caller (unit test) gets it taken here. Idempotent.
    if (!this.snapshotTaken) {
      await this.snapshotExistingStates();
    }
    await this.removeLegacyMigrationMarker();

    const names = existingNames ?? this.getExistingSystemNames();
    if (names.length === 0) {
      return;
    }
    // v0.4.4 (G4): trace the scan-start so the migration-summary at the end
    // is anchored. If no states need migration, only this debug line fires;
    // the existing info-summary stays silent.
    this.adapter.log.debug(`migrateLegacyStates: scanning ${names.length} existing system(s) for legacy flat states`);

    // v0.4.3 (SM3): per-system migration in parallel. Each system only touches
    // the ids the snapshot actually lists, so there is no probing left to do.
    const counts = await Promise.all(
      names.map(async name => {
        const sysId = `systems.${name}`;
        let local = 0;
        for (const stateId of LEGACY_FLAT_STATE_IDS) {
          const fullId = `${sysId}.${stateId}`;
          if (!this.knownStateIds.has(fullId)) {
            continue;
          }
          await this.adapter.delObjectAsync(fullId);
          this.createdIds.delete(fullId);
          // Not counted (see the countRemoval=false note below) but dropped
          // from the id set so the bookkeeping stays truthful.
          this.knownStateIds.delete(fullId);
          local++;
        }
        // The one legacy CHANNEL. The snapshot lists channels too, so this needs
        // no object read either.
        const legacyChannel = `${sysId}.temperatures`;
        if (this.knownChannelIds.has(legacyChannel)) {
          // countRemoval=false: the legacy sweep reports its own total below —
          // letting it also feed the datapoint counter would report the same
          // removals twice, in two differently-scoped lines.
          await this.deleteChannelIfExists(legacyChannel, false);
          this.knownChannelIds.delete(legacyChannel);
        }
        return local;
      }),
    );
    const migrated = counts.reduce((a, b) => a + b, 0);

    if (migrated > 0) {
      this.adapter.log.info(`Migration: removed ${migrated} legacy state(s) from flat structure`);
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
    // Group channels the adapter names (temperature.sensors, cpu.cores, containers, …).
    // A channel named by the Hub (gpu.<id>, containers.<name>) has a last segment that is
    // not in the catalog and is skipped — its name never changes through an update.
    for (const id of this.knownChannelIds) {
      if (!id.startsWith(prefix)) {
        continue;
      }
      const last = id.slice(id.lastIndexOf(".") + 1);
      if (isChannelKey(last)) {
        await this.ensureChannel(id, channelName(last));
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
          await this.createAndSetState(
            `${sysId}.gpu.${safeId}.memory_used`,
            leafCommon("gpuMemoryUsed"),
            gpuData.mu ?? null,
          );
          await this.createAndSetState(
            `${sysId}.gpu.${safeId}.memory_total`,
            leafCommon("gpuMemoryTotal"),
            gpuData.mt ?? null,
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
      await this.syncDynamicGroup(
        `${sysId}.zfs`,
        stats.z ? Object.entries(stats.z) : [],
        "channel",
        async () => {
          await this.ensureChannel(`${sysId}.zfs`, channelName("zfs"));
        },
        async (safeId, poolName, pool) => {
          await this.ensureChannel(`${sysId}.zfs.${safeId}`, sanitizeDisplayName(poolName), API_NAMED);
          const total = pool.d ?? null;
          const used = pool.du ?? null;
          await this.createAndSetState(
            `${sysId}.zfs.${safeId}.disk_percent`,
            leafCommon("zfsDiskPercent"),
            usedPercent(total, used),
          );
          await this.createAndSetState(`${sysId}.zfs.${safeId}.disk_used`, leafCommon("zfsDiskUsed"), used);
          await this.createAndSetState(`${sysId}.zfs.${safeId}.disk_total`, leafCommon("zfsDiskTotal"), total);
          await this.createAndSetState(
            `${sysId}.zfs.${safeId}.read_speed`,
            leafCommon("zfsReadSpeed"),
            bytesToMib(pool.rb ?? 0),
          );
          await this.createAndSetState(
            `${sysId}.zfs.${safeId}.write_speed`,
            leafCommon("zfsWriteSpeed"),
            bytesToMib(pool.wb ?? 0),
          );
          await this.createAndSetState(`${sysId}.zfs.${safeId}.health`, leafCommon("zfsHealth"), pool.h ?? null);
        },
      );
    }
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
    const seenContainers = new Set<string>();
    const resolvedIds = new Map<string, string>();
    for (const container of sysContainers) {
      resolvedIds.set(container.id, this.resolveChildId(container.name, container.id, seenContainers));
    }

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
      const cId = resolvedIds.get(container.id) ?? "";
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
      const seen = new Set<string>();
      for (const [rawId, data] of entries) {
        const safeId = this.resolveChildId(rawId, rawId, seen);
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
   * H2: prune a dynamic group's disappeared children, with a drop-to-zero
   * debounce. A NON-empty group prunes immediately (drops members that vanished
   * among the ones still present). An EMPTY group (all members gone) prunes only
   * on the SECOND consecutive empty poll — a single transient empty response
   * must not wipe every state. Used by every dynamic group incl. containers.
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
      await this.pruneDynamicChildren(base, activeIds, childType);
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
   */
  private async pruneDynamicChildren(
    base: string,
    activeIds: Set<string>,
    childType: "channel" | "state",
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
    const stale = [...known].filter(cId => !activeIds.has(cId));
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
    if (stale.length > 0 && activeIds.size === 0 && this.knownChannelIds.has(base)) {
      await this.adapter.delObjectAsync(base);
      this.dropCacheUnder(base);
    }
    this.dynamicChildren.set(base, new Set(activeIds));
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
   * @param countRemoval Whether the removed states feed the datapoint counter.
   *   `false` only for the legacy migration, which reports its own total.
   */
  private async deleteChannelIfExists(id: string, countRemoval = true): Promise<void> {
    if (!this.knownChannelIds.has(id)) {
      return;
    }
    try {
      if (countRemoval) {
        this.noteStatesRemovedUnder(id);
      }
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
    await this.adapter.extendObject(id, { type: "state", common, native });
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
