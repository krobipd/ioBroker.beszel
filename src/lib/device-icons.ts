import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * v0.18.0 — the pictogram a system device object carries in the admin's object tree
 * (`common.icon`), chosen by the operating system the Hub's `system_details` reports.
 *
 * The value is the SVG file itself as an inline `data:` URI, not a path: the admin puts
 * an inline SVG into the DOM (so `currentColor` follows the row's text colour in every
 * theme), while a path lands in a bare `<img>` with a fixed colour that is invisible on
 * one theme family. The files are `path`-only with `currentColor`/`none` — the cell CSS
 * of the object browser zeroes the width of `rect`/`image`/`use` inside inlined markup.
 * Measured on the live admin, fleet rule (`CLAUDE_PATTERNS.md`, device pictograms).
 */

/** Beszel's `Os` enum (`internal/entities/system/system.go`) → icon file. */
export const ICON_BY_OS: Readonly<Record<number, string>> = {
  0: "linux.svg",
  1: "macos.svg",
  2: "windows.svg",
  3: "freebsd.svg",
};

/** Shown while the OS is not known: a pending system, or an enum value newer than this map. */
export const FALLBACK_ICON = "server.svg";

export const ICON_URI_PREFIX = "data:image/svg+xml;base64,";

// `build/lib` and `src/lib` both sit two levels below the adapter root.
const ICON_DIR = join(__dirname, "..", "..", "admin", "icons");

const cache = new Map<string, string | undefined>();

/** Forget the embedded files — for tests that exercise the disk read itself. */
export function resetIconCache(): void {
  cache.clear();
}

/**
 * CRLF → LF before embedding: the Windows runner checks the repository out with CRLF,
 * and the same file must yield the same URI on every platform (the inventory compares
 * the object value byte for byte).
 *
 * @param svg Raw file contents.
 */
export function normaliseLineEndings(svg: string): string {
  return svg.replace(/\r\n/g, "\n");
}

/**
 * The `common.icon` value for a system whose OS enum is `os`.
 *
 * @param os `system_details.os` — Beszel's `Os` enum; `undefined` when the Hub has no
 *   details row for the system (never connected).
 * @returns The inline data URI, or `undefined` if the icon file cannot be read (the
 *   device object then keeps whatever icon it has — the field is never blanked).
 */
export function deviceIcon(os: number | undefined): string | undefined {
  // `Object.hasOwn`, not `in`: an inherited property name ("constructor") must not
  // resolve to a function.
  const file = os !== undefined && Object.hasOwn(ICON_BY_OS, os) ? ICON_BY_OS[os] : FALLBACK_ICON;
  if (cache.has(file)) {
    return cache.get(file);
  }
  let uri: string | undefined;
  try {
    const svg = normaliseLineEndings(readFileSync(join(ICON_DIR, file), "utf8"));
    uri = `${ICON_URI_PREFIX}${Buffer.from(svg).toString("base64")}`;
  } catch {
    uri = undefined;
  }
  cache.set(file, uri);
  return uri;
}
