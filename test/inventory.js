"use strict";
// Generates the adapter's complete object inventory from fixtures and proves that
// an update reaches every object of an existing installation.
//
// Suite 1 "object inventory": start the adapter in the throwaway js-controller against
//   a fake Beszel hub (test/fixtures/inventory/hub.json, in the wire form of a Beszel 0.20.0
//   Hub — json/v2: omitempty numbers and bools arrive as 0/false, omitzero fields are left
//   out). It carries a fully equipped Linux system with every metric group, a bare VM in the
//   encoding of a Hub before 0.19.0, macOS, Windows, a Podman host with btrfs and an iGPU,
//   systems that are down, paused, pending, up without a minute record and on an old agent,
//   and network monitors. Every metric toggle on, two polls (members leave after two), then
//   every beszel.0.* object goes to test/objects.inventory.json in the ioBroker
//   object-structure bot's format. The four oldest systems keep their Hub ids, so the upgrade
//   suite below is an update of the same Hub, not a different Hub taking over the names.
// Suite 2 "upgrade from the previous release" (only when INVENTORY_PREVIOUS is set —
//   pre-release.py exports the last tag's inventory): seed the previous objects BEFORE
//   start, start, feed, then assert that every object carries the current
//   name/desc/role/type/unit and that removed objects are gone.
// Suite 3 "an older Hub": the collections Beszel 0.19.0 and 0.20.0 added answer 404; the
//   adapter keeps running and creates none of their objects.
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const assert = require("node:assert");
const { tests } = require("@iobroker/testing");

const ADAPTER_DIR = path.join(__dirname, "..");
const ADAPTER = require(path.join(ADAPTER_DIR, "io-package.json")).common.name;
const NS = `${ADAPTER}.0.`;
const INVENTORY = path.join(__dirname, "objects.inventory.json");
const FIXTURE = JSON.parse(fs.readFileSync(path.join(__dirname, "fixtures", "inventory", "hub.json"), "utf8"));
const VOLATILE = ["ts", "from", "user", "acl"];
const COMPARED = ["name", "desc", "role", "type", "unit"];
// Key order carries no meaning in an ioBroker object: extendObject keeps the key order an existing
// object already has, while adapter-core's I18n.getTranslatedObject builds its own — the same eleven
// texts in another order are the same name. Arrays keep their order.
const canonical = v =>
  JSON.stringify(v, (_k, x) =>
    x && typeof x === "object" && !Array.isArray(x)
      ? Object.fromEntries(
          Object.keys(x)
            .sort()
            .map(k => [k, x[k]]),
        )
      : x,
  );

/** The filters the adapter sends; anything else is a 400, so a new query cannot pass unseen. */
const FILTERS = { "type='1m'": item => item.type === "1m" };
/** PocketBase's own cap on `perPage` (tools/search/provider.go). */
const MAX_PER_PAGE = 1000;

/** PocketBase's ordering for a `sort` expression: comma-separated fields, `-` for descending. */
function sortItems(items, sort) {
  const keys = sort
    .split(",")
    .filter(Boolean)
    .map(k => (k.startsWith("-") ? { field: k.slice(1), dir: -1 } : { field: k, dir: 1 }));
  return [...items].sort((a, b) => {
    for (const { field, dir } of keys) {
      const x = a[field];
      const y = b[field];
      if (x === y) continue;
      return (x < y ? -1 : 1) * dir;
    }
    return 0;
  });
}

/**
 * A PocketBase list answer: filter, sort and page the fixture collection the way the Hub does.
 *
 * @param {object[]} all the fixture collection
 * @param {URLSearchParams} query the request's query
 * @returns {{status: number, body: string}} the reply
 */
function list(all, query) {
  let items = all;
  const filter = query.get("filter");
  if (filter !== null) {
    if (!FILTERS[filter]) {
      return { status: 400, body: JSON.stringify({ status: 400, message: `fake hub: unknown filter ${filter}` }) };
    }
    items = items.filter(FILTERS[filter]);
  }
  items = sortItems(items, query.get("sort") || "");
  const perPage = Math.min(Number(query.get("perPage")) || 30, MAX_PER_PAGE);
  const page = Number(query.get("page")) || 1;
  const totalPages = Math.ceil(items.length / perPage);
  const slice = items.slice((page - 1) * perPage, page * perPage);
  return { status: 200, body: JSON.stringify({ items: slice, page, perPage, totalItems: items.length, totalPages }) };
}

