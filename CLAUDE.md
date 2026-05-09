# CLAUDE.md — ioBroker.beszel

> Gemeinsame ioBroker-Wissensbasis: `../CLAUDE.md` (lokal, nicht im Git). Standards dort, Projekt-Spezifisches hier.

## Projekt

**ioBroker Beszel Monitor** — Verbindet sich mit Beszel Hub (PocketBase) für Server-Monitoring.

- **Version:** 0.4.1 (released 2026-05-07, npm latest) — README-Whitespace-Fix nach v0.4.0: alcalzone-iobroker-Plugin hatte beim Rotieren von 0.3.5 in CHANGELOG_OLD die Leerzeile zwischen `Older entries...`-Footer und `## Support` gefressen. Fix-Hook `Entwicklung/scripts/fix-changelog-footer.py` um Spacing-Normalisierung erweitert. v0.4.0 (2026-05-07) Multi-Language-Welle (14 LOG_STRINGS + 52 STATE_NAMES × 11 Sprachen, createdIds-Cache, errText-Zentralisierung, Node 22 baseline).
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

## Tests (261 unit + 57 package + 1 integration)

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
