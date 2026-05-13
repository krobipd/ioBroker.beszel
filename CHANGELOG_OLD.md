# Older Changes
## 0.4.0 (2026-05-07)
- State names localized in 11 ioBroker languages, following the system setting.
- Object cache cuts js-controller calls per poll cycle.
- Baseline: Node 22, Admin 7.8.23 (ioBroker May-2026 stable).

## 0.3.10 (2026-05-01)
- Documentation: rewrote release notes for v0.3.3–v0.3.9 in user-friendly style across all languages.

## 0.3.9 (2026-05-01)
- Documentation cleanup. No code changes.

## 0.3.8 (2026-04-30)
- Internal cleanup. No user-facing changes.

## 0.3.7 (2026-04-28)
- Internal cleanup. No user-facing changes.

## 0.3.6 (2026-04-26)
- Min `js-controller` restored to `>=6.0.11` (was incorrectly bumped to `>=7.0.23` in 0.3.5).

## 0.3.5 (2026-04-26)
- Crash defense: process-level error handlers.

## 0.3.4 (2026-04-23)
- Defense-in-depth: `systems` folder as instance object, `.catch()` wrap on async `onReady`/`onMessage`.

## 0.3.3 (2026-04-19)
- Internal: `common.messagebox=true` (admin-UI button routing).

## 0.3.2 (2026-04-18)
- API-boundary hardening: type coercion for every Beszel Hub field. +105 drift tests.

## 0.3.1 (2026-04-12)
- Fix: response-stream errors handled, per-system poll failures isolated, safer `onMessage`.

## 0.3.0 (2026-04-12)
- **Breaking:** state tree reorganized into channels (info, cpu, memory, disk, network, temperature, battery). Auto-migration on first start.

## 0.2.7 (2026-04-12)
- Internal cleanup.

## 0.2.6 (2026-04-08)
- Internal: `node:` prefix for built-in modules.

## 0.2.5 (2026-04-08)
- Internal: standard tests restored.

## 0.2.4 (2026-04-05)
- Internal: cleaner log messages.

## 0.2.3 (2026-04-05)
- Internal cleanup.

## 0.2.2 (2026-04-03)
- Internal dev-tooling modernization.

## 0.2.1 (2026-03-28)
- Error deduplication, auth-backoff after 3 failures, empty-systems guard.

## 0.2.0 (2026-03-28)
- Adapter timers; sync `onUnload`; admin UI compacted.

## 0.1.9 (2026-03-19)
- Internal: stale-system removal moved to debug level.

## 0.1.8 (2026-03-19)
- Online/offline indicator on system device folders.

## 0.1.7 (2026-03-19)
- System count added to startup log.

## 0.1.6 (2026-03-18)
- Internal: code cleanup, duplicate container filter fixed.

## 0.1.5 (2026-03-17)
- Migrated to `@alcalzone/release-script`. npm Trusted Publishing enabled.

## 0.1.4 (2026-03-17)
- Repochecker issues fixed; jsonConfig responsive sizing.

## 0.1.3 (2026-03-17)
- Internal: JSDoc warnings cleared (58 → 0).

## 0.1.2 (2026-03-17)
- Fix: `cpu_steal` state added to CPU breakdown metric.

## 0.1.1 (2026-03-17)
- Disabled metric states are now deleted on adapter restart.

## 0.1.0 (2026-03-17)
- Initial release. Beszel Hub via PocketBase REST API. CPU, memory, disk, network, temperature, load. Optional GPU, containers, battery.
