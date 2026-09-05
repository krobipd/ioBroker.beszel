"use strict";
// Generates the adapter's complete object inventory from fixtures and proves that
// an update reaches every object of an existing installation.
//
// Suite 1 "object inventory": start the adapter in the throwaway js-controller against
//   a fake Beszel hub (test/fixtures/inventory/hub.json — a fully equipped Linux system
//   with every metric group Beszel 0.18.8 can deliver, plus a system that is down),
//   every metric toggle on, then dump every beszel.0.* object to
//   test/objects.inventory.json in the ioBroker object-structure bot's format.
// Suite 2 "upgrade from the previous release" (only when INVENTORY_PREVIOUS is set —
//   pre-release.py exports the last tag's inventory): seed the previous objects BEFORE
//   start, start, feed, then assert that every object carries the current
//   name/desc/role/type/unit and that removed objects are gone.
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

/** PocketBase list envelope around a fixture collection. */
function list(items) {
  return JSON.stringify({ page: 1, perPage: 200, totalItems: items.length, totalPages: 1, items });
}

/**
 * A fake Beszel hub (PocketBase REST) on localhost that serves the fixture collections.
 * The adapter is device/API-driven: every object it can create comes from these records.
 */
function startFakeHub() {
  const server = http.createServer((req, res) => {
    const url = req.url || "";
    const reply = (status, body) => {
      res.writeHead(status, { "Content-Type": "application/json" });
      res.end(body);
    };
    req.on("data", () => undefined);
    req.on("end", () => {
      if (url.includes("/api/collections/users/auth-with-password")) {
        reply(
          200,
          JSON.stringify({ token: "inventory-token", record: { id: "user01", email: "inventory@localhost" } }),
        );
      } else if (url.includes("/api/collections/systems/records")) {
        reply(200, list(FIXTURE.systems));
      } else if (url.includes("/api/collections/system_stats/records")) {
        reply(200, list(FIXTURE.system_stats));
      } else if (url.includes("/api/collections/system_details/records")) {
        reply(200, list(FIXTURE.system_details));
      } else if (url.includes("/api/collections/containers/records")) {
        reply(200, list(FIXTURE.containers));
      } else {
        reply(404, JSON.stringify({ message: "not found" }));
      }
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
    pollInterval: 60,
    requestTimeout: 15,
  };
}

async function countObjects(harness) {
  const rows = await harness.objects.getObjectList({ startkey: NS, endkey: `${NS}香` });
  return rows.rows.length;
}

/**
 * Adapter-specific: the first poll runs inside onReady; wait until the object tree
 * has settled (same count for three consecutive seconds) instead of guessing a delay.
 *
 * @param {import("@iobroker/testing").TestHarness} harness
 */
async function feedFixtures(harness) {
  let last = -1;
  let stable = 0;
  for (let i = 0; i < 90; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const n = await countObjects(harness);
    stable = n === last ? stable + 1 : 0;
    last = n;
    if (n > 0 && stable >= 3) return;
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
              if (JSON.stringify(got.common?.[f]) !== JSON.stringify(obj.common?.[f])) {
                stale.push(`${id}: ${f} still ${JSON.stringify(got.common?.[f])}`);
              }
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
  },
});
