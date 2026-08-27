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
13. **Metrik-Registry (K1)** — eine deklarative `metricDefs()`-Tabelle treibt sowohl `applyMetrics` (anlegen+setzen) als auch `cleanupMetrics` (löschen); `available(stats, system)` gated die Erstellung auf Daten-Präsenz (z.B. Peak-Felder, `system.details`) → kein leerer State auf älteren Beszel-Versionen, keine Create/Cleanup-Drift. Dynamische Gruppen (Sensoren/Lüfter/Akkus/GPU/Filesystems/Cores/Interfaces/Engines/Container) bleiben in `updateDynamicStats`/`updateContainers`.
14. **Version-Robustheit (v0.18.8-verifiziert)** — alle Felder durch Coercer (absent → null/skip), neue Felder `available`-gated. Datenmodell gegen die gebündelte Quelle geprüft (NICHT main): `os_name` ist snake_case, `os` numerisches Enum, Container-`net` = Bytes/s (Sent+Recv), `bat` = `[2]uint8`. Snapshot `Ressourcen/beszel/beszel-0.18.8/` (+ `VERIFIED-v0.18.8.md` mit dem 0.18.7→0.18.8-Delta); der 0.18.7-Snapshot bleibt als Referenz für Adapter ≤ v0.10.1 liegen.
15. **system_details (F2)** — statische Hardware/OS-Info aus eigener Collection (`getSystemDetails()`), Zugriff `systemScopedReadRule` wie system_stats. Nur wenn „System-Infos" an, selten geholt (Start + neues System, NICHT im 60s-Poll) und per `system.details` an die Registry gereicht.
16. **Dynamic-Group-Pruning (v0.7.2)** — `pruneDynamicChildren(base, activeIds, childType)` löscht verschwundene Mitglieder jeder dynamischen Gruppe (Sensoren, Lüfter, Akkus, Cores, Interfaces, GPUs, Engines, Filesystems, Container). Kostenmodell: Object-View nur beim ERSTEN Poll je Gruppe nach Adapter-Start (Zombie-Reconcile), danach in-memory-Diff. Kein Prune ohne Daten (down-System mit `stats=undefined` fasst keine Gruppe an). Toggle-Wechsel = Instanz-Restart → Start-Cleanup (`cleanupMetrics`) deckt Toggle-offs, inkl. gpuDetails (power_package+engines je GPU via View-Enumeration).
17. **Poll-Write-Sparsamkeit (v0.7.2)** — `getLatestStats` bricht die Pagination ab, sobald eine Seite keinen neuen System-Key liefert (1m-Retention = 8 h ≙ 480 Records/System, der neueste je System liegt bei `sort=-updated` auf den ersten Seiten); Device-Objekt-`extendObject` nur bei geänderter id/host/name-Signatur.
18. **Lüfter + Multi-Akku (v0.11.0, Beszel 0.18.8)** — beides sind normale dynamische Gruppen über `syncDynamicGroup` (Prune + H2-Entprellung inklusive). **Lüfter** = eigener Kanal `<sys>.fans` je System (NICHT unter `temperature`: eigene Agent-Quelle `agent/fans.go`, eigenes Hub-Diagramm), ein State je Lüfter, Einheit `rpm`, Rolle schlicht `value` — der Rollen-Katalog hat keine Rolle für gemessene Drehzahl (`value.speed` = Wind, `level.speed` = schreibbarer Stellwert). **0 rpm ist ein Messwert** (stehender Lüfter), kein Falsy-Filter. Eigener opt-in-Schalter `metrics_fans` ohne Kategorie-Abhängigkeit. **Multi-Akku** = `<sys>.battery.batteries.<name>` (Prozent, `value.battery`) neben den bestehenden Aggregat-States; **bewusst OHNE „nur ab 2 Akkus"-Schwelle** — eine Schwelle würde beim Wechsel 2→1 Akku die Kinder LÖSCHEN, was wie ein Fehler aussieht. Hängt am `metrics_battery`-Schalter, kein eigener.
19. **Datenpunkt-Zähler (v0.11.0)** — eine Info-Zeile pro Poll: „Object tree updated: created N datapoint(s), removed M datapoint(s)", still wenn sich nichts geändert hat. Grundlage ist `knownStateIds`: `snapshotExistingStates()` liest beim Start EINMAL alle vorhandenen States (Object-View) — **muss vor `cleanupMetrics` und dem ersten Poll laufen**. Nötig, weil `createAndSetState` bei JEDEM Neustart ein `extendObject`-Rollen-Retrofit fährt (Design 16/Rollen-Retrofit) und ohne Basislinie jeder Neustart alle States als „neu" melden würde. Gelöschte IDs verlassen das Set → ein Wiederauftauchen zählt wieder. Rekursive Löschungen (Kanal/Gerät/Gruppen-Kind) zählen per Object-View VOR dem Löschen. Zwei Sonderfälle: die Legacy-Migration ist bewusst AUSGENOMMEN (`deleteChannelIfExists(id, false)`) weil sie ihre eigene Summe meldet — nur ihr Marker zählt; die Rollup-States aus `writeRollup` melden sich per `noteStatesCreated()` selbst an, weil sie an `createAndSetState` vorbei entstehen.

