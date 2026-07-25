# CLAUDE.md — ioBroker.beszel

> Gemeinsame ioBroker-Wissensbasis: `../CLAUDE.md` (lokal, nicht im Git). Standards dort, Projekt-Spezifisches hier.

## Projekt

**ioBroker Beszel Monitor** — Verbindet sich mit Beszel Hub (PocketBase) für Server-Monitoring.

- **Version + Changelog:** current version in `io-package.json`; full internal dev history moved to `.claude/dev-history.md` (local, not auto-loaded). User-facing changelog: `README.md` + `io-package.json` news.
- **GitHub:** https://github.com/krobipd/ioBroker.beszel
- **npm:** https://www.npmjs.com/package/iobroker.beszel
- **Repository PR:** ioBroker/ioBroker.repositories#5787
- **Runtime-Deps:** aktuell nur `@iobroker/adapter-core`, HTTP über Node.js-Bordmittel (`node:http`/`node:https`). **Kein Zero-Dep-Prinzip** — Dependencies sind ok wenn sie etwas bringen, wichtig ist nur, sie aktuell zu halten (Memory `feedback_deps_aktuell_nicht_minimal`).
- **Test-Setup:** Tests unter `src/lib/*.test.ts` direkt via **vitest** (seit v0.5.0; vorher mocha+ts-node, vitest löst den ESM-Loader-Bug strukturell und ist ~10× schneller). `test/package.js` + `test/integration.js` bleiben mocha (`@iobroker/testing` ist mocha-only).
- **`@types/node` an `engines.node`-Min gekoppelt:** `^22.x` weil `engines.node: ">=22"`. Dependabot ignoriert Major-Bumps

## Architektur

```
src/main.ts                     → Adapter (Lifecycle, Polling, Message-Handler, system_details-Cache F2)
src/lib/beszel-client.ts        → HTTP Client (Auth, Systems, Stats, Containers, getSystemDetails)
src/lib/coerce.ts               → Boundary-Validator (NaN/Infinity/Typ-Drift) + errText + validateHubUrl + coercePollInterval/coerceTimeoutMs (v0.5.0 S1)
src/lib/state-manager.ts        → ioBroker States erstellen/updaten/cleanup, createdIds-Cache
src/lib/i18n.ts                 → tName(key) Wrapper über I18n.getTranslatedObject() (adapter-core I18n-Framework)
admin/i18n/<lang>.json          → Single-Source-of-Truth für UI- + State-Translations (99 Keys × 11 Sprachen)
src/lib/message-router.ts       → onMessage-Dispatcher (default-Branch-Contract, v0.4.5 testClient-Hooks)
src/lib/types.ts                → TypeScript Interfaces (API + Config)
../scripts/sync-iopackage-from-i18n.py → regeneriert io-package.json:instanceObjects.common.name aus admin/i18n/ (zentral, source: admin-i18n)
```

## Design-Entscheidungen

