# Changelog
## **WORK IN PROGRESS**

## 0.2.0 (2026-03-28)

- Use adapter timer methods (setInterval/clearInterval) instead of native timers
- Fix onUnload to be synchronous (prevents SIGKILL on shutdown)
- Admin UI: merge About tab into Connection tab (3 → 2 tabs, donation as header section)
- Remove orphaned i18n keys (aboutTab, aboutHeader)
- Remove broken Ko-fi icon from donation button
- Add Windows and macOS to CI test matrix
- README: standard license format with full MIT text

## 0.1.9 (2026-03-19)

- Logging cleanup: stale system removal moved to debug level

## 0.1.8 (2026-03-19)

- Add online/offline indicator to system device folders (statusStates.onlineId)

## 0.1.7 (2026-03-19)

- Add system count to startup log message

## 0.1.6 (2026-03-18)

- Code cleanup: remove unused type aliases, dead `_config` parameter, redundant setState call
- Fix duplicate container filter (was filtered in main.ts and again in updateContainers)
- Extract load avg state creation into helper to eliminate code duplication

## 0.1.5 (2026-03-17)

- Migrate to @alcalzone/release-script for automated releases
- Enable npm Trusted Publishing (OIDC), remove legacy npm token

## 0.1.4 (2026-03-17)
### Fixed
- Fix all ioBroker repochecker issues (E0003, E1020, E1069, E1105, E2004, E5507, E6005, E6006, E9502)
- Rename GitHub repository to `ioBroker.beszel` (capital B) for repochecker compliance
- Add responsive grid breakpoints (`xs`, `lg`, `xl`) to all jsonConfig fields
- Add `size` property to all header elements in jsonConfig
- Fix SVG icon to square aspect ratio (viewBox)
- Add `files` field to package.json
- Update `io-package.json`: move `instanceObjects` to root level, fix adapter type to `hardware`
- Remove non-published versions from `news` in io-package.json
- Update README with copyright notice and correct version badge

Older changes: [CHANGELOG_OLD.md](CHANGELOG_OLD.md)
