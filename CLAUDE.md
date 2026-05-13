# CLAUDE.md — ioBroker.beszel

> Gemeinsame ioBroker-Wissensbasis: `../CLAUDE.md` (lokal, nicht im Git). Standards dort, Projekt-Spezifisches hier.

## Projekt

**ioBroker Beszel Monitor** — Verbindet sich mit Beszel Hub (PocketBase) für Server-Monitoring.

- **Version:** 0.4.5 (released 2026-05-14, npm latest) — testClient cancelAll-Latency-Fix: short-lived `testClient` aus `checkConnection`-message wird via `this.testClients = new Set<BeszelClient>()` getrackt + im `onUnload` mit aborted. Vorher: `this.client.cancelAll()` aktiv aber testClient blieb hängen → konnte Adapter über js-controller's 4s-Kill-Deadline halten. `MessageRouterDeps` um `onTestClientCreated`/`onTestClientDone`-Hooks erweitert (test-lockable). 3 neue regression-tests in `message-router.test.ts` (register-then-deregister + finally-on-throw + missing-config skips both hooks). Test count 268→271. Cross-Adapter parallel zu parcelapp v0.4.4 (identisches Pattern). Identified during v0.4.4 audit als out-of-scope — Krobi-Korrektur: „nimm zusätzliche findings mit in den release", Lesson festgehalten in `feedback_low_ist_kein_skip` (Verstoß 4). v0.4.4 (2026-05-14) Debug-Coverage-Welle nach 9-Klassen-Audit (3114 LOC + 24 Sites). Score 3.8→9.0, 9/9 Klassen auf 9/10. Reine `log.debug`-Inserts plus optionaler `BeszelClientLogger`-Param (5. positional, class-member `this.log?`) + Architektur-Fix H4 (onMessage default-Branch) + `lib/message-router.ts`-Refactor für Test-Lockability + 6 message-router-Tests (262→268 unit). A0-A12 ohne A6 HTTPS-Trace; B1-B5 Token-Lifecycle; C1+C2 (warn bei MAX_PAGES); D1 429-retry-trace; E1+F1 Polling-Anchors; G1+G2+G4 state-manager; H1-H5 sendTo komplett inkl. H4 default-Branch; I1-I4 Lifecycle. Plus README header-icon raw→jsdelivr nicht nötig (svg-link existiert nicht im README — Logo via raw funktioniert für beszel SVG). v0.4.3 (released 2026-05-10) 26-Finding Hardening-Welle nach 4-Pass-Audit: B1 token-mutex (in-flight authPromise), B2 fetchAllPages pagination (PocketBase 200/500 cap weg), B3 429 transparent retry mit Retry-After, B4' 403 → distinct FORBIDDEN error class mit Hint, B5 admin requestTimeout (5–120s), B7 getLatestStats() simplified, B8 AbortController + cancelAll(), M1 process-handlers terminate(11), M2-M4 parallel cleanupMetrics+API+updateSystem, M5 validateHubUrl, M6 coercePollInterval (NaN-trap-fix), SM1-SM3 parallel cleanups+migration, SM4 defensive Set-iter, SM5 prepareForPoll mit Name-Kollision-Suffix, SM7 Math.floor(health), SM8 FS-percent-clamp, SM10 uptime-clamp, X1+X2 onUnload-cleanup. v0.4.2 (2026-05-09) Logs revert to English. v0.4.1 README-Whitespace-Hotfix. v0.4.0 Multi-Language + createdIds-Cache.
- **GitHub:** https://github.com/krobipd/ioBroker.beszel
- **npm:** https://www.npmjs.com/package/iobroker.beszel
- **Repository PR:** ioBroker/ioBroker.repositories#5787
- **Runtime-Deps:** nur `@iobroker/adapter-core` (HTTP via Node.js built-in)
- **Test-Setup:** offizieller ioBroker.example/TypeScript-Standard — Tests unter `src/lib/*.test.ts` direkt mit `ts-node/register`, kein separater Build (siehe globales `reference_iobroker_test_setup_standard`)
- **`@types/node` an `engines.node`-Min gekoppelt:** `^22.x` weil `engines.node: ">=22"`. Dependabot ignoriert Major-Bumps

## Architektur

```
src/main.ts              → Adapter (Lifecycle, Polling, Message-Handler)
src/lib/beszel-client.ts → HTTP Client (Auth, Systems, Stats, Containers)
src/lib/coerce.ts        → Boundary-Validator (NaN/Infinity/Typ-Drift) + errText-Helper
src/lib/state-manager.ts → ioBroker States erstellen/updaten/cleanup, createdIds-Cache
src/lib/i18n-states.ts   → 52 STATE_NAMES × 11 Sprachen + tName(key) Translation-Object
src/lib/types.ts         → TypeScript Interfaces (API + Config)
```