1. **HTTP über Node.js-Bordmittel** (`node:http`/`node:https`) — der REST-Client braucht keinen externen HTTP-Client. Das ist eine Implementierungs-Tatsache, **kein Zero-Dep-Zwang**: weitere Deps sind erlaubt wenn sie etwas bringen (Memory `feedback_deps_aktuell_nicht_minimal`).
2. **Token in Memory** — nie in ioBroker States gespeichert, Refresh nach 23h
3. **Error-Dedup** — `classifyError` + `lastErrorCode`, wiederkehrende Fehler nur debug
4. **Auth-Backoff** — nach 3 fehlgeschlagenen Versuchen weitere Auth-Fehler unterdrückt
5. **Empty-Systems-Guard** — leere API-Antwort löscht NICHT alle Geräte
6. **Metric-Cleanup** — deaktivierte Metriken werden beim Start gelöscht
7. **Channel-basierter State-Tree** — States in Channels organisiert (info, cpu, memory, disk, network, temperature, battery)
8. **Legacy-Migration** — `migrateLegacyStates()` löscht alte flache State-Pfade aus pre-0.3.0
9. **State-Common Factories** — `percentCommon`, `numCommon`, `textCommon`, `boolCommon` eliminieren Boilerplate
10. **Load-Avg Fallback** — `stats.la` bevorzugt, Fallback auf `system.info.la`
11. **Temperatur** — Durchschnitt der 3 heißesten Sensoren + heißester Einzelsensor (`temperature.max`, F7)
12. **Name-Sanitization** — lowercase, non-alphanumeric → `_`, max 50 chars
13. **Metrik-Registry (K1)** — eine deklarative `metricDefs()`-Tabelle treibt sowohl `applyMetrics` (anlegen+setzen) als auch `cleanupMetrics` (löschen); `available(stats, system)` gated die Erstellung auf Daten-Präsenz (z.B. Peak-Felder, `system.details`) → kein leerer State auf älteren Beszel-Versionen, keine Create/Cleanup-Drift. Dynamische Gruppen (Sensoren/GPU/Filesystems/Cores/Interfaces/Engines/Container) bleiben in `updateDynamicStats`/`updateContainers`.
14. **Version-Robustheit (v0.18.7-verifiziert)** — alle Felder durch Coercer (absent → null/skip), neue Felder `available`-gated. Datenmodell gegen die gebündelte Quelle beszel v0.18.7 geprüft (NICHT main): `os_name` ist snake_case, `os` numerisches Enum, Container-`net` = Bytes/s (Sent+Recv), `bat` = `[2]uint8`.
15. **system_details (F2)** — statische Hardware/OS-Info aus eigener Collection (`getSystemDetails()`), Zugriff `systemScopedReadRule` wie system_stats. Nur wenn „System-Infos" an, selten geholt (Start + neues System, NICHT im 60s-Poll) und per `system.details` an die Registry gereicht.
16. **Dynamic-Group-Pruning (v0.7.2)** — `pruneDynamicChildren(base, activeIds, childType)` löscht verschwundene Mitglieder jeder dynamischen Gruppe (Sensoren, Cores, Interfaces, GPUs, Engines, Filesystems, Container). Kostenmodell: Object-View nur beim ERSTEN Poll je Gruppe nach Adapter-Start (Zombie-Reconcile), danach in-memory-Diff. Kein Prune ohne Daten (down-System mit `stats=undefined` fasst keine Gruppe an). Toggle-Wechsel = Instanz-Restart → Start-Cleanup (`cleanupMetrics`) deckt Toggle-offs, inkl. gpuDetails (power_package+engines je GPU via View-Enumeration).
17. **Poll-Write-Sparsamkeit (v0.7.2)** — `getLatestStats` bricht die Pagination ab, sobald eine Seite keinen neuen System-Key liefert (1m-Retention = 8 h ≙ 480 Records/System, der neueste je System liegt bei `sort=-updated` auf den ersten Seiten); Device-Objekt-`extendObject` nur bei geänderter id/host/name-Signatur.

## Metric-Toggles

Konfigurierbare Metriken (global für alle Systeme), gruppiert in Kategorien (System/CPU/Speicher/Disk/Netzwerk/Temperatur/GPU/Container/Akku). Standard-on: uptime, cpu, loadAvg, memory, disk, diskSpeed, network, temperature. Alle anderen default off. Jeder Schalter hat einen `help`-Text (was er anlegt). Alle Nicht-Basis-Schalter einer Kategorie hängen am Basis-/Usage-Häkchen (cpu/memory/disk/network/temperature/gpu): in der Admin via jsonConfig-`disabled` ausgegraut UND in der Datenlogik via `StateManager.METRIC_DEPENDENCIES`/`effectiveConfig` erzwungen — Kategorie aus → alle Unter-States werden nicht angelegt und bestehende beim Start geprunt (krobi 2026-06-02). Das schließt die default-on Co-Metriken `loadAvg` (→cpu) und `diskSpeed` (→disk) ein (Kategorie schaltet komplett ab, kein „logischer Ausreißer"). Nur die System-Kategorie (uptime/agentVersion/services) hat keinen Basis-Wert → ihre 3 Metriken sind unabhängig. Bestehende Schalter behalten internen Namen + Default → keine Migration. `metrics_agentVersion` ist jetzt „System-Infos" (Hardware/OS aus der `system_details`-Collection + Agent-Version).

## Tests (448 unit + 57 package + 1 integration = 506)

Tests leben neben dem Source als `src/**/*.test.ts` und laufen direkt via **vitest** (seit v0.5.0; vorher mocha+ts-node). Assertions im chai-Stil über vitests EINGEBAUTES chai-basiertes `expect` (globals) — kein chai-Import/devDep (v0.7.2: Phantom-Dependency entfernt).

## Befehle

```bash
npm run build         # Production (esbuild)
npm test              # vitest src/**/*.test.ts + @iobroker/testing packageFiles (mocha)
npm run coverage      # vitest run --coverage
npm run lint          # ESLint
npm run format:check  # Prettier --check
npm run check         # tsc --noEmit (Type-Check)
```
