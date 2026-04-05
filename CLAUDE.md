# CLAUDE.md — ioBroker.beszel

> Gemeinsame ioBroker-Wissensbasis: `../CLAUDE.md` (lokal, nicht im Git). Standards dort, Projekt-Spezifisches hier.

## Projekt

**ioBroker Beszel Monitor** — Verbindet sich mit Beszel Hub (PocketBase) für Server-Monitoring.

- **Version:** 0.2.4 (April 2026)
- **GitHub:** https://github.com/krobipd/ioBroker.beszel
- **npm:** https://www.npmjs.com/package/iobroker.beszel
- **Repository PR:** ioBroker/ioBroker.repositories#5645
- **Runtime-Deps:** nur `@iobroker/adapter-core` (HTTP via Node.js built-in)

## Architektur

```
src/main.ts              → Adapter (Lifecycle, Polling, Message-Handler)
src/lib/beszel-client.ts → HTTP Client (Auth, Systems, Stats, Containers)
src/lib/state-manager.ts → ioBroker States erstellen/updaten/cleanup
src/lib/types.ts         → TypeScript Interfaces (API + Config)
```

## Design-Entscheidungen

1. **Keine Runtime-Deps** außer adapter-core — HTTP via Node.js built-in http/https
2. **Token in Memory** — nie in ioBroker States gespeichert, Refresh nach 23h
3. **Error-Dedup** — `classifyError` + `lastErrorCode`, wiederkehrende Fehler nur debug
4. **Auth-Backoff** — nach 3 fehlgeschlagenen Versuchen weitere Auth-Fehler unterdrückt
5. **Empty-Systems-Guard** — leere API-Antwort löscht NICHT alle Geräte
6. **Metric-Cleanup** — deaktivierte Metriken werden beim Start gelöscht
7. **Load-Avg Fallback** — `stats.la` bevorzugt, Fallback auf `system.info.la`
8. **Temperatur** — Durchschnitt der 3 heißesten Sensoren
9. **Name-Sanitization** — lowercase, non-alphanumeric → `_`, max 50 chars

## Metric-Toggles

20+ konfigurierbare Metriken (global für alle Systeme). Standard-on: uptime, cpu, loadAvg, memory, disk, diskSpeed, network, temperature. Alle anderen default off.

## Tests (183)

```
test/testBeszelClient.ts  → API Client (Auth, Token, Errors, Responses) (36 Tests)
test/testStateManager.ts  → StateManager (Sanitize, System, Stats, GPU, FS, Containers, Cleanup) (90 Tests)
test/testPackageFiles.ts  → @iobroker/testing (57 Tests)
```

Nicht getestet (bewusst): main.ts poll-Loop (Adapter-Lifecycle), onMessage (Callback-API).

## Versionshistorie

| Version | Highlights |
|---------|------------|
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
