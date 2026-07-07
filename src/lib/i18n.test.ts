import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@iobroker/adapter-core", () => ({
  I18n: {
    getTranslatedObject: vi.fn((key: string) => ({ en: key, de: `${key}_de` })),
  },
}));

import { tName } from "./i18n";

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

  it("state name keys are present", () => {
    expect(enKeys).toContain("channelInfo");
    expect(enKeys).toContain("cpuUsage");
    expect(enKeys).toContain("memoryPercent");
    expect(enKeys).toContain("diskPercent");
    expect(enKeys).toContain("networkSent");
    expect(enKeys).toContain("containerHealth");
  });
});
