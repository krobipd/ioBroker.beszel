# Older Changes
## 0.5.3 (2026-05-17)
- Removes the automatic credential migration. After upgrading from a pre-0.5.0 version, open the Beszel adapter settings once and save — the framework encrypts your credentials cleanly.

## 0.5.2 (2026-05-17)
- Fixes the migration loop introduced in 0.5.0/0.5.1 — usernames that got re-encrypted multiple times are cleared on update. Please re-enter your Beszel credentials in admin once.

## 0.5.1 (2026-05-17)
- Restores the encrypted-credentials migration that was incomplete in 0.5.0 — usernames stored as plain text now migrate cleanly on the next start.

## 0.5.0 (2026-05-17)
- Hub username and password are both stored encrypted now. The first start after the update migrates existing plain-text usernames automatically.
- README now documents the Request Timeout setting.

## 0.4.5 (2026-05-13)
- Adapter shuts down cleanly even if the "Test Connection" button was still running — the test request is now aborted at unload along with regular polling.

## 0.4.4 (2026-05-13)
- Debug log traces previously silent paths: HTTP request lifecycle, token authentication, pagination walks and the 429-retry. Default log unchanged.
- Test Connection in admin no longer hangs on an unknown command — it now gets a clear error response instead.

## 0.4.3 (2026-05-10)
- Big setups (200+ servers / 500+ containers) now load completely instead of being silently truncated, and they start up noticeably faster — system updates, cleanups and the startup migration run in parallel.
- New "Request timeout" setting in admin (5–120 s, default 15 s) for slow links or very large payloads.
- Hub rate-limit (429): one transparent retry that honours `Retry-After`; permanent rate-limits surface as a clear log so you can raise the poll interval.
- "Forbidden" (403) responses now show a permission hint instead of looping reauth.
- Two servers whose names sanitize to the same id no longer overwrite each other — the second gets a hash suffix and a warn so you can rename on the Hub.
- Adapter shuts down cleanly even if the Hub is slow — pending requests are aborted.

## 0.4.2 (2026-05-09)
- Adapter log messages are now English only, in line with the ioBroker community standard. Localized state names (11 languages) are unchanged.

## 0.4.1 (2026-05-07)
- Restored the blank line between the changelog footer and the Support section (release-script swallowed it in v0.4.0).

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