## Design-Entscheidungen

1. **Keine Runtime-Deps** außer adapter-core — HTTP via Node.js built-in node:http/node:https
2. **Token in Memory** — nie in ioBroker States gespeichert, Refresh nach 23h
3. **Error-Dedup** — `classifyError` + `lastErrorCode`, wiederkehrende Fehler nur debug
4. **Auth-Backoff** — nach 3 fehlgeschlagenen Versuchen weitere Auth-Fehler unterdrückt
5. **Empty-Systems-Guard** — leere API-Antwort löscht NICHT alle Geräte
6. **Metric-Cleanup** — deaktivierte Metriken werden beim Start gelöscht
7. **Channel-basierter State-Tree** — States in Channels organisiert (info, cpu, memory, disk, network, temperature, battery)
8. **Legacy-Migration** — `migrateLegacyStates()` löscht alte flache State-Pfade aus pre-0.3.0
9. **State-Common Factories** — `percentCommon`, `numCommon`, `textCommon`, `boolCommon` eliminieren Boilerplate
10. **Load-Avg Fallback** — `stats.la` bevorzugt, Fallback auf `system.info.la`
11. **Temperatur** — Durchschnitt der 3 heißesten Sensoren
12. **Name-Sanitization** — lowercase, non-alphanumeric → `_`, max 50 chars

## Metric-Toggles

20+ konfigurierbare Metriken (global für alle Systeme). Standard-on: uptime, cpu, loadAvg, memory, disk, diskSpeed, network, temperature. Alle anderen default off.

## Tests (262 unit + 57 package + 1 integration = 320)

Tests leben seit v0.3.7 neben dem Source als `src/lib/*.test.ts` und laufen direkt via `ts-node/register` (offizieller `ioBroker.example/TypeScript`-Standard).

```
src/lib/coerce.test.ts         → Boundary-Validator (Primitive + Beszel-Shapes) + errText
src/lib/beszel-client.test.ts  → API Client (Auth, Token, Errors, Responses, API-Drift)
src/lib/state-manager.test.ts  → StateManager + Translation-Objects + createdIds-Cache
test/package.js                → @iobroker/testing Package-Tests
test/integration.js            → @iobroker/testing Integration-Tests
```

Nicht getestet (bewusst): main.ts poll-Loop (Adapter-Lifecycle), onMessage (Callback-API).

## Versionshistorie (letzte 7)

