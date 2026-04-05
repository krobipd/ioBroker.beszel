# Changelog
## 0.2.4 (2026-04-05)

- Cleaner log messages, remove redundant adapter name prefix

## 0.2.3 (2026-04-05)

- Remove redundant scripts (`build:ts`, `prepare`, `test:ci`)
- Remove unused devDependencies (`source-map-support`, `ts-node`)
- Compress CLAUDE.md documentation (115 → ~80 lines)

## 0.2.2 (2026-04-03)

- Modernize dev tooling: esbuild via build-adapter, @tsconfig/node20, rimraf, TypeScript ~5.9.3 pin
- Upgrade testing-action-check to v2.0.0
- Dependabot: monthly schedule, auto-merge skips major updates
- Branch protection: require check-and-lint status check

## 0.2.1 (2026-03-28)

- Error deduplication: repeated errors are logged at debug level instead of flooding the error log
- Auth backoff: after 3 failed auth attempts, suppress further error logs
- Protect against empty system list: don't delete all devices when API temporarily returns zero systems

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

Older changes: [CHANGELOG_OLD.md](CHANGELOG_OLD.md)