/**
 * A fake Beszel hub (PocketBase REST) on localhost that serves the fixture collections.
 * The adapter is device/API-driven: every object it can create comes from these records.
 *
 * @param {string[]} [missing] collections this Hub does not have (an older Beszel): 404
 */
function startFakeHub(missing = []) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://fake-hub");
    const reply = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(body);
    };
    req.on("data", () => undefined);
    req.on("end", () => {
      if (url.pathname === "/api/collections/users/auth-with-password" && req.method === "POST") {
        reply(
          200,
          JSON.stringify({ token: "inventory-token", record: { id: "u0inventory0001", email: "inventory@localhost" } }),
        );
        return;
      }
      const m = /^\/api\/collections\/([a-z_]+)\/records$/.exec(url.pathname);
      const collection = m && m[1] !== "users" && !missing.includes(m[1]) ? FIXTURE[m[1]] : undefined;
      if (!collection) {
        reply(404, JSON.stringify({ data: {}, message: "Missing collection context.", status: 404 }));
        return;
      }
      const { status, body } = list(collection, url.searchParams);
      reply(status, body);
    });
  });
  return new Promise(resolve => {
    server.listen(0, "127.0.0.1", () => resolve({ server, port: server.address().port }));
  });
}

/** Adapter-specific config the fixtures need: the fake hub and every metric toggle on. */
function fixtureNative(port) {
  const native = require(path.join(ADAPTER_DIR, "io-package.json")).native;
  const all = {};
  for (const key of Object.keys(native)) {
    if (key.startsWith("metrics_")) all[key] = true;
  }
  return {
    ...all,
    url: `http://127.0.0.1:${port}`,
    username: "inventory",
    password: "inventory",
    // The shortest interval: a member that is gone leaves after two polls (Design 16), and
    // the upgrade suite has to see that second poll.
    pollInterval: 10,
    requestTimeout: 15,
  };
}

async function countObjects(harness) {
  const rows = await harness.objects.getObjectList({ startkey: NS, endkey: `${NS}香` });
  return rows.rows.length;
}

/**
 * Adapter-specific: the first poll runs inside onReady; wait until the object tree has
 * settled over more than one poll interval (same count for 15 consecutive seconds at a
 * 10 s interval) — a member missing from the fixture leaves only with the second poll.
 *
 * @param {import("@iobroker/testing").TestHarness} harness
 */
async function feedFixtures(harness) {
  let last = -1;
  let stable = 0;
  for (let i = 0; i < 150; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const n = await countObjects(harness);
    stable = n === last ? stable + 1 : 0;
    last = n;
    if (n > 0 && stable >= 15) return;
  }
  throw new Error(`object tree did not settle (last count ${last})`);
}

async function dumpObjects(harness) {
  // The range starts at "<adapter>.0." — the instance root object itself is not part of the tree.
  const rows = await harness.objects.getObjectList({ startkey: NS, endkey: `${NS}香` });
  const out = {};
  for (const row of rows.rows.sort((a, b) => a.id.localeCompare(b.id))) {
    const obj = { ...row.value };
    for (const key of VOLATILE) delete obj[key];
    out[row.id] = obj;
  }
  return out;
}

