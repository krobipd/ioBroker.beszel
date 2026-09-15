import type * as fsType from "node:fs";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  deviceIcon,
  FALLBACK_ICON,
  ICON_BY_OS,
  ICON_URI_PREFIX,
  normaliseLineEndings,
  resetIconCache,
} from "./device-icons";

/** Which icon file the mocked `readFileSync` refuses to read (null = none). */
let unreadable: string | null = null;

vi.mock("node:fs", async importOriginal => {
  const actual = await importOriginal<typeof fsType>();
  return {
    ...actual,
    readFileSync: (path: Parameters<typeof actual.readFileSync>[0], ...rest: unknown[]): unknown => {
      if (unreadable && String(path).endsWith(unreadable)) {
        throw new Error("EACCES: permission denied");
      }
      return (actual.readFileSync as (...a: unknown[]) => unknown)(path, ...rest);
    },
  };
});

const ICON_DIR = join(__dirname, "..", "..", "admin", "icons");
const iconFiles = (): string[] => readdirSync(ICON_DIR).filter(f => f.endsWith(".svg"));
const fileBytes = (file: string): string => normaliseLineEndings(readFileSync(join(ICON_DIR, file), "utf8"));
const decode = (uri: string): string => Buffer.from(uri.slice(ICON_URI_PREFIX.length), "base64").toString("utf8");

describe("device icons (v0.18.0)", () => {
  afterEach(() => {
    unreadable = null;
    resetIconCache();
  });

  it("embeds the file itself as an inline data URI, never a path", () => {
    for (const [os, file] of Object.entries(ICON_BY_OS)) {
      const uri = deviceIcon(Number(os));
      expect(uri, file).to.be.a("string");
      expect(uri!.startsWith(ICON_URI_PREFIX), `${file} must be an inline SVG data URI`).to.be.true;
      expect(decode(uri!), `${file}: URI must be the file's bytes`).to.equal(fileBytes(file));
      expect(uri, `${file}: no path in the object`).to.not.include("/icons/");
    }
  });

  it("maps every Beszel OS enum value to its own file", () => {
    expect(ICON_BY_OS).to.deep.equal({ 0: "linux.svg", 1: "macos.svg", 2: "windows.svg", 3: "freebsd.svg" });
    const uris = new Set(Object.keys(ICON_BY_OS).map(os => deviceIcon(Number(os))));
    expect(uris.size, "four different pictograms").to.equal(4);
  });

  it("falls back to the generic server for an unknown OS value and for a system without details", () => {
    const server = `${ICON_URI_PREFIX}${Buffer.from(fileBytes(FALLBACK_ICON)).toString("base64")}`;
    expect(deviceIcon(undefined)).to.equal(server);
    expect(deviceIcon(99)).to.equal(server);
    expect(deviceIcon(-1)).to.equal(server);
  });

  it("does not resolve an inherited property name to an icon", () => {
    // A numeric enum cannot spell "constructor", but the lookup must not rely on that.
    expect(deviceIcon("constructor" as unknown as number)).to.equal(deviceIcon(undefined));
  });

  it("returns the same value on repeated calls (cached)", () => {
    expect(deviceIcon(0)).to.equal(deviceIcon(0));
    expect(deviceIcon(undefined)).to.equal(deviceIcon(undefined));
  });

  it("yields identical bytes for a CRLF checkout", () => {
    // The Windows runner checks out with CRLF; the object value must not depend on that.
    for (const file of iconFiles()) {
      const lf = fileBytes(file);
      expect(normaliseLineEndings(lf.replace(/\n/g, "\r\n"))).to.equal(lf);
    }
  });

  it("has a file for every OS plus the fallback, and no orphan file", () => {
    const expected = new Set([...Object.values(ICON_BY_OS), FALLBACK_ICON]);
    expect(new Set(iconFiles())).to.deep.equal(expected);
  });

  it("uses only currentColor or none for fill and stroke — the icon must read on every theme", () => {
    for (const file of iconFiles()) {
      const svg = fileBytes(file);
      for (const m of svg.matchAll(/\b(fill|stroke)="([^"]*)"/g)) {
        expect(["currentColor", "none"], `${file}: ${m[1]}="${m[2]}"`).to.include(m[2]);
      }
      expect(svg, `${file}: no fixed colour anywhere`).to.not.match(/#[0-9a-fA-F]{3,8}\b|rgb\(|\b(black|white)\b/);
    }
  });

  it("draws with path and circle only — the object browser's cell CSS zeroes rect/image/use", () => {
    for (const file of iconFiles()) {
      const svg = fileBytes(file);
      const inner = svg.replace(/<svg[^>]*>/, "").replace(/<\/svg>\s*$/, "");
      const elements = [...inner.matchAll(/<([a-zA-Z]+)\b/g)].map(m => m[1]);
      expect(elements.length, `${file}: draws something`).to.be.greaterThan(0);
      for (const el of elements) {
        expect(["path", "circle"], `${file}: <${el}>`).to.include(el);
      }
    }
  });

  it("is drawn on the 64 × 64 grid the admin renders at 28 px", () => {
    for (const file of iconFiles()) {
      expect(fileBytes(file), file).to.include('viewBox="0 0 64 64"');
    }
  });

  it("leaves the field alone (undefined) when the icon file cannot be read, and never throws", () => {
    unreadable = "macos.svg";
    resetIconCache();
    expect(() => deviceIcon(1)).to.not.throw();
    expect(deviceIcon(1)).to.be.undefined;
    // The other files are unaffected.
    expect(deviceIcon(0)).to.be.a("string");
  });

  it("ships the third-party licence notice next to the files", () => {
    const notice = readFileSync(join(ICON_DIR, "LICENSES.md"), "utf8");
    for (const file of Object.values(ICON_BY_OS)) {
      expect(notice, `${file} is attributed`).to.include(`\`${file}\``);
    }
    expect(notice).to.include("MIT");
    expect(notice).to.include("Apache");
  });
});
