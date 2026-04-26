# Older Changes
## 0.3.1 (2026-04-12)
- Fix: handle response stream errors (prevents unhandled exceptions on connection drop)
- Fix: isolate per-system poll failures (one broken system no longer blocks all others)
- Fix: harden onMessage with try/catch and callback guard
- Fix: classify EHOSTUNREACH as network error for proper log deduplication

## 0.3.0 (2026-04-12)
- **Breaking:** Reorganize state tree into channels (info, cpu, memory, disk, network, temperature, battery).
- Automatic migration removes legacy flat state paths on first start.
- Fix: read-only percentage states use correct `value` role instead of `level`.
- Complete state tree documentation in README.

## 0.2.7 (2026-04-12)
- README state tree fixed (8 missing default-on states added), `no-floating-promises` lint rule added, redundant CI checkout removed.

Older entries have been moved to [CHANGELOG_OLD.md](CHANGELOG_OLD.md).

## 0.2.6 (2026-04-08)
- `node:` prefix used for built-in modules (http, https, url).

## 0.2.5 (2026-04-08)
- Standard GitHub-based tests restored, redundant `CHANGELOG.md` removed, FORBIDDEN_CHARS reference added.

## 0.2.4 (2026-04-05)
- Cleaner log messages, redundant adapter-name prefix removed.

## 0.2.3 (2026-04-05)
- Redundant scripts removed, unused devDependencies dropped, documentation compressed.

## 0.2.2 (2026-04-03)
- Dev tooling modernised — esbuild, TypeScript 5.9 pin, testing-action-check v2.

## 0.2.1 (2026-03-28)
- Error deduplication, auth-backoff after 3 failures, empty-systems guard.

## 0.2.0 (2026-03-28)
- Adapter timer methods (`setInterval`/`clearInterval`) instead of native timers.
- `onUnload` made synchronous (prevents SIGKILL on shutdown).
- Admin UI — About tab merged into Connection tab (3 → 2 tabs, donation as header section).
- Orphaned i18n keys removed (`aboutTab`, `aboutHeader`).
- Broken Ko-fi icon removed from donation button.
- Windows and macOS added to CI test matrix.
- README — standard license format with full MIT text.

## 0.1.9 (2026-03-19)
- Logging cleanup — stale-system removal moved to debug level.

## 0.1.8 (2026-03-19)
- Online/offline indicator added to system device folders (`statusStates.onlineId`).

## 0.1.7 (2026-03-19)
- System count added to startup log message.

## 0.1.6 (2026-03-18)
- Code cleanup — unused type aliases, dead `_config` parameter, redundant `setState` removed.
- Duplicate container filter fixed (was filtered in main.ts and again in updateContainers).
- Load-avg state creation extracted into helper to eliminate duplication.

## 0.1.5 (2026-03-17)
- Migrated to `@alcalzone/release-script` for automated releases.
- npm Trusted Publishing (OIDC) enabled, legacy npm token removed.

## 0.1.4 (2026-03-17)
- All ioBroker repochecker issues fixed (E0003, E1020, E1069, E1105, E2004, E5507, E6005, E6006, E9502).
- GitHub repository renamed to `ioBroker.beszel` (capital B) for repochecker compliance.
- Responsive grid breakpoints (`xs`, `lg`, `xl`) added to all jsonConfig fields.
- `size` property added to all header elements in jsonConfig.
- SVG icon fixed to square aspect ratio (viewBox).
- `files` field added to `package.json`.
- `io-package.json` updated — `instanceObjects` moved to root level, adapter type fixed to `hardware`.
- Non-published versions removed from `news` in io-package.json.
- README updated with copyright notice and correct version badge.

## 0.1.3 (2026-03-17)
- All JSDoc warnings fixed (58 → 0) across all source files.
- Missing `@param` descriptions added to all public methods and constructors.
- All dependencies updated to latest versions.

## 0.1.2 (2026-03-17)
- Missing `cpu_steal` state added to CPU breakdown metric (was silently skipped).
- Unused dead `bandwidth` field removed from `SystemStats` type.

## 0.1.1 (2026-03-17)
- Disabled metric states are now deleted on adapter restart.
- Previously, disabling a metric in the config left old states in the object tree.

## 0.1.0 (2026-03-17)
- Initial release.
- Connects to Beszel Hub via PocketBase REST API.
- Supports all system metrics — CPU, memory, disk, network, temperature, load average.
- Optional metrics — GPU, containers, battery, extra filesystems, CPU breakdown, systemd services.
- Configurable poll interval (10–300 seconds).
- Token-based authentication with automatic refresh after 23 hours.
- Automatic cleanup of removed systems and disabled metrics.
- Full support for all 11 ioBroker languages.
- Connection test button in admin UI.
