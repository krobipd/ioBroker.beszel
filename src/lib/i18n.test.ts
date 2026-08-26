import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@iobroker/adapter-core", () => ({
  I18n: {
    getTranslatedObject: vi.fn((key: string) => ({ en: key, de: `${key}_de` })),
  },
}));

import { tName } from "./i18n";
import { buildMetricDefs, CHANNEL_NAME_KEY } from "./metric-registry";

describe("tName", () => {
  it("delegates to I18n.getTranslatedObject", () => {
    const result = tName("channelInfo");
    expect(result).toEqual({ en: "channelInfo", de: "channelInfo_de" });
  });
});

describe("i18n completeness", () => {
  const i18nDir = join(__dirname, "../../admin/i18n");
  const files = readdirSync(i18nDir).filter(f => f.endsWith(".json"));
  const keysets = files.map(f => ({
    lang: f.replace(".json", ""),
    keys: Object.keys(JSON.parse(readFileSync(join(i18nDir, f), "utf8"))),
  }));
  const enKeys = keysets.find(k => k.lang === "en")!.keys;

  it("all 11 languages present", () => {
    expect(files).toHaveLength(11);
  });

  it("all languages have identical keysets", () => {
    // L7: compare as sorted sets — key PRESENCE matters, not order. A translation
    // tool re-sorting a complete file must not fail this (it used to, via toEqual).
    const enSorted = [...enKeys].sort();
    for (const { lang, keys } of keysets) {
      expect([...keys].sort(), `${lang} keyset mismatch`).toEqual(enSorted);
    }
  });

  it("every metric name key in the registry exists in en.json", () => {
    // Replaces a hand-picked six-key spot check: a typo in any of the ~50
    // `nameKey`s used to reach the state tree as an untranslated key, and only
    // the two metrics that happen to be name-asserted elsewhere would have
    // caught it (audit 2026-08-22).
    const missing = buildMetricDefs()
      .map(d => d.nameKey)
      .filter(k => !enKeys.includes(k));
    expect(missing, `metric nameKeys missing from en.json: ${missing.join(", ")}`).toEqual([]);
  });

  it("every channel name key exists in en.json", () => {
    const missing = Object.values(CHANNEL_NAME_KEY).filter(k => !enKeys.includes(k));
    expect(missing, `channel keys missing from en.json: ${missing.join(", ")}`).toEqual([]);
  });

  it("every label/help/text key of the admin config exists in en.json", () => {
    // v0.11.0: a new metric toggle needs a header, a label and a help text. When
    // one is forgotten, the admin page shows the raw key instead of a caption —
    // invisible in tsc/lint and easy to miss by eye across 11 languages.
    const jsonConfig = JSON.parse(readFileSync(join(__dirname, "../../admin/jsonConfig.json"), "utf8")) as unknown;
    const used = new Set<string>();
    const walk = (node: unknown): void => {
      if (Array.isArray(node)) {
        node.forEach(walk);
        return;
      }
      if (!node || typeof node !== "object") {
        return;
      }
      for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
        if (["label", "help", "text"].includes(key) && typeof value === "string") {
          used.add(value);
        } else {
          walk(value);
        }
      }
    };
    walk(jsonConfig);
    // Only keys that LOOK like i18n keys — plain sentences are used verbatim.
    const missing = [...used].filter(k => /^[a-z][A-Za-z0-9_]*$/.test(k) && !enKeys.includes(k));
    expect(missing, `jsonConfig keys missing from en.json: ${missing.join(", ")}`).toEqual([]);
  });

  it("the hand-written state keys used outside the registry exist too", () => {
    // These are passed to tName() directly in state-manager (not via a MetricDef).
    const inlineKeys = [
      "online",
      "status",
      "containerHealth",
      "containerImage",
      "containerMemory",
      "containerNetwork",
      "cpuUsage",
      "diskPercent",
      "diskUsed",
      "diskTotal",
      "readSpeed",
      "writeSpeed",
      "gpuUsage",
      "gpuMemoryUsed",
      "gpuMemoryTotal",
      "gpuPower",
      "gpuPowerPackage",
      "ifaceUp",
      "ifaceDown",
      "ifaceTotalUp",
      "ifaceTotalDown",
      "systemsTotal",
      "systemsOnline",
      "systemsAllUp",
    ];
    const missing = inlineKeys.filter(k => !enKeys.includes(k));
    expect(missing, `inline keys missing from en.json: ${missing.join(", ")}`).toEqual([]);
  });
});
