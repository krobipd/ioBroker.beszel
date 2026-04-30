# CLAUDE.md — ioBroker.beszel

> Gemeinsame ioBroker-Wissensbasis: `../CLAUDE.md` (lokal, nicht im Git). Standards dort, Projekt-Spezifisches hier.

## Projekt

**ioBroker Beszel Monitor** — Verbindet sich mit Beszel Hub (PocketBase) für Server-Monitoring.

- **Version:** 0.3.8 (in progress — Cleanup-Welle analog parcelapp v0.3.0: format/format:check npm-scripts ergänzt, .github/dependabot.yml aus Master mit ignore-Block für `actions/checkout`+`actions/setup-node` Major-Bumps, `repochecker-version-gate` Job-Block von M1000-Logik auf sources-dist-stable Master-Snippet umgestellt, CLAUDE.md-Tests-Sektion + Befehle auf v0.3.7-Stand aktualisiert)
- **GitHub:** https://github.com/krobipd/ioBroker.beszel
- **npm:** https://www.npmjs.com/package/iobroker.beszel
- **Repository PR:** ioBroker/ioBroker.repositories#5787
- **Runtime-Deps:** nur `@iobroker/adapter-core` (HTTP via Node.js built-in)
- **Test-Setup:** offizieller ioBroker.example/TypeScript-Standard — Tests unter `src/lib/*.test.ts` direkt mit `ts-node/register`, kein separater Build (siehe globales `reference_iobroker_test_setup_standard`)
- **`@types/node` an `engines.node`-Min gekoppelt:** `^20.x` weil `engines.node: ">=20"`. Dependabot ignoriert Major-Bumps

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

## Tests (235 unit + 57 package + 1 integration)

Tests leben seit v0.3.7 neben dem Source als `src/lib/*.test.ts` und laufen direkt via `ts-node/register` (offizieller `ioBroker.example/TypeScript`-Standard).

```
src/lib/coerce.test.ts         → Boundary-Validator (Primitive + Beszel-Shapes)
src/lib/beszel-client.test.ts  → API Client (Auth, Token, Errors, Responses, API-Drift)
src/lib/state-manager.test.ts  → StateManager (Sanitize, System, Stats, GPU, FS, Containers, Cleanup, Migration, Defensive Boundaries)
test/package.js                → @iobroker/testing Package-Tests
test/integration.js            → @iobroker/testing Integration-Tests
```

Nicht getestet (bewusst): main.ts poll-Loop (Adapter-Lifecycle), onMessage (Callback-API).

## Versionshistorie (letzte 7)

| Version | Highlights |
|---------|------------|
| 0.3.8 | Cleanup-Welle analog parcelapp v0.3.0: `format` + `format:check` npm-scripts ergänzt, `.github/dependabot.yml` aus Master mit ignore-Block für `actions/checkout` + `actions/setup-node` Major-Bumps, `repochecker-version-gate` Job-Block von M1000-Logik auf sources-dist-stable Master-Snippet umgestellt, CLAUDE.md Tests-Sektion + Befehle auf v0.3.7-Stand aktualisiert. |
| 0.3.7 | Audit-Cleanup gegen ioBroker.example/TypeScript-Vollstandard: Test-Setup auf `src/lib/*.test.ts` + ts-node, `tsconfig.test.json` + `build-test/` raus, `@types/node` von `^25.6.0` auf `^20.19.24` (engines.node >=20), dependabot ignore-Block für Major-Bumps von `@types/node`+`typescript`+`eslint`+`actions/checkout`+`actions/setup-node`, `nyc`-Config + `coverage`-Script, `prettier.config.mjs` mit Project-Style-Override, `auto-merge.yml` raus (verwaist), `.js`-Imports in src/ entfernt (bare-Names konsistent) |
| 0.3.6 | Hotfix js-controller-Min auf `>=6.0.11` (Repochecker-recommended), war versehentlich `>=7.0.23` |
| 0.3.5 | Process-level `unhandledRejection`/`uncaughtException`-Handler. `manual-review`-Plugin raus. Konsistenz-Cleanup |
| 0.3.4 | tsconfig.test.json → outDir `./build-test` (später durch v0.3.7 vollständig ersetzt), `systems` als instanceObject, async-handler `.catch()` für onReady + onMessage |
| 0.3.3 | Latest-repo review compliance: `common.messagebox=true` |
| 0.3.2 | API-Boundary-Härtung: coerce.ts mit typed coercers + 105 Drift-Tests |
| 0.3.1 | Error-Handling: res.on("error"), per-system Poll-Isolation, onMessage try/catch |

## Befehle

```bash
npm run build         # Production (esbuild)
npm test              # mocha src/**/*.test.ts (via ts-node) + @iobroker/testing packageFiles
npm run lint          # ESLint
npm run format:check  # Prettier --check
npm run check         # tsc --noEmit (Type-Check)
```
