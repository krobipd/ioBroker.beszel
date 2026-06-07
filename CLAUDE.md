# CLAUDE.md — ioBroker.beszel

> Gemeinsame ioBroker-Wissensbasis: `../CLAUDE.md` (lokal, nicht im Git). Standards dort, Projekt-Spezifisches hier.

## Projekt

**ioBroker Beszel Monitor** — Verbindet sich mit Beszel Hub (PocketBase) für Server-Monitoring.

- **Version:** 0.7.0 (optional Sentry → power-dreams; Vorgänger 0.6.0) (WIP) — Datensatz-Vervollständigung gegen verifizierte v0.18.7-Quelle (`Ressourcen/beszel/beszel-0.18.7/`): neue opt-in-Metriken (per-core, Peaks, Disk-I/O, pro-Schnittstelle), „System-Infos" via `system_details` (F2), Temperatur-Maximum (F7), Container-Netzwerk, GPU-Details; jsonConfig-Hilfetexte + Ausgrauen; F6 401-Reauth-Retry; K1-Registry; tote Deps/Code raus. **Noch kein Release.** Vorgänger **0.5.12** (released 2026-05-24) — setStateChangedAsync + compact-mode duplicate-error fix. Vorgänger **0.5.11** (Changelog rewritten in user-centric style across all versions — pre-release.py Checker mit TOOLING_REGEX_PATTERNS für Kategorie-basierte Dev-sprache-Erkennung). Vorgänger **0.5.10** (Injected delay for HTTP retry — repochecker S5051). Vorgänger **0.5.9** (CI Node 24). Vorgänger **0.5.8** (i18n-Migration auf adapter-core). Vorgänger **0.5.7** (released 2026-05-22) — Preserve user-modified state names. Vorgänger **0.5.6** (released 2026-05-22) — Community-standard handler pattern. Vorgänger **0.5.5** (released 2026-05-19) — NUT-Konsistenz. Vorgänger **0.5.4** (released 2026-05-18) — Internal cleanup: dead tsconfig settings entfernt (noEmitOnError, outDir, removeComments, sourceMap, inlineSourceMap — alle no-ops bei noEmit:true), dead `test/**/*.ts` include entfernt. Vorgänger **0.5.3** (released 2026-05-17) — **Auto-Migration komplett rausgenommen.** Govee-v2.11.0-Pattern war von Anfang an richtig: `encryptedNative` deklarieren, User re-saves im Admin, kein Migration-Code. Drei Hotfix-Releases (v0.5.0 manifest drift / v0.5.1 hotfix-incomplete / v0.5.2 heuristik fix + recovery) für genau Null Nutzen — Changelog von v0.5.2 sagt selber „please re-enter credentials". v0.5.3 löscht `src/lib/credential-migration.ts` + Tests komplett, `main.ts:onReady` ruft die Migration nicht mehr, die Config-Validierung gibt eine klare Fehlermeldung mit Hinweis auf den Admin-Re-Save. Test count 304→288 unit (13 migration tests + 3 corruption-recovery tests entfernt). User-Action nach Update auf v0.5.3 von einer Version < 0.5.0: einmalig Beszel-Einstellungen im Admin öffnen, username+password neu eingeben, speichern. - **Vorgänger 0.5.2** (released 2026-05-17) — Hotfix #2 für Migration-Loop aus v0.5.0/v0.5.1: meine `looksLikePlaintextUsername`-Heuristik kannte das tatsächliche js-controller-7-encrypt-Format `$/aes-192-cbc:<iv>:<ct>` NICHT (Memory `reference_iobroker_encrypted_credentials` ungelesen — Verstoß gegen `feedback_version_specific_source_verification`). Folge: bei jedem Restart wurde der bereits-encrypted-username FÄLSCHLICH als plaintext detected (weil `$/`, `:` Non-Hex sind) und re-encryptet → in jedem Zyklus eine neue Encryption-Schicht → eventuell >255 chars → PocketBase reject mit `validation_length_out_of_range`. v0.5.2 fixt die Heuristik (`$/aes-192-cbc:`-Prefix als Encrypted-Marker) und enthält Recovery-Code: `looksLikeCorruptedNestedEncryption(decryptedValue)` erkennt wenn `this.config.username` nach Framework-Auto-Decrypt immer noch mit dem Prefix beginnt → setzt `native.username` auf leer + logged `error` mit klarer User-Anweisung „Re-Enter im Admin". User-Action nach Update: einmalig Adapter-Einstellungen öffnen, username+password neu eingeben, speichern. **Vorgänger 0.5.1** (released 2026-05-17) — Hotfix: `encryptedNative`-Array in io-package.json war in v0.5.0 fälschlich nur `["password"]` (Edit-Tool meldete success, File-State persistierte nicht). Die in v0.5.0 eingeführte Auto-Migration encryptete den Klartext-Username + schrieb zurück, aber beim 2. Adapter-Start las das Framework den Wert unverschlüsselt zurück (weil username nicht in encryptedNative deklariert) → Auth bricht. v0.5.1 fixt das Manifest auf `["username", "password"]`. Existing-Installs (v0.5.0): beim ersten Start nach Update wird der bereits-encryptete-username-Wert korrekt auto-dekrypted, Migration skipt (Heuristik erkennt encrypted). v0.4.x→v0.5.1-Skipper laufen wie geplant durch die Auto-Migration.
- **Vorgänger 0.5.0** (released 2026-05-17) — Toolchain + Sicherheits-Hardening. Beszel-Hub-`username` wird jetzt verschlüsselt im Object-DB gespeichert (zusätzlich zum bereits encrypted `password`); eine einmalige Auto-Migration in `onReady` erkennt Klartext-User aus v0.4.x-Installationen via Heuristik (`@`/Whitespace/Nicht-Hex/ungerade Hex-Länge) und re-encryptiert mit `adapter.encrypt()`. README dokumentiert jetzt das `requestTimeout`-Feld (5-120s, default 15). `instanceObjects.common.name` für `info`/`info.connection`/`systems` werden deterministisch aus `src/lib/i18n-states.ts` generiert — neue `scripts/sync-iopackage-from-i18n.py` als Pre-commit-Hook macht Drift strukturell unmöglich (Hassemu-v1.32.2-B3-Pattern). Test-Runner mocha+ts-node → **vitest** (analog govee v2.6.4 / hassemu v1.32.0, ESM-Loader-Bug strukturell weg). Toolchain-Bump: TypeScript ~5.9.3 → **~6.0.3** + `@iobroker/eslint-config` 2.3.4 + `@iobroker/types` 7.1.2 + `@alcalzone/release-script` 5.2.0 (+ 2 Plugins). `tsconfig.json:types: ["vitest/globals", "node"]`. Code-Stil: `validateHubUrl`/`coercePollInterval`/`coerceTimeoutMs` von `private static`-Methoden in `main.ts` nach `lib/coerce.ts` extrahiert (testable als reine Funktionen); `coercePollInterval` jetzt mit Upper-Clamp 300s (matched admin/jsonConfig max — schützt gegen API-Direct-Sets); `deleteChannelIfExists` silent-catch ersetzt durch `debug`-Trace; `dispatchMessage`-`obj.message`-Härtung via `coerceObject` (Null/String/Array führen jetzt zu „missing fields" statt Throw). +30 unit-Tests (271→301): 14 für validateHubUrl/coercePollInterval/coerceTimeoutMs, 3 für dispatchMessage-obj.message-Härtung, 13 für credential-migration. **Vorgänger 0.4.5** (released 2026-05-14) — testClient cancelAll-Latency-Fix: short-lived `testClient` aus `checkConnection`-message wird via `this.testClients = new Set<BeszelClient>()` getrackt + im `onUnload` mit aborted. Vorher: `this.client.cancelAll()` aktiv aber testClient blieb hängen → konnte Adapter über js-controller's 4s-Kill-Deadline halten. `MessageRouterDeps` um `onTestClientCreated`/`onTestClientDone`-Hooks erweitert (test-lockable). 3 neue regression-tests in `message-router.test.ts` (register-then-deregister + finally-on-throw + missing-config skips both hooks). Test count 268→271. Cross-Adapter parallel zu parcelapp v0.4.4 (identisches Pattern). Identified during v0.4.4 audit als out-of-scope — Krobi-Korrektur: „nimm zusätzliche findings mit in den release", Lesson festgehalten in `feedback_low_ist_kein_skip` (Verstoß 4). v0.4.4 (2026-05-14) Debug-Coverage-Welle nach 9-Klassen-Audit (3114 LOC + 24 Sites). Score 3.8→9.0, 9/9 Klassen auf 9/10. Reine `log.debug`-Inserts plus optionaler `BeszelClientLogger`-Param (5. positional, class-member `this.log?`) + Architektur-Fix H4 (onMessage default-Branch) + `lib/message-router.ts`-Refactor für Test-Lockability + 6 message-router-Tests (262→268 unit). A0-A12 ohne A6 HTTPS-Trace; B1-B5 Token-Lifecycle; C1+C2 (warn bei MAX_PAGES); D1 429-retry-trace; E1+F1 Polling-Anchors; G1+G2+G4 state-manager; H1-H5 sendTo komplett inkl. H4 default-Branch; I1-I4 Lifecycle. Plus README header-icon raw→jsdelivr nicht nötig (svg-link existiert nicht im README — Logo via raw funktioniert für beszel SVG). v0.4.3 (released 2026-05-10) 26-Finding Hardening-Welle nach 4-Pass-Audit: B1 token-mutex (in-flight authPromise), B2 fetchAllPages pagination (PocketBase 200/500 cap weg), B3 429 transparent retry mit Retry-After, B4' 403 → distinct FORBIDDEN error class mit Hint, B5 admin requestTimeout (5–120s), B7 getLatestStats() simplified, B8 AbortController + cancelAll(), M1 process-handlers terminate(11), M2-M4 parallel cleanupMetrics+API+updateSystem, M5 validateHubUrl, M6 coercePollInterval (NaN-trap-fix), SM1-SM3 parallel cleanups+migration, SM4 defensive Set-iter, SM5 prepareForPoll mit Name-Kollision-Suffix, SM7 Math.floor(health), SM8 FS-percent-clamp, SM10 uptime-clamp, X1+X2 onUnload-cleanup. v0.4.2 (2026-05-09) Logs revert to English. v0.4.1 README-Whitespace-Hotfix. v0.4.0 Multi-Language + createdIds-Cache.
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
14. **Version-Robustheit (v0.18.7-verifiziert)** — alle Felder durch Coercer (absent → null/skip), neue Felder `available`-gated. Datenmodell gegen die gebündelte Quelle `Ressourcen/beszel/beszel-0.18.7/` geprüft (NICHT main): `os_name` ist snake_case, `os` numerisches Enum, Container-`net` = Bytes/s (Sent+Recv), `bat` = `[2]uint8`.
15. **system_details (F2)** — statische Hardware/OS-Info aus eigener Collection (`getSystemDetails()`), Zugriff `systemScopedReadRule` wie system_stats. Nur wenn „System-Infos" an, selten geholt (Start + neues System, NICHT im 60s-Poll) und per `system.details` an die Registry gereicht.

## Metric-Toggles

Konfigurierbare Metriken (global für alle Systeme), gruppiert in Kategorien (System/CPU/Speicher/Disk/Netzwerk/Temperatur/GPU/Container/Akku). Standard-on: uptime, cpu, loadAvg, memory, disk, diskSpeed, network, temperature. Alle anderen default off. Jeder Schalter hat einen `help`-Text (was er anlegt). Alle Nicht-Basis-Schalter einer Kategorie hängen am Basis-/Usage-Häkchen (cpu/memory/disk/network/temperature/gpu): in der Admin via jsonConfig-`disabled` ausgegraut UND in der Datenlogik via `StateManager.METRIC_DEPENDENCIES`/`effectiveConfig` erzwungen — Kategorie aus → alle Unter-States werden nicht angelegt und bestehende beim Start geprunt (krobi 2026-06-02). Das schließt die default-on Co-Metriken `loadAvg` (→cpu) und `diskSpeed` (→disk) ein (Kategorie schaltet komplett ab, kein „logischer Ausreißer"). Nur die System-Kategorie (uptime/agentVersion/services) hat keinen Basis-Wert → ihre 3 Metriken sind unabhängig. Bestehende Schalter behalten internen Namen + Default → keine Migration. `metrics_agentVersion` ist jetzt „System-Infos" (Hardware/OS aus der `system_details`-Collection + Agent-Version).

## Tests (347 unit + 57 package + 1 integration = 405)


Tests leben seit v0.3.7 neben dem Source als `src/lib/*.test.ts` und laufen direkt via **vitest** (seit v0.5.0; vorher mocha+ts-node, vitest löst den ESM-Loader-Bug strukturell und ist ~10× schneller).

```
src/lib/coerce.test.ts                → Boundary-Validator (Primitive + Beszel-Shapes) + errText + validateHubUrl + coercePollInterval/coerceTimeoutMs
src/lib/beszel-client.test.ts         → API Client (Auth, Token, Errors, Responses, API-Drift)
src/lib/state-manager.test.ts         → StateManager + Translation-Objects + createdIds-Cache
src/lib/i18n.test.ts                  → tName delegation + admin/i18n completeness (11 languages, identical keysets)
src/lib/message-router.test.ts        → dispatchMessage (default-Branch + obj.message-Härtung + test-client-Hooks)
test/package.js                       → @iobroker/testing Package-Tests
test/integration.js                   → @iobroker/testing Integration-Tests
```

Nicht getestet (bewusst): main.ts poll-Loop (Adapter-Lifecycle), onMessage (Callback-API).

## Versionshistorie (letzte 7)

| Version | Highlights |
|---------|------------|
| 0.7.0 | Optional Sentry error reporting (`common.plugins.sentry` → eigener power-dreams-Sentry; README-Badge + `## Sentry`-Abschnitt). |
| 0.6.0 (WIP) | **Datensatz-Vervollständigung gegen verifizierte v0.18.7-Quelle.** Neue opt-in-Metriken (per-core CPU, Peaks für CPU/RAM/Disk/Netzwerk, Disk-I/O-Last, pro-Schnittstelle), „System-Infos" (Hardware/OS aus `system_details`, F2), Temperatur-Maximum (F7), Container-Netzwerk, GPU-Details (Package-Power + Engines). jsonConfig: Hilfetexte je Schalter + Ausgrauen der Detail-Schalter. F6: 401-Reauth-Retry mitten im Poll. K1-Metrik-Registry (Create+Cleanup eine Tabelle). Tote Deps/Code raus (`ms`, `coerceBoolean`, `AuthResponse.record`). Repochecker E5612/W3042/W5005/W0083. Quelle gebündelt unter `Ressourcen/beszel/beszel-0.18.7/`. **Wert-Zuordnungs-Audit** (alle 60 States gegen v0.18.7-Quelle, `Ressourcen/beszel/v0.6.0-value-mapping-audit.md`): 2 Bugs gefixt — GPU-Speicher GB→MB (`gpu.go` BytesToMegabytes/MiB), battery.charging `bat[1]>0`→`===3` (6-Wert-Enum, discharging/full meldeten fälschlich charging). |
| 0.5.12 | Reduced unnecessary state-change events (setStateChangedAsync); compact-mode duplicate-error fix. |
| 0.5.11 | **Changelog user-centric rewrite.** Alle Einträge gegen `feedback_changelog_kompakt` geprüft, 20+ Dev-sprache-Einträge umgeschrieben. `pre-release.py` Checker um `TOOLING_REGEX_PATTERNS` erweitert (Kategorie-basiert: CI-internal, protocol-internal, framework-name, log-mechanic, test-count). |
| 0.5.10 | Injected delay for HTTP retry (repochecker S5051). |
| 0.5.9 | CI Node 24 (repochecker S3021). |
| 0.5.8 | i18n-Migration auf adapter-core. |
| 0.5.7 | Preserve user-modified state names. |

## Befehle

```bash
npm run build         # Production (esbuild)
npm test              # vitest src/**/*.test.ts + @iobroker/testing packageFiles (mocha)
npm run coverage      # vitest run --coverage
npm run lint          # ESLint
npm run format:check  # Prettier --check
npm run check         # tsc --noEmit (Type-Check)
```
