# Changelog

## 0.1.0 (2026-03-17)
### Added
- Initial release
- Connect to Beszel Hub via PocketBase REST API
- Support for all system metrics: CPU, memory, disk, network, temperature, load average
- Optional metrics: GPU, containers (Docker/Podman), battery, extra filesystems, CPU breakdown
- Configurable poll interval (10–300 seconds)
- Token-based authentication with automatic refresh after 23 hours
- Automatic cleanup of removed systems and disabled metrics
- Full support for all 11 ioBroker languages
- Connection test button in admin UI
