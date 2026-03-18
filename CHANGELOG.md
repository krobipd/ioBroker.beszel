# Changelog
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

## 0.1.3 (2026-03-17)
### Fixed
- Fix all JSDoc warnings (58 → 0) across all source files
- Add missing `@param` descriptions to all public methods and constructors
- Update all dependencies to latest versions (`@iobroker/adapter-core`, `@iobroker/testing`, `@types/node`)

## 0.1.2 (2026-03-17)
### Fixed
- Add missing `cpu_steal` state to CPU breakdown metric (was silently skipped)
- Remove unused dead `bandwidth` field (`b`) from `SystemStats` type

## 0.1.1 (2026-03-17)
### Fixed
- Disabled metric states are now deleted on adapter restart (`cleanupMetrics` is called for all existing systems during `onReady`)
- Previously, disabling a metric in the config left old states in the object tree until manually deleted

## 0.1.0 (2026-03-17)
### Added
- Initial release
- Connect to Beszel Hub via PocketBase REST API
- Support for all system metrics: CPU, memory, disk, network, temperature, load average
- Optional metrics: GPU, containers (Docker/Podman), battery, extra filesystems, CPU breakdown, systemd services
- Configurable poll interval (10–300 seconds)
- Token-based authentication with automatic refresh after 23 hours
- Automatic cleanup of removed systems and disabled metrics
- Full support for all 11 ioBroker languages
- Connection test button in admin UI