tests.integration(ADAPTER_DIR, {
  defineAdditionalTests({ suite }) {
    suite("object inventory", getHarness => {
      let harness;
      let hub;
      before(async function () {
        this.timeout(180000);
        harness = getHarness();
        hub = await startFakeHub();
        await harness.changeAdapterConfig(ADAPTER, { native: fixtureNative(hub.port) });
        await harness.startAdapterAndWait();
        await feedFixtures(harness);
      });
      after(async () => {
        if (hub) await new Promise(r => hub.server.close(() => r()));
      });

      it("writes test/objects.inventory.json", async function () {
        this.timeout(30000);
        const objects = await dumpObjects(harness);
        assert.ok(Object.keys(objects).length > 0, "no objects created — fixtures did not reach the adapter");
        fs.writeFileSync(INVENTORY, `${JSON.stringify(objects, null, 2)}\n`);
      });
    });

    const previousFile = process.env.INVENTORY_PREVIOUS;
    if (previousFile && fs.existsSync(previousFile)) {
      suite("upgrade from the previous release", getHarness => {
        let harness;
        let hub;
        const previous = JSON.parse(fs.readFileSync(previousFile, "utf8"));
        before(async function () {
          this.timeout(180000);
          harness = getHarness();
          // The harness registers its own before() (fresh DB) ahead of this one,
          // so the seed survives and the adapter starts on top of the OLD objects.
          for (const [id, obj] of Object.entries(previous)) {
            await harness.objects.setObjectAsync(id, obj);
          }
          hub = await startFakeHub();
          await harness.changeAdapterConfig(ADAPTER, { native: fixtureNative(hub.port) });
          await harness.startAdapterAndWait();
          await feedFixtures(harness);
        });
        after(async () => {
          if (hub) await new Promise(r => hub.server.close(() => r()));
        });

        it("every current object carries the current texts and roles", async function () {
          this.timeout(30000);
          const current = JSON.parse(fs.readFileSync(INVENTORY, "utf8"));
          const live = await dumpObjects(harness);
          const stale = [];
          for (const [id, obj] of Object.entries(current)) {
            const got = live[id];
            if (!got) {
              stale.push(`${id}: missing after upgrade`);
              continue;
            }
            for (const f of COMPARED) {
              if (canonical(got.common?.[f]) !== canonical(obj.common?.[f])) {
                stale.push(`${id}: ${f} still ${JSON.stringify(got.common?.[f])}`);
              }
            }
            // The KIND of the object (state/channel/device/folder/meta) lives one level
            // ABOVE `common`; the `type` in COMPARED is the VALUE type (string/number/
            // boolean) — something entirely different that merely shares the name. Without
            // this comparison a type migration that never reaches an existing installation
            // stays green.
            if (got.type !== obj.type) {
              stale.push(`${id}: type still ${JSON.stringify(got.type)}, want ${JSON.stringify(obj.type)}`);
            }
          }
          assert.deepStrictEqual(stale, [], `objects an update did not reach:\n${stale.join("\n")}`);
        });

        it("objects the release removed are gone (no leftovers)", async function () {
          this.timeout(30000);
          const current = JSON.parse(fs.readFileSync(INVENTORY, "utf8"));
          const live = await dumpObjects(harness);
          const leftovers = Object.keys(previous).filter(id => !(id in current) && id in live);
          assert.deepStrictEqual(leftovers, [], `leftover objects:\n${leftovers.join("\n")}`);
        });
      });
    }

    suite("an older Hub", getHarness => {
      // Beszel before 0.19.0 has no zfs_pools, before 0.20.0 no network monitors.
      const MISSING = ["zfs_pools", "network_monitors", "network_monitor_stats"];
      let harness;
      let hub;
      before(async function () {
        this.timeout(180000);
        harness = getHarness();
        hub = await startFakeHub(MISSING);
        await harness.changeAdapterConfig(ADAPTER, { native: fixtureNative(hub.port) });
        await harness.startAdapterAndWait();
        await feedFixtures(harness);
      });
      after(async () => {
        if (hub) await new Promise(r => hub.server.close(() => r()));
      });

      it("keeps running and creates no object of a collection the Hub lacks", async function () {
        this.timeout(30000);
        const live = await dumpObjects(harness);
        const state = await harness.states.getStateAsync(`${NS}info.connection`);
        assert.strictEqual(state && state.val, true, "the adapter lost the connection over a missing collection");
        const foreign = Object.keys(live).filter(id =>
          /\.monitors(\.|$)|\.zfs\.[^.]+\.(vdevs|datasets|scrub_)/.test(id),
        );
        assert.deepStrictEqual(foreign, [], `objects from collections the Hub lacks:\n${foreign.join("\n")}`);
        assert.ok(
          Object.keys(live).some(id => id.endsWith(".systems.homelab_server.cpu.usage")),
          "the rest of the tree is missing",
        );
      });
    });
  },
});
