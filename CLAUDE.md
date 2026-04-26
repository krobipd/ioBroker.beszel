# CLAUDE.md — ioBroker.beszel

> Gemeinsame ioBroker-Wissensbasis: `../CLAUDE.md` (lokal, nicht im Git). Standards dort, Projekt-Spezifisches hier.

## Projekt

**ioBroker Beszel Monitor** — Verbindet sich mit Beszel Hub (PocketBase) für Server-Monitoring.

- **Version:** 0.3.4 (2026-04-23, proaktive Review-Härtung nach parcelapp-Learnings)
- **GitHub:** https://github.com/krobipd/ioBroker.beszel
- **npm:** https://www.npmjs.com/package/iobroker.beszel
- **Repository PR:** ioBroker/ioBroker.repositories#5787
- **Runtime-Deps:** nur `@iobroker/adapter-core` (HTTP via Node.js built-in)

## Architektur

```
src/main.ts              → Adapter (Lifecycle, Polling, Message-Handler)
src/lib/beszel-client.ts → HTTP Client (Auth, Systems, Stats, Containers)
src/lib/coerce.ts        → Boundary-Validator (NaN/Infinity/Typ-Drift)
src/lib/state-manager.ts → ioBroker States erstellen/updaten/cleanup
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

## Tests (292)

```
test/testCoerce.ts        → Boundary-Validator (Primitive + Beszel-Shapes) (74 Tests)
test/testBeszelClient.ts  → API Client (Auth, Token, Errors, Responses, API-Drift) (39 Tests)
test/testStateManager.ts  → StateManager (Sanitize, System, Stats, GPU, FS, Containers, Cleanup, Migration, Defensive Boundaries) (122 Tests)
test/package.js           → @iobroker/testing Package-Tests (57 Tests)
test/integration.js       → @iobroker/testing Integration-Tests (plain JS)
```

Nicht getestet (bewusst): main.ts poll-Loop (Adapter-Lifecycle), onMessage (Callback-API).

## Versionshistorie

| Version | Highlights |
|---------|------------|
| 0.3.4 | tsconfig.test.json → outDir `./build-test`, `systems` (folder, 11-sprachig) als instanceObject, async-handler `.catch()`-Wrapper für onReady + onMessage, redundantes dynamisches `info`/`info.connection`-Setup in main.ts entfernt (ist in instanceObjects) |
| 0.3.3 | Latest-repo review compliance: `common.messagebox=true` weil `Check Connection` durch `onMessage` läuft |
| 0.3.2 | API-Boundary-Härtung: coerce.ts mit coerceFiniteNumber/String/Boolean/Object + typed coercers (System/Stats/Container/Auth). +105 Drift-Tests |
| 0.3.1 | Error-Handling: res.on("error"), per-system Poll-Isolation, onMessage try/catch+callback, EHOSTUNREACH |
| 0.3.0 | **Breaking:** Channel-basierter State-Tree, Legacy-Migration, DRY-Refactor (state-common factories), role-Fix |
| 0.2.7 | README State-Tree Fix, no-floating-promises, CI checkout entfernt |
| 0.2.6 | node: Prefix für built-in Module (S5043) |
| 0.2.5 | Review-Fixes: Standard-Tests (plain JS), CHANGELOG.md entfernt, FORBIDDEN_CHARS-Ref |
| 0.2.4 | Cleaner Log-Messages, redundanter Adapter-Name-Prefix entfernt |
| 0.2.3 | Redundante Scripts/DevDeps entfernt, Doku komprimiert |
| 0.2.2 | Dev-Tooling modernisiert (esbuild, TS 5.9 Pin) |
| 0.2.1 | Error-Dedup, Auth-Backoff, Empty-Systems-Guard |
| 0.2.0 | Adapter-Timer, sync onUnload, About→Connection merged, CI cross-platform |
| 0.1.4 | Alle Repochecker-Fehler gefixt |
| 0.1.0 | Initial Release |

## Befehle

```bash
npm run build        # Production (esbuild)
npm run build:test   # Test build (tsc)
npm test             # Build + mocha
npm run lint         # ESLint + Prettier
```
