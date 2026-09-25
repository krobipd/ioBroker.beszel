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
src/lib/i18n.ts                 → tName(key, ...args) + tDesc(key) über I18n.getTranslatedObject() (adapter-core I18n-Framework)
admin/i18n/<lang>.json          → Single-Source-of-Truth für UI- + State-Translations, Namen, Beschreibungen UND die Antworten des Verbindungstests (277 Keys × 11 Sprachen)
src/lib/native-key-migration.ts → Flotten-Master (byte-gleich): nullt entfernte native-Schlüssel beim Start (Design 66)
src/lib/message-router.ts       → onMessage-Dispatcher (default-Branch-Contract, v0.4.5 testClient-Hooks)
src/lib/types.ts                → TypeScript Interfaces (API + Config)
../scripts/sync-iopackage-from-i18n.py → regeneriert io-package.json:instanceObjects.common.name + .desc aus admin/i18n/ (zentral, source: admin-i18n)
docs/<en|de>/                   → Nutzerdoku im Repo (README/datapoints/faq), verlinkt in io-package.json:common.docs
```

## Design-Entscheidungen

_Jede Entscheidung steht hier als Regel-Satz; Beleg, Messung und Verlauf stehen wörtlich in `.claude/dev-history.md`, Eintrag „2026-09-21 — Design-Entscheidungen: Belege aus CLAUDE.md verlegt“ (lokal, gitignored)._

1. **HTTP über Node.js-Bordmittel** — (`node:http`/`node:https`) — der REST-Client braucht keinen externen HTTP-Client.
2. **Token in Memory** — nie in ioBroker States gespeichert; Erneuerung bei `min(exp − 5 min, Anmeldung + 23 h)` (JWT-Claim `exp`, ohne lesbares `exp` 23 h).
3. **Error-Dedup** — `classifyError` + `lastErrorCode`, wiederkehrende Fehler nur debug
4. **Auth-Backoff** — ab dem dritten Anmeldefehler Versuche im Abstand von 1, 2, 4 … Poll-Intervallen, gedeckelt bei 15 min; Reset bei Erfolg oder Neustart.
5. **Empty-Systems-Guard** — leere API-Antwort löscht NICHT alle Geräte (Baum + Zusammenfassung unangetastet, v0.13.0 krobi); davor greift Design 51.
6. **Metric-Cleanup** — deaktivierte Metriken werden beim Start gelöscht
7. **Channel-basierter State-Tree** — States in Channels organisiert (info, cpu, memory, disk, network, temperature, battery)
8. **Retired-State-Sweep (bis 0.17.1 Legacy-Migration)** — `removeRetiredStates()` löscht aus dem Start-Schnappschuss die Datenpunkte, die ein Release zurückgezogen hat (`RETIRED_STATE_IDS`; 0.18.0: die sechs Peaks — siehe Design 44 — und `info.uptime_text`, eine zweite …
9. **State-Common Factories** — `percentCommon`, `numCommon`, `textCommon`, `boolCommon` eliminieren Boilerplate
10. **Load-Avg Fallback** — `stats.la` bevorzugt, Fallback auf `system.info.la`
11. **Temperatur** — Durchschnitt der 3 heißesten Sensoren + heißester Einzelsensor (`temperature.max`, F7)
12. **Name-Sanitization** — lowercase, non-alphanumeric → `_`, max 50 chars; bleibt nichts übrig, wird die Id `sys_<shortHash(hubId)>` (eine WARN je Hub-Id).
13. **Metrik-Registry (K1)** — eine deklarative `metricDefs()`-Tabelle treibt sowohl `applyMetrics` (anlegen+setzen) als auch `cleanupMetrics` (löschen); `available(stats, system)` gated die Erstellung auf Daten-Präsenz (z.B. `dios`, …
14. **Version-Robustheit (v0.20.0-verifiziert)** — alle Felder durch Coercer (absent → null/skip), neue Felder `available`-gated.
15. **system_details (F2)** — Hardware/OS-Info aus eigener Collection (`getSystemDetails()`), Zugriff `systemScopedReadRule` wie system_stats.
16. **Dynamic-Group-Pruning (v0.7.2, entprellt 0.19.0)** — `pruneDynamicChildren(base, activeIds, childType)` löscht verschwundene Mitglieder jeder dynamischen Gruppe (Sensoren, Lüfter, Akkus, Cores, Interfaces, GPUs, Engines, Filesystems, Container, Pools, Units, Monitore) — ein Mitglied erst, wenn es in zwei aufeinanderfolgenden Polls fehlt.
17. **Poll-Write-Sparsamkeit (v0.7.2)** — `getLatestStats` bricht die Pagination ab, sobald eine Seite keinen neuen System-Key liefert (1m-Retention = **1 h ≙ 60 Records/System** — 0.19.0 `records_deletion.go`; die frühere Angabe „8 h/480" war falsch; der …
18. **Lüfter + Multi-Akku (v0.11.0, Beszel 0.18.8)** — beides sind normale dynamische Gruppen über `syncDynamicGroup` (Prune + H2-Entprellung inklusive). **Lüfter** = eigener Kanal `<sys>.fans` je System (NICHT unter `temperature`: eigene Agent-Quelle `agent/fans.go`, …
19. **Datenpunkt-Zähler (v0.11.0)** — eine Info-Zeile pro Poll: „Object tree updated: created N datapoint(s), removed M datapoint(s)", still wenn sich nichts geändert hat.

## Metric-Toggles

Konfigurierbare Metriken (global für alle Systeme), gruppiert in Kategorien (System/CPU/Speicher/Disk/Netzwerk/Temperatur/**Lüfter**/Speicherpools/SMART/GPU/Container/Akku/Netzwerk-Monitore). Standard-on: uptime, cpu, loadAvg, memory, disk, diskSpeed, network, temperature. Alle anderen default off. Jeder Schalter hat einen `help`-Text (was er anlegt). Alle Nicht-Basis-Schalter einer Kategorie hängen am Basis-/Usage-Häkchen (cpu/memory/disk/network/temperature/gpu): in der Admin via jsonConfig-`disabled` ausgegraut UND in der Datenlogik via `StateManager.METRIC_DEPENDENCIES`/`effectiveConfig` erzwungen — Kategorie aus → alle Unter-States werden nicht angelegt und bestehende beim Start geprunt (krobi 2026-06-02). Das schließt die default-on Co-Metriken `loadAvg` (→cpu) und `diskSpeed` (→disk) ein (Kategorie schaltet komplett ab, kein „logischer Ausreißer"). Die System-Kategorie hat keinen Basis-Wert: uptime/agentVersion/services sind unabhängig, nur servicesDetails hängt an services (ebenso zfsDetails an zfs); Lüfter, Akku, Container, SMART und Netzwerk-Monitore sind Einzelschalter. Bestehende Schalter behalten internen Namen + Default → keine Migration. `metrics_agentVersion` ist jetzt „System-Infos" (Hardware/OS aus der `system_details`-Collection + Agent-Version).

## Design-Entscheidungen (Fortsetzung)

_Jede Entscheidung steht hier als Regel-Satz; Beleg, Messung und Verlauf stehen wörtlich in `.claude/dev-history.md`, Eintrag „2026-09-21 — Design-Entscheidungen: Belege aus CLAUDE.md verlegt“ (lokal, gitignored)._

20. **Kein System steht auf grün, wenn niemand liest (v0.12.x)** — `<sys>.info.online` trägt via `statusStates.onlineId` das Symbol am Geräteobjekt, und ioBroker hält den letzten Wert ewig.
21. **`supportedMessages.stopInstance` ist RAUS — und wird beim Start im eigenen Instanzobjekt korrigiert (v0.12.1/0.12.2)** — mit dem Eintrag killt der Host den Prozess hart, `onUnload` läuft nie.
22. **Beenden ist kein Fehler (v0.13.0)** — `onUnload` setzt als Erstes `unloaded = true`; `cancelAll()` bricht danach die laufenden Anfragen ab, und diese Ablehnung („Request aborted", ohne Fehlercode) kam bisher als `Poll failed (UNKNOWN)` auf ERROR ins Log …
23. **Offline-Markierung VOR den Konfig-Prüfungen (v0.13.0)** — `makeStateManager` + `snapshotExistingStates` + `markAllOffline` laufen in `onReady` direkt nach `info.connection=false`, also BEVOR fehlende Zugangsdaten (der Upgrade-Fall „einmal neu eingeben") oder eine ungültige URL …
24. **IPv6-Adresse als Hub-URL (v0.13.0)** — `URL.hostname` liefert für `http://[fd00::1]:8090` den Wert `[fd00::1]` MIT Klammern; Nodes http-Client reicht ihn so an die Namensauflösung weiter → `getaddrinfo ENOTFOUND [fd00::1]` (gemessen an Node 22).
25. **Flotten-Zusammenfassung als statische `instanceObjects` (v0.13.0, krobi: „bau das um")** — `info.systemsTotal`/`systemsOnline`/`systemsAllUp` stehen im Manifest (Namen aus `admin/i18n` über `sync-iopackage-from-i18n.py`, dessen `name_mapping` die drei Schlüssel trägt) wie nut2s `info.upsTotal`-Trio.

26. **Namen und Beschreibungen erreichen BESTEHENDE Anlagen (v0.14.0)** — js-controller legt die `instanceObjects` des Manifests nur an, wo sie FEHLEN; `ensureChannel` benutzte `setObjectNotExists`, und `createAndSetState` schonte per `preserve` den alten `common.name`.
27. **`common.desc` = Erklärung, sonst DEKLARIERT stumm (v0.14.0, für jeden Datenpunkt entschieden 2026-09-07)** — 40 i18n-Schlüssel (`desc…`) in elf Sprachen, über `tDesc()` und das optionale `descKey` der `MetricDef` bzw. die `LEAF_COMMONS`-Tabelle verdrahtet.
28. **Einfrieren vs. Zurücksetzen vs. Entfernen, restart-fest (v0.14.0, erweitert 0.18.0)** — `applyMetrics` unterscheidet die Gründe, aus denen eine Metrik „nicht verfügbar" ist. **Kein Stats-Datensatz** (System down/paused) ⇒ nichts anfassen, die letzten Werte bleiben stehen — dieselbe Linie, der die …
29. **`info.legacyMigrated` ist ersatzlos entfallen (v0.14.0)** — der Marker sparte nur den Legacy-Scan (34 Einzelabfragen je System).

30. **Objekt-Auffrischung ≠ Wert-Schreiben (v0.14.1, LIVE-Fund)** — `applyMetrics` beantwortet zwei getrennte Fragen: gehört das OBJEKT in den Baum, und gibt es JETZT einen WERT.

31. **Hub-benannte Objekte tragen `native.nameSource: "api"` (v0.14.2)** — Sensoren, Lüfter, Akkus, GPU-Engines und die Kanäle von Interfaces, GPUs, Dateisystemen und Containern heißen, wie Hub, Agent oder Betriebssystem sie nennen: einsprachig, oft gleich ihrer Kennung (`acpitz`, `eth0`).
32. **Objekt-Inventar aus Fixtures (v0.14.2, Drahtform 0.20.0 seit 0.19.0)** — `npm run test:inventory` startet den Adapter im Wegwerf-Controller gegen einen Fake-Hub (`test/fixtures/inventory/hub.json` in der Drahtform eines Beszel-0.20.0-Hubs — json/v2-Nullen, `Info{}` bei pending/paused — mit elf Systemen über alle Geräteklassen; die vier ältesten behalten ihre Hub-Ids für die Aufstiegs-Suite); der Fake-Hub wertet `filter`/`sort`/`page`/`perPage` aus und antwortet auf einen unbekannten Filter mit 400; Poll-Intervall 10 s und Warten über zwei Polls, weil Mitglieder erst nach zwei Polls gehen.
33. **Beszel 0.19.0 (v0.15.0) + `upstream.json`** — Struct-Diff 0.18.8→0.19.0 (Snapshot `Ressourcen/beszel/beszel-0.19.0/`, `VERIFIED-v0.19.0.md`): vier REST-sichtbare Neuerungen, alle `available`-gated (älterer Hub erzeugt nichts).

34. **Der Start-Schnappschuss ist der EINZIGE Objekt-Lesevorgang (v0.16.0)** — `knownStateIds`, `knownChannelIds` und (neu) `knownDeviceIds` kommen aus dem einen `getObjectListAsync` in `snapshotExistingStates()` und werden ab da mitgeführt: `ensureChannel` und `updateSystem` tragen ein, …
35. **Eine gelöschte Gruppe bleibt gelöscht (v0.16.0, FEHLER)** — `knownChannelIds` wurde vom Schnappschuss gefüllt und nie wieder gepflegt.
36. **Ein gescheiterter Aufbauschritt kostet nicht den Poll-Timer (v0.16.0, FEHLER)** — die acht Schritte zwischen `I18n.init` und `setInterval` lagen in EINEM `try` um ganz `onReady`: ein abgelehnter Objektaufruf loggte eine Zeile und kehrte **vor** dem Timer zurück.
37. **Eine Tabelle für die dynamischen Blätter, aus der BEIDE Wege lesen (v0.16.0)** — `LEAF_COMMONS` + `DYNAMIC_LEAF_PATTERNS` + `leafCommon()` in der Registry lösen `DYNAMIC_LEAF_COMMONS` im Manager ab. Das war eine zweite Beschreibung der 29 Erzeugungspfade, zusammengehalten von einem Invariantentest, …
38. **`common.states` folgen der Systemsprache (v0.16.0)** — der Flottenstandard hat zwei Hälften: plain-string (sonst React #31) UND auf die Systemsprache aufgelöst. beszel hielt nur die erste.
39. **Container-Zustand ist ein Statusdatenpunkt (v0.16.0)** — `containers.<name>.health` trug Rolle `text` und keine Werteliste, während `info.status` und `zfs.<pool>.health` beides haben — ausgerechnet der Datenpunkt, dessen Werteliste der ADAPTER selbst erzeugt.
40. **Kanal-Aufräumung komplett tabellengetrieben (v0.16.0)** — `gpu`, `filesystems` und `containers` sind in `DYNAMIC_CHANNEL_TOGGLES` gewandert, die drei Unterkanäle in das neue `DYNAMIC_SUBCHANNEL_TOGGLES`; die sechs handgeschriebenen `if`-Zweige in `cleanupMetrics` sind weg.
41. **Typen statt Casts an der i18n-Grenze (v0.16.0)** — `i18n.ts` exportiert `I18nKey`; `MetricDef.nameKey`/`descKey` und `CHANNEL_NAME_KEY` tragen ihn, `channelName()` nimmt `ChannelKey` statt `string`.
42. **Die Test-Vorrichtungen leiten die Schalterliste ab (v0.16.0)** — `ALL_TOGGLES` kommt aus der Registry plus den beiden Toggle-Tabellen, nicht mehr aus einer Handliste.

43. **Die drei Detail-Collections (v0.17.0)** — `zfs_pools`, `smart_devices` und `systemd_services` waren die letzten Sammlungen des Hubs, die der Adapter nicht las.

44. **`b`/`dio` sind die Draht-Wahrheit, die Peaks liest der Adapter nicht (v0.18.0, korrigiert 0.19.0)** — der Agent setzt `ns/nr` auf Systemebene nicht mehr (`agent/network.go`); der Hub-Migrator `migrateDeprecatedFields` rechnet alte Werte nach `b`/`dio` um, nullt `ns/nr` und `dr/dw` (Letzteres seit 0.19.0 nur bei `dio == 0`); die Peak-Felder (`cpum`, `mm`, `drm`, `dwm`, `nsm`, `nrm`) stehen ab Hub 0.19.0 als 0 im REST-JSON des 1m-Datensatzes — der Adapter liest sie nicht.
45. **Hardware, die der Rechner nicht hat, bekommt keinen Datenpunkt (v0.18.0)** — `t` (Sensoren) ist eine omitempty-Map, `bat`, `s`/`su` und `mz` sind omitzero/omitempty: eine VM ohne Sensoren trug zwei dauerhafte Temperatur-Nulls (default-on), dazu Batterie-, Swap- und ARC-Nulls je Schalter. Seit Hub 0.19.0 (go1.27.1, `encoding/json/v2`) stehen `omitempty`-Zahlen und -Bools als 0/`false` auf dem Draht, nur `omitzero`-Felder fehlen — deshalb Wert-Gates statt Präsenz-Gates (`s > 0`, `mz > 0`, `mb > 0`, `u > 0`, GPU-Speicher `mt > 0`, GPU-Paketleistung `pp > 0`), die für Hubs vor 0.19.0 (Feld fehlt) genauso greifen.
46. **Lebende Sammlungen werden nur bei `up` abgeglichen; jedes gepollte System bekommt seine Liste (v0.18.0)** — der Hub sweept `containers` 10 min und `systemd_services` 20 min nach dem letzten Sample, ein Down-System antwortet danach mit einer ERFOLGREICHEN leeren Liste: nach zwei Polls waren alle Container-Kanäle weg, während …
47. **Geräte-Objekt: OS-Piktogramm, geprimte Signatur, kein `preserve` (v0.18.0)** — `common.icon` am Gerät `systems.<name>` nach dem Flotten-Rezept (`../CLAUDE_PATTERNS.md` § Geräte-Piktogramme): Inline `data:image/svg+xml;base64`-URI, `currentColor`/`none`, nur `path`/`circle`, 64er viewBox, …
48. **Zwei Lebenszyklus-Löcher und der Rest des Audits (v0.18.0)** — `onReady` bricht nach dem ersten Poll ab, wenn der Stop währenddessen kam (js-controller verweigert `setInterval` mit WARN, „started" wäre gelogen); `poll()` prüft `unloaded` auch nach den Detail-Fetches und vor dem …
49. **`info`-Datenpunkte eines nie/alt verbundenen Systems: sofort weg (v0.18.0, CI-Fund)** — die Aufstiegs-Suite (Lauf 34987545500) fand `backup_nas.cpu.load_*` als Leichen: 0.17.1 legte `cpu.load_*` für jedes System an, 0.18.0 gated sie auf `la` (`stats.la ?? info.la`), und das Down-System des Fixtures hat …
50. **Ein Platzhalter im gespeicherten Objekt braucht EINE Vollschreibung (v0.18.0, CI-Fund)** — die fünf ZFS-/SMART-Zähler trugen bis 0.17.1 `unit: ""`; 0.18.0 lässt das Feld weg (Q5).
51. **Eine leere Liste bei bekannten Systemen ist zuerst ein Token-Verdacht (0.19.0)** — PocketBase beantwortet ein totes Token (Passwortwechsel, gelöschter Benutzer, Secret-Reset, DB-Restore) mit 200/leer; der Adapter meldet sich einmal je Leer-Serie neu an und fragt erneut, bleibt die Liste leer, folgt EINE info-Zeile und Design 5.
52. **Anmeldefehler werden nach Klasse benannt (0.19.0)** — 400 ⇒ `AUTH_FAILED`, 401 mit `mfaId` ⇒ `MFA_REQUIRED`, 403 „not configured to allow password authentication“ ⇒ `PASSWORD_AUTH_DISABLED`, sonst 403 ⇒ `AUTH_FORBIDDEN`; alle vier laufen durch Design 4, der 401-Wiederholversuch holt immer erst ein Token.
53. **Die Hub-URL wird einmal normalisiert und überall gleich geprüft (0.19.0)** — trim + Schrägstriche ab, abgelehnt werden Query, Fragment und Zugangsdaten in der URL (ein Pfad bleibt: Reverse-Proxy); Instanz und Verbindungstest nutzen dieselbe Prüfung, Logs zeigen die URL ohne userinfo.
54. **Eine gekürzte Liste ist ein Fehler, kein vollständiger Lesevorgang (0.19.0)** — erreicht das Blättern `MAX_PAGES` (50) mit weiteren Datensätzen, wirft der Client `TRUNCATED`, die Aufrufer frieren ein statt zu prunen; Listen lesen 1000 je Seite (PocketBase-Maximum), die Stats-Wanderungen 200.
55. **Jede Anfrage hat eine Gesamtfrist (0.19.0)** — `timeoutMs` gilt für die ganze Anfrage, nicht nur als Inaktivitätsgrenze; geprüft im `data`-Handler, kein eigener Timer; nach `cancelAll` lehnt der Client jede neue Anfrage sofort ab.
56. **`paused`/`pending` frieren die `info`-Werte ein (0.19.0)** — der Hub schickt für beide `info = Info{}` (lauter Nullen); Definitionen mit `readsInfo` werden bei diesen Status weder geschrieben noch entfernt.
57. **Gruppen-Ids gehören dem ersten Besitzer, Container-Suffixe hängen am Namen (0.19.0)** — `resolveGroupIds` vergibt eine Kollisions-Id zuerst an den bisherigen Besitzer, dann nach kleinstem Schlüssel; Container-Kollisionen werden über den Namen aufgelöst, weil die Container-Id bei jedem Re-Create wechselt.
58. **Umbenennen und Entfernen am Hub werden gemeldet (0.19.0)** — dieselbe Hub-Id unter neuem Namen ⇒ info „System renamed on the Hub: systems.a → systems.b“, ein entferntes System ⇒ info, eine Übernahme eines freien Namens ⇒ info.
59. **btrfs läuft als Speicherpool in der ZFS-Gruppe (0.19.0, Beszel 0.20.0)** — Kanal-Id aus dem stabilen Schlüssel (`b:<UUID>`), Name aus `n`/`display_name`, Blätter `pool_type` und `raw`; bei `raw` gibt es kein `disk_percent`; interne Namen `zfs.*`/`metrics_zfs` bleiben.
60. **Pool-Details nur für aktive Pools, Scrub nur mit Scrub-Datensatz (0.19.0)** — die 15-min-Details schreiben nur Pools, die die Summary im selben Poll führt; ohne `scrub` im Datensatz (btrfs, nie gescrubbt) gibt es keine Scrub-Blätter; `NONE` ist kein Scrub-Zustand.
61. **SMART: Temperatur und Kapazität 0 heißen unbekannt (0.19.0)** — wie in der Beszel-UI; `power_on_hours`/`power_cycles` 0 bleiben Werte; Wertelisten mit `WARNING`/`UNKNOWN` (eMMC/md-RAID).
62. **Netzwerk-Monitore (0.19.0, Beszel 0.20.0)** — eigener Schalter, Standard aus; `network_monitors` jeder Poll plus der jüngste 1m-Datensatz je Monitor aus `network_monitor_stats`; Kanal-Id aus Protokoll + Ziel (+ Port bei tcp), Antwortzeiten µs → ms, 0 ⇒ leer, leeres `updated` ⇒ nie gemessen.
63. **`containers.updatable` wird `update_available` (0.19.0, Beszel 0.20.0)** — nur angelegt, wenn der Hub die Spalte liefert; `false` heißt „kein Update bekannt“.
64. **Kurze Ausfälle sind ein Zustand, keine Warnung (0.19.0, Flottenregel 2026-09-22)** — `NETWORK`/`TIMEOUT` loggen auf debug unter einem gemeinsamen Dedup-Schlüssel, „Connection restored“ danach ebenfalls; warn bleibt für Anmelde-, HTTP-, TLS-, Antwort- und Kürzungsfehler.
65. **Eine 404 der Hub-URL heißt „falsche Adresse“ (0.19.0, Sonde am echten Hub)** — antwortet die Adresse ohne Beszel-API (Reverse-Proxy-Pfad vergessen, anderer Dienst am Port), nennt das Log den URL-Hinweis auf warn und der Verbindungstest `msgHubNotFound` statt des rohen 404-JSON.
66. **Entfernte `native`-Schlüssel werden beim Start genullt (0.19.0, B02 Runde 38)** — `src/lib/native-key-migration.ts` + Test byte-gleich vom Flotten-Master, `NATIVE_KEY_MIGRATIONS` droppt die vier Peak-Schalter von 0.17.x; ein Schreibvorgang beendet den Start (die Instanz startet neu).

## Tests (906 unit + 61 package + 1 integration + 3 inventory)

Zusammensetzung (gemessen 2026-09-25 nach der Umsetzung des Audits 2026-09-25, `vitest run`):
state-manager 391 · coerce 161 · main 143 · beszel-client 96 · repo-standards 29 (aus
`iobroker-adapter-checks` — die Zahl steigt mit dessen Version) · message-router 21 · native-key-migration 18 · err-text 15 ·
inventory 13 · device-icons 12 · i18n 7. Das D10-Maß `vitest list --json --staticParse=false` zählt
ebenfalls 906 (darunter 18 Tests des Flotten-Helfers `native-key-migration`). Mutationstabelle der Welle:
`mutations_beszel_2026-09-25.py` (W1–W88, 87 gefangen, W32 begründet äquivalent); D09-Nadeldeckung seit v0.18.0 vollständig. Deckung **99,4 % Stmts · 97,9 % Branch · 97,8 % Funcs**; offen bleiben nur die
Bootstrap-/Test-Nähte in `main.ts` (Client-/Manager-Fabriken, `require.main`, `setStateSafe`-Catch)
und der dokumentiert unerreichbare Hostname-Wächter in `validateHubUrl`. Der https-Transport ist
über ein eingebettetes, selbst signiertes Testzertifikat (gültig bis 2126) geprüft. Das Inventar
hat drei Suiten: Inventar, Aufstiegs-Suite (mit `INVENTORY_PREVIOUS`) und älterer Hub (404 auf
`zfs_pools` und die Monitor-Sammlungen).

Tests leben neben dem Source als `src/**/*.test.ts` und laufen direkt via **vitest** (seit v0.5.0; vorher mocha+ts-node). Assertions im chai-Stil über vitests EINGEBAUTES chai-basiertes `expect` (globals) — kein chai-Import/devDep (v0.7.2: Phantom-Dependency entfernt).

## Befehle

```bash
npm run build         # Production (esbuild)
npm test              # vitest src/**/*.test.ts + @iobroker/testing packageFiles (mocha)
npm run test:inventory  # Adapter gegen Fake-Hub starten, test/objects.inventory.json erzeugen (Design 32)
                        # danach `python3 ../scripts/check-object-inventory.py --adapter-dir .` (D08, Design 27)
npm run coverage      # vitest run --coverage
npm run lint          # ESLint
npm run format:check  # Prettier --check
npm run check         # tsc --noEmit (Type-Check)
```

## Prettier-Ausschlüsse

Die Ausschlussliste der Skripte `format`/`format:check` ist Flottenstandard und steht in EINER Quelle
(`FORMAT_SCRIPTS_FLEET` in `../scripts/audit-krobi-consistency.py`, Regel `../CLAUDE_PACKAGES.md`,
Hinweis `../CLAUDE_TEMPLATES.md` § `package.json`) — nie von Hand ändern. Keine `.prettierignore`
(W0084 + W5048). `.remember/` steht in der `.gitignore`, Prettier überspringt es dadurch von selbst.