| Version | Highlights |
|---------|------------|
| 0.4.5 | **testClient cancelAll-Latency-Fix:** short-lived `testClient` aus `checkConnection` admin-message wird via `this.testClients = new Set<BeszelClient>()` getrackt + im `onUnload` mit aborted. Vorher: `this.client.cancelAll()` aktiv aber testClient-inflight blieb hängen → konnte Adapter über js-controller's 4s-Kill-Deadline halten. `MessageRouterDeps` um optional `onTestClientCreated`/`onTestClientDone`-Hooks erweitert für Test-Lockability. `dispatchMessage`-checkConnection wrappt `testClient.checkConnection()` in try/finally damit deregistration auch bei throw läuft. 3 neue Regression-Tests in `message-router.test.ts` (register-then-deregister Symmetrie + finally-on-throw + missing-config skips both hooks). Cross-Adapter parallel zu parcelapp v0.4.4 (identisches Pattern, gleicher Fix). Identified during v0.4.4 audit als out-of-scope — Krobi-Korrektur „nimm zusätzliche findings mit in den release", Lesson festgehalten in `feedback_low_ist_kein_skip` (Verstoß 4). Test count 268→271 unit |
| 0.4.4 | **Debug-Coverage-Welle** nach 9-Klassen-Audit (3114 LOC + 24 Sites). Score 3.8→9.0, 9/9 Klassen auf 9/10. Reine `log.debug`-Inserts in 3 src-Files + optionaler `BeszelClientLogger`-Param (5. positional + class-member `this.log?`): A0 startedAt + A1-A12 (ohne A6) HTTPS-Layer inkl. body-snippet + cancelAll-inflight-count; B1-B5 Token-Lifecycle (in-flight-wait + fresh-auth + drift + invalidate); C1 multi-page-Trace + **C2 warn bei MAX_PAGES-Truncation** (data may be incomplete); D1 429-retry sleep+attempt; E1+F1 poll-anchors mit Cadence-Berechnung; G1 updateSystem state-tree entry; G2 cleanupMetrics summary; G4 migrateLegacyStates scan-start; I1-I4 Lifecycle inkl. always-log resolved timeoutMs + pollInterval; I4 onUnload-catch ersetzt silent ignore. Plus **H4 Architektur-Fix:** `switch (obj.command)` hatte keinen default-Branch → unknown commands ließen `obj.callback` ungerufen bis ioBroker-Timeout ~5s. Refactor in `lib/message-router.ts` als pure `dispatchMessage(obj, deps)`-Funktion + 6 Regression-Tests (default-branch contract + entry-log-position + checkConnection). Logger an beide BeszelClient-Sites (prod + testClient). Krobi-Pushback im Plan: erst „B+A geplant" verworfen weil Doppelarbeit, direkt A. Test count 262→268 unit |
| 0.4.3 | 26-Finding 4-Pass-Hardening: token-mutex (B1) + pagination (B2) + 429-retry+Retry-After (B3) + 403-distinct-class (B4') + configurable timeout (B5) + AbortController/cancelAll (B8); main-parallel API/updates/cleanup (M2-M4) + URL-validate (M5) + pollInterval NaN-fix (M6) + terminate(11) (M1); state-mgr-parallel cleanups/migration (SM1-SM3) + defensive Set-iter (SM4) + name-collision suffix via FNV-1a-hash (SM5) + container.health Math.floor (SM7) + FS-percent clamp (SM8) + uptime clamp (SM10); onUnload abort + explicit catch (X1+X2). Tests 253→262. **Hardcore-Regel angewandt — alle 26 Findings umgesetzt, kein Filter.** |
| 0.4.2 | Adapter logs zurück auf Englisch (mcm1957-Linie aus ioBroker.repositories#5667 — „log messages must be in english"). `lib/i18n-logs.ts` + `lib/i18n-logs.test.ts` gelöscht. 14 `tLog(...)`-Aufrufe in `main.ts` (12) und `state-manager.ts` (2) durch direkte EN-Template-Strings ersetzt. `systemLang`-Property aus `main.ts` und Constructor-Param aus `StateManager` entfernt — nicht mehr nötig, weil i18n-states via `tName()` Translation-Object liefert (Admin/vis machen Lookup automatisch). State-Namen in 11 Sprachen unverändert. |
| 0.4.1 | README-Whitespace-Hotfix: Leerzeile zwischen Changelog-Footer und `## Support` wiederhergestellt (alcalzone-Plugin hatte sie beim Rotieren in v0.4.0 gefressen). Fix-Hook `fix-changelog-footer.py` um Spacing-Normalisierung erweitert — fängt jetzt beide Bug-Varianten (fehlend + zusammengeklebt) |
| 0.4.0 | Multi-Language-Welle analog hassemu v1.28.0 / govee v2.6.0: `lib/i18n-logs.ts` (14 LOG_STRINGS × 11 Sprachen + tLog Helper), `lib/i18n-states.ts` (52 STATE_NAMES × 11 Sprachen + tName Helper). Alle State-Common-Factories auf `ioBroker.StringOrTranslated`, alle hardcoded EN-Strings via `tName('key')`. Lokaler `errText` aus main.ts in `lib/coerce.ts` zentralisiert (4 Inline-Patterns durch `errText`-Aufrufe ersetzt). `createdIds`-Set Cache spart pro Poll setObjectNotExistsAsync-Roundtrips. Baseline auf Node 22 + Admin >=7.8.23 + @types/node ^22.x + @tsconfig/node22, Deploy-Step PRE-EMPTIVE auf Node 24. *Log-Lokalisierung wurde in 0.4.2 zurückgebaut.* |
| 0.3.10 | Doku-Welle: Release-Notes für v0.3.3–v0.3.9 in user-friendly Stil über alle 11 Sprachen umgeschrieben |
| 0.3.9 | Doku-Cleanup, keine Code-Änderungen |
| 0.3.8 | Cleanup-Welle analog parcelapp v0.3.0: `format` + `format:check` npm-scripts, dependabot.yml ignore-Block, repochecker-version-gate Master-Snippet |
| 0.3.7 | Audit-Cleanup gegen ioBroker.example/TypeScript-Vollstandard: Test-Setup auf `src/lib/*.test.ts` + ts-node, dependabot ignore-Block für Major-Bumps |
| 0.3.6 | Hotfix js-controller-Min auf `>=6.0.11` (Repochecker-recommended), war versehentlich `>=7.0.23` |

## Befehle

```bash
npm run build         # Production (esbuild)
npm test              # mocha src/**/*.test.ts (via ts-node) + @iobroker/testing packageFiles
npm run lint          # ESLint
npm run format:check  # Prettier --check
npm run check         # tsc --noEmit (Type-Check)
```