## Metric-Toggles

Konfigurierbare Metriken (global für alle Systeme), gruppiert in Kategorien (System/CPU/Speicher/Disk/Netzwerk/Temperatur/**Lüfter**/GPU/Container/Akku). Standard-on: uptime, cpu, loadAvg, memory, disk, diskSpeed, network, temperature. Alle anderen default off. Jeder Schalter hat einen `help`-Text (was er anlegt). Alle Nicht-Basis-Schalter einer Kategorie hängen am Basis-/Usage-Häkchen (cpu/memory/disk/network/temperature/gpu): in der Admin via jsonConfig-`disabled` ausgegraut UND in der Datenlogik via `StateManager.METRIC_DEPENDENCIES`/`effectiveConfig` erzwungen — Kategorie aus → alle Unter-States werden nicht angelegt und bestehende beim Start geprunt (krobi 2026-06-02). Das schließt die default-on Co-Metriken `loadAvg` (→cpu) und `diskSpeed` (→disk) ein (Kategorie schaltet komplett ab, kein „logischer Ausreißer"). Nur die System-Kategorie (uptime/agentVersion/services) hat keinen Basis-Wert → ihre 3 Metriken sind unabhängig. Bestehende Schalter behalten internen Namen + Default → keine Migration. `metrics_agentVersion` ist jetzt „System-Infos" (Hardware/OS aus der `system_details`-Collection + Agent-Version).

20. **Kein System steht auf grün, wenn niemand liest (v0.12.x)** — `<sys>.info.online` trägt via `statusStates.onlineId` das Symbol am Geräteobjekt, und ioBroker hält den letzten Wert ewig. Der Marker wird an DREI Stellen gesetzt: `markAllOffline()` in `onReady` (arbeitet auf dem `snapshotExistingStates()`-Schnappschuss, schreibt nur existierende States — der einzige Teil, der auch nach Absturz/Stromausfall greift), `knownSystemIds()` im `onUnload` (synchron aus `resolvedSafeNames`, weil onUnload keine Objekt-Abfrage awaiten darf) und im Fehlerzweig von `poll()` (sofort beim ersten Fehlschlag, nicht entprellt — `info.connection` springt auch sofort um). Mit dabei: `info.status` → `SYSTEM_STATUS_UNKNOWN` und die Flotten-Zusammenfassung (`systemsOnline` 0, `systemsAllUp` false; `systemsTotal` bleibt). **`info.status` hat dafür einen FÜNFTEN Enum-Wert `unknown`** — die vier Hub-Werte kennen kein „niemand liest gerade"; die Liste steht einmal in `SYSTEM_STATUS_STATES` und wird auf Bestands-Objekten beim Start nachgezogen.
21. **`supportedMessages.stopInstance` ist RAUS — und wird beim Start im eigenen Instanzobjekt korrigiert (v0.12.1/0.12.2)** — mit dem Eintrag killt der Host den Prozess hart, `onUnload` läuft nie. Das Manifest zu säubern hilft nur Neuinstallationen: die Kopie im Instanzobjekt überlebt jedes Update. `clearStopInstanceFlag()` schreibt deshalb einmalig `stopInstance: false` (nur wenn gesetzt — jede Objekt-Änderung startet die Instanz neu, bedingungslos wäre eine Schleife) und gibt `true` zurück; **`onReady` bricht dann SOFORT ab**, sonst arbeitet der Prozess gegen die schon geschlossene Datenbank („DB closed", „Cannot find view … Connection is closed"). Ein Test in `main.test.ts` hält den Manifest-Eintrag draußen — Code kann eine Manifest-Eigenschaft nicht verteidigen. `onUnload` ruft den Rückruf erst nach den Schreibvorgängen (`.finally(callback)`), ohne eigenen Zeitgeber.

## Tests (565 unit + 57 package + 1 integration = 623)

Zusammensetzung: state-manager 235 · coerce 140 · main 70 · beszel-client 61 · message-router 16 · repo-standards 9 (aus `iobroker-adapter-checks` — die Zahl steigt mit dessen Version, 0.3.0 brachte eine Prüfung mehr) · i18n 7.

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
