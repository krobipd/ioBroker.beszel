# CLAUDE.md — ioBroker.beszel

> Gemeinsame ioBroker-Wissensbasis: `../CLAUDE.md` (lokal, nicht im Git). Standards dort, Projekt-Spezifisches hier.

## Projekt

**ioBroker Beszel Monitor** — Verbindet sich mit Beszel Hub (PocketBase) für Server-Monitoring.

- **Version:** 0.5.7 (Preserve user-modified state names). Vorgänger **0.5.6** (released 2026-05-22) — Community-standard handler pattern. Vorgänger **0.5.5** (released 2026-05-19) — NUT-Konsistenz. Vorgänger **0.5.4** (released 2026-05-18) — Internal cleanup: dead tsconfig settings entfernt (noEmitOnError, outDir, removeComments, sourceMap, inlineSourceMap — alle no-ops bei noEmit:true), dead `test/**/*.ts` include entfernt. Vorgänger **0.5.3** (released 2026-05-17) — **Auto-Migration komplett rausgenommen.** Govee-v2.11.0-Pattern war von Anfang an richtig: `encryptedNative` deklarieren, User re-saves im Admin, kein Migration-Code. Drei Hotfix-Releases (v0.5.0 manifest drift / v0.5.1 hotfix-incomplete / v0.5.2 heuristik fix + recovery) für genau Null Nutzen — Changelog von v0.5.2 sagt selber „please re-enter credentials". v0.5.3 löscht `src/lib/credential-migration.ts` + Tests komplett, `main.ts:onReady` ruft die Migration nicht mehr, die Config-Validierung gibt eine klare Fehlermeldung mit Hinweis auf den Admin-Re-Save. Test count 304→288 unit (13 migration tests + 3 corruption-recovery tests entfernt). User-Action nach Update auf v0.5.3 von einer Version < 0.5.0: einmalig Beszel-Einstellungen im Admin öffnen, username+password neu eingeben, speichern. - **Vorgänger 0.5.2** (released 2026-05-17) — Hotfix #2 für Migration-Loop aus v0.5.0/v0.5.1: meine `looksLikePlaintextUsername`-Heuristik kannte das tatsächliche js-controller-7-encrypt-Format `$/aes-192-cbc:<iv>:<ct>` NICHT (Memory `reference_iobroker_encrypted_credentials` ungelesen — Verstoß gegen `feedback_version_specific_source_verification`). Folge: bei jedem Restart wurde der bereits-encrypted-username FÄLSCHLICH als plaintext detected (weil `$/`, `:` Non-Hex sind) und re-encryptet → in jedem Zyklus eine neue Encryption-Schicht → eventuell >255 chars → PocketBase reject mit `validation_length_out_of_range`. v0.5.2 fixt die Heuristik (`$/aes-192-cbc:`-Prefix als Encrypted-Marker) und enthält Recovery-Code: `looksLikeCorruptedNestedEncryption(decryptedValue)` erkennt wenn `this.config.username` nach Framework-Auto-Decrypt immer noch mit dem Prefix beginnt → setzt `native.username` auf leer + logged `error` mit klarer User-Anweisung „Re-Enter im Admin". User-Action nach Update: einmalig Adapter-Einstellungen öffnen, username+password neu eingeben, speichern. **Vorgänger 0.5.1** (released 2026-05-17) — Hotfix: `encryptedNative`-Array in io-package.json war in v0.5.0 fälschlich nur `["password"]` (Edit-Tool meldete success, File-State persistierte nicht). Die in v0.5.0 eingeführte Auto-Migration encryptete den Klartext-Username + schrieb zurück, aber beim 2. Adapter-Start las das Framework den Wert unverschlüsselt zurück (weil username nicht in encryptedNative deklariert) → Auth bricht. v0.5.1 fixt das Manifest auf `["username", "password"]`. Existing-Installs (v0.5.0): beim ersten Start nach Update wird der bereits-encryptete-username-Wert korrekt auto-dekrypted, Migration skipt (Heuristik erkennt encrypted). v0.4.x→v0.5.1-Skipper laufen wie geplant durch die Auto-Migration.
- **Vorgänger 0.5.0** (released 2026-05-17) — Toolchain + Sicherheits-Hardening. Beszel-Hub-`username` wird jetzt verschlüsselt im Object-DB gespeichert (zusätzlich zum bereits encrypted `password`); eine einmalige Auto-Migration in `onReady` erkennt Klartext-User aus v0.4.x-Installationen via Heuristik (`@`/Whitespace/Nicht-Hex/ungerade Hex-Länge) und re-encryptiert mit `adapter.encrypt()`. README dokumentiert jetzt das `requestTimeout`-Feld (5-120s, default 15). `instanceObjects.common.name` für `info`/`info.connection`/`systems` werden deterministisch aus `src/lib/i18n-states.ts` generiert — neue `scripts/sync-iopackage-from-i18n.py` als Pre-commit-Hook macht Drift strukturell unmöglich (Hassemu-v1.32.2-B3-Pattern). Test-Runner mocha+ts-node → **vitest** (analog govee v2.6.4 / hassemu v1.32.0, ESM-Loader-Bug strukturell weg). Toolchain-Bump: TypeScript ~5.9.3 → **~6.0.3** + `@iobroker/eslint-config` 2.3.4 + `@iobroker/types` 7.1.2 + `@alcalzone/release-script` 5.2.0 (+ 2 Plugins). `tsconfig.json:types: ["vitest/globals", "node"]`. Code-Stil: `validateHubUrl`/`coercePollInterval`/`coerceTimeoutMs` von `private static`-Methoden in `main.ts` nach `lib/coerce.ts` extrahiert (testable als reine Funktionen); `coercePollInterval` jetzt mit Upper-Clamp 300s (matched admin/jsonConfig max — schützt gegen API-Direct-Sets); `deleteChannelIfExists` silent-catch ersetzt durch `debug`-Trace; `dispatchMessage`-`obj.message`-Härtung via `coerceObject` (Null/String/Array führen jetzt zu „missing fields" statt Throw). +30 unit-Tests (271→301): 14 für validateHubUrl/coercePollInterval/coerceTimeoutMs, 3 für dispatchMessage-obj.message-Härtung, 13 für credential-migration. **Vorgänger 0.4.5** (released 2026-05-14) — testClient cancelAll-Latency-Fix: short-lived `testClient` aus `checkConnection`-message wird via `this.testClients = new Set<BeszelClient>()` getrackt + im `onUnload` mit aborted. Vorher: `this.client.cancelAll()` aktiv aber testClient blieb hängen → konnte Adapter über js-controller's 4s-Kill-Deadline halten. `MessageRouterDeps` um `onTestClientCreated`/`onTestClientDone`-Hooks erweitert (test-lockable). 3 neue regression-tests in `message-router.test.ts` (register-then-deregister + finally-on-throw + missing-config skips both hooks). Test count 268→271. Cross-Adapter parallel zu parcelapp v0.4.4 (identisches Pattern). Identified during v0.4.4 audit als out-of-scope — Krobi-Korrektur: „nimm zusätzliche findings mit in den release", Lesson festgehalten in `feedback_low_ist_kein_skip` (Verstoß 4). v0.4.4 (2026-05-14) Debug-Coverage-Welle nach 9-Klassen-Audit (3114 LOC + 24 Sites). Score 3.8→9.0, 9/9 Klassen auf 9/10. Reine `log.debug`-Inserts plus optionaler `BeszelClientLogger`-Param (5. positional, class-member `this.log?`) + Architektur-Fix H4 (onMessage default-Branch) + `lib/message-router.ts`-Refactor für Test-Lockability + 6 message-router-Tests (262→268 unit). A0-A12 ohne A6 HTTPS-Trace; B1-B5 Token-Lifecycle; C1+C2 (warn bei MAX_PAGES); D1 429-retry-trace; E1+F1 Polling-Anchors; G1+G2+G4 state-manager; H1-H5 sendTo komplett inkl. H4 default-Branch; I1-I4 Lifecycle. Plus README header-icon raw→jsdelivr nicht nötig (svg-link existiert nicht im README — Logo via raw funktioniert für beszel SVG). v0.4.3 (released 2026-05-10) 26-Finding Hardening-Welle nach 4-Pass-Audit: B1 token-mutex (in-flight authPromise), B2 fetchAllPages pagination (PocketBase 200/500 cap weg), B3 429 transparent retry mit Retry-After, B4' 403 → distinct FORBIDDEN error class mit Hint, B5 admin requestTimeout (5–120s), B7 getLatestStats() simplified, B8 AbortController + cancelAll(), M1 process-handlers terminate(11), M2-M4 parallel cleanupMetrics+API+updateSystem, M5 validateHubUrl, M6 coercePollInterval (NaN-trap-fix), SM1-SM3 parallel cleanups+migration, SM4 defensive Set-iter, SM5 prepareForPoll mit Name-Kollision-Suffix, SM7 Math.floor(health), SM8 FS-percent-clamp, SM10 uptime-clamp, X1+X2 onUnload-cleanup. v0.4.2 (2026-05-09) Logs revert to English. v0.4.1 README-Whitespace-Hotfix. v0.4.0 Multi-Language + createdIds-Cache.
- **GitHub:** https://github.com/krobipd/ioBroker.beszel
- **npm:** https://www.npmjs.com/package/iobroker.beszel
- **Repository PR:** ioBroker/ioBroker.repositories#5787
- **Runtime-Deps:** nur `@iobroker/adapter-core` (HTTP via Node.js built-in)
- **Test-Setup:** Tests unter `src/lib/*.test.ts` direkt via **vitest** (seit v0.5.0; vorher mocha+ts-node, vitest löst den ESM-Loader-Bug strukturell und ist ~10× schneller). `test/package.js` + `test/integration.js` bleiben mocha (`@iobroker/testing` ist mocha-only).
- **`@types/node` an `engines.node`-Min gekoppelt:** `^22.x` weil `engines.node: ">=22"`. Dependabot ignoriert Major-Bumps

## Architektur

```
src/main.ts                     → Adapter (Lifecycle, Polling, Message-Handler)
src/lib/beszel-client.ts        → HTTP Client (Auth, Systems, Stats, Containers)
src/lib/coerce.ts               → Boundary-Validator (NaN/Infinity/Typ-Drift) + errText + validateHubUrl + coercePollInterval/coerceTimeoutMs (v0.5.0 S1)
src/lib/state-manager.ts        → ioBroker States erstellen/updaten/cleanup, createdIds-Cache
src/lib/i18n.ts                 → tName(key) Wrapper über I18n.getTranslatedObject() (adapter-core I18n-Framework)
admin/i18n/<lang>.json          → Single-Source-of-Truth für UI- + State-Translations (99 Keys × 11 Sprachen)
src/lib/message-router.ts       → onMessage-Dispatcher (default-Branch-Contract, v0.4.5 testClient-Hooks)
src/lib/types.ts                → TypeScript Interfaces (API + Config)
../scripts/sync-iopackage-from-i18n.py → regeneriert io-package.json:instanceObjects.common.name aus admin/i18n/ (zentral, source: admin-i18n)
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

## Tests (289 unit + 57 package + 1 integration = 347)

Tests leben seit v0.3.7 neben dem Source als `src/lib/*.test.ts` und laufen direkt via **vitest** (seit v0.5.0; vorher mocha+ts-node, vitest löst den ESM-Loader-Bug strukturell und ist ~10× schneller).

```
src/lib/coerce.test.ts                → Boundary-Validator (Primitive + Beszel-Shapes) + errText + validateHubUrl + coercePollInterval/coerceTimeoutMs
src/lib/beszel-client.test.ts         → API Client (Auth, Token, Errors, Responses, API-Drift)
src/lib/state-manager.test.ts         → StateManager + Translation-Objects + createdIds-Cache
src/lib/message-router.test.ts        → dispatchMessage (default-Branch + obj.message-Härtung + test-client-Hooks)
test/package.js                       → @iobroker/testing Package-Tests
test/integration.js                   → @iobroker/testing Integration-Tests
```

Nicht getestet (bewusst): main.ts poll-Loop (Adapter-Lifecycle), onMessage (Callback-API).

## Versionshistorie (letzte 7)

| Version | Highlights |
|---------|------------|
| 0.5.7 | Preserve user-modified state names (`extendObjectAsync` with `preserve: { common: ["name"] }`). |
| 0.5.6 | Community-standard event handler pattern (.bind + try/catch). |
| 0.5.5 | **NUT-Konsistenz**: prettier ioBroker-Standard, dependabot double-quotes + TS-6-Kommentar, CI `fail_level: error`, `.releaseconfig.json` 2-Space, vitest `singleFork: false`, `translate`-Script. |
| 0.5.4 | Internal cleanup: dead tsconfig settings entfernt. |
| 0.5.3 | **Auto-Migration komplett raus.** Govee-Pattern (encryptedNative + User re-saves). |
| 0.5.2 | **Hotfix #2 Migration-Loop.** js-controller-7-encrypt-Format nicht erkannt. |
| 0.5.1 | **Hotfix.** `encryptedNative` Manifest-Fix auf `["username", "password"]`. |
| 0.5.0 | **Sicherheit + Toolchain.** username encrypted, vitest, TS 6.0.3. |
| 0.4.4 | **Debug-Coverage-Welle** nach 9-Klassen-Audit (3114 LOC + 24 Sites). Score 3.8→9.0, 9/9 Klassen auf 9/10. Reine `log.debug`-Inserts in 3 src-Files + optionaler `BeszelClientLogger`-Param (5. positional + class-member `this.log?`): A0 startedAt + A1-A12 (ohne A6) HTTPS-Layer inkl. body-snippet + cancelAll-inflight-count; B1-B5 Token-Lifecycle (in-flight-wait + fresh-auth + drift + invalidate); C1 multi-page-Trace + **C2 warn bei MAX_PAGES-Truncation** (data may be incomplete); D1 429-retry sleep+attempt; E1+F1 poll-anchors mit Cadence-Berechnung; G1 updateSystem state-tree entry; G2 cleanupMetrics summary; G4 migrateLegacyStates scan-start; I1-I4 Lifecycle inkl. always-log resolved timeoutMs + pollInterval; I4 onUnload-catch ersetzt silent ignore. Plus **H4 Architektur-Fix:** `switch (obj.command)` hatte keinen default-Branch → unknown commands ließen `obj.callback` ungerufen bis ioBroker-Timeout ~5s. Refactor in `lib/message-router.ts` als pure `dispatchMessage(obj, deps)`-Funktion + 6 Regression-Tests (default-branch contract + entry-log-position + checkConnection). Logger an beide BeszelClient-Sites (prod + testClient). Krobi-Pushback im Plan: erst „B+A geplant" verworfen weil Doppelarbeit, direkt A. Test count 262→268 unit |
| 0.4.3 | 26-Finding 4-Pass-Hardening: token-mutex (B1) + pagination (B2) + 429-retry+Retry-After (B3) + 403-distinct-class (B4') + configurable timeout (B5) + AbortController/cancelAll (B8); main-parallel API/updates/cleanup (M2-M4) + URL-validate (M5) + pollInterval NaN-fix (M6) + terminate(11) (M1); state-mgr-parallel cleanups/migration (SM1-SM3) + defensive Set-iter (SM4) + name-collision suffix via FNV-1a-hash (SM5) + container.health Math.floor (SM7) + FS-percent clamp (SM8) + uptime clamp (SM10); onUnload abort + explicit catch (X1+X2). Tests 253→262. **Hardcore-Regel angewandt — alle 26 Findings umgesetzt, kein Filter.** |
| 0.4.2 | Adapter logs zurück auf Englisch (mcm1957-Linie aus ioBroker.repositories#5667 — „log messages must be in english"). `lib/i18n-logs.ts` + `lib/i18n-logs.test.ts` gelöscht. 14 `tLog(...)`-Aufrufe in `main.ts` (12) und `state-manager.ts` (2) durch direkte EN-Template-Strings ersetzt. `systemLang`-Property aus `main.ts` und Constructor-Param aus `StateManager` entfernt — nicht mehr nötig, weil i18n-states via `tName()` Translation-Object liefert (Admin/vis machen Lookup automatisch). State-Namen in 11 Sprachen unverändert. |
| 0.4.1 | README-Whitespace-Hotfix: Leerzeile zwischen Changelog-Footer und `## Support` wiederhergestellt (alcalzone-Plugin hatte sie beim Rotieren in v0.4.0 gefressen). Fix-Hook `fix-changelog-footer.py` um Spacing-Normalisierung erweitert — fängt jetzt beide Bug-Varianten (fehlend + zusammengeklebt) |
| 0.4.0 | Multi-Language-Welle analog hassemu v1.28.0 / govee v2.6.0: `lib/i18n-logs.ts` (14 LOG_STRINGS × 11 Sprachen + tLog Helper), `lib/i18n-states.ts` (52 STATE_NAMES × 11 Sprachen + tName Helper). Alle State-Common-Factories auf `ioBroker.StringOrTranslated`, alle hardcoded EN-Strings via `tName('key')`. Lokaler `errText` aus main.ts in `lib/coerce.ts` zentralisiert (4 Inline-Patterns durch `errText`-Aufrufe ersetzt). `createdIds`-Set Cache spart pro Poll setObjectNotExistsAsync-Roundtrips. Baseline auf Node 22 + Admin >=7.8.23 + @types/node ^22.x + @tsconfig/node22, Deploy-Step PRE-EMPTIVE auf Node 24. *Log-Lokalisierung wurde in 0.4.2 zurückgebaut.* |
| 0.3.10 | Doku-Welle: Release-Notes für v0.3.3–v0.3.9 in user-friendly Stil über alle 11 Sprachen umgeschrieben |
| 0.3.9 | Doku-Cleanup, keine Code-Änderungen |
| 0.3.8 | Cleanup-Welle analog parcelapp v0.3.0: `format` + `format:check` npm-scripts, dependabot.yml ignore-Block, repochecker-version-gate Master-Snippet |
| 0.3.7 | Audit-Cleanup gegen ioBroker.example/TypeScript-Vollstandard: Test-Setup auf `src/lib/*.test.ts` + ts-node, dependabot ignore-Block für Major-Bumps |

## Befehle

```bash
npm run build         # Production (esbuild)
npm test              # vitest src/**/*.test.ts + @iobroker/testing packageFiles (mocha)
npm run coverage      # vitest run --coverage
npm run lint          # ESLint
npm run format:check  # Prettier --check
npm run check         # tsc --noEmit (Type-Check)
```
