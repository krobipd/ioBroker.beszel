# Older Changes

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
