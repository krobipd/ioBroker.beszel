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
admin/i18n/<lang>.json          → Single-Source-of-Truth für UI- + State-Translations, Namen UND Beschreibungen (194 Keys × 11 Sprachen)
src/lib/message-router.ts       → onMessage-Dispatcher (default-Branch-Contract, v0.4.5 testClient-Hooks)
src/lib/types.ts                → TypeScript Interfaces (API + Config)
../scripts/sync-iopackage-from-i18n.py → regeneriert io-package.json:instanceObjects.common.name + .desc aus admin/i18n/ (zentral, source: admin-i18n)
docs/<en|de>/                   → Nutzerdoku im Repo (README/datapoints/faq), verlinkt in io-package.json:common.docs
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
19. **Datenpunkt-Zähler (v0.11.0)** — eine Info-Zeile pro Poll: „Object tree updated: created N datapoint(s), removed M datapoint(s)", still wenn sich nichts geändert hat. Grundlage ist `knownStateIds`: `snapshotExistingStates()` liest beim Start EINMAL alle vorhandenen States (Object-View) — **muss vor `cleanupMetrics` und dem ersten Poll laufen**. Nötig, weil `createAndSetState` bei JEDEM Neustart ein `extendObject`-Rollen-Retrofit fährt (Design 16/Rollen-Retrofit) und ohne Basislinie jeder Neustart alle States als „neu" melden würde. Gelöschte IDs verlassen das Set → ein Wiederauftauchen zählt wieder. Rekursive Löschungen (Kanal/Gerät/Gruppen-Kind) zählen per Object-View VOR dem Löschen. Ein Sonderfall: die Legacy-Migration ist bewusst AUSGENOMMEN (`deleteChannelIfExists(id, false)`), weil sie ihre eigene Summe meldet — seit v0.14.0 ist auch ihr Marker weg (Design 29), gezählt wird nur noch dessen einmalige Entfernung. Die drei Rollup-States sind seit v0.13.0 statische `instanceObjects` (Design 25) und liegen damit von Anfang an im Start-Schnappschuss.

## Metric-Toggles

Konfigurierbare Metriken (global für alle Systeme), gruppiert in Kategorien (System/CPU/Speicher/Disk/Netzwerk/Temperatur/**Lüfter**/GPU/Container/Akku). Standard-on: uptime, cpu, loadAvg, memory, disk, diskSpeed, network, temperature. Alle anderen default off. Jeder Schalter hat einen `help`-Text (was er anlegt). Alle Nicht-Basis-Schalter einer Kategorie hängen am Basis-/Usage-Häkchen (cpu/memory/disk/network/temperature/gpu): in der Admin via jsonConfig-`disabled` ausgegraut UND in der Datenlogik via `StateManager.METRIC_DEPENDENCIES`/`effectiveConfig` erzwungen — Kategorie aus → alle Unter-States werden nicht angelegt und bestehende beim Start geprunt (krobi 2026-06-02). Das schließt die default-on Co-Metriken `loadAvg` (→cpu) und `diskSpeed` (→disk) ein (Kategorie schaltet komplett ab, kein „logischer Ausreißer"). Nur die System-Kategorie (uptime/agentVersion/services) hat keinen Basis-Wert → ihre 3 Metriken sind unabhängig. Bestehende Schalter behalten internen Namen + Default → keine Migration. `metrics_agentVersion` ist jetzt „System-Infos" (Hardware/OS aus der `system_details`-Collection + Agent-Version).

20. **Kein System steht auf grün, wenn niemand liest (v0.12.x)** — `<sys>.info.online` trägt via `statusStates.onlineId` das Symbol am Geräteobjekt, und ioBroker hält den letzten Wert ewig. Der Marker wird an DREI Stellen gesetzt: `markAllOffline()` in `onReady` (arbeitet auf dem `snapshotExistingStates()`-Schnappschuss, schreibt nur existierende States — der einzige Teil, der auch nach Absturz/Stromausfall greift), `knownSystemIds()` im `onUnload` (synchron aus `resolvedSafeNames`, weil onUnload keine Objekt-Abfrage awaiten darf) und im Fehlerzweig von `poll()` (sofort beim ersten Fehlschlag, nicht entprellt — `info.connection` springt auch sofort um). Mit dabei: `info.status` → `SYSTEM_STATUS_UNKNOWN` und die Flotten-Zusammenfassung (`systemsOnline` 0, `systemsAllUp` false; `systemsTotal` bleibt). **`info.status` hat dafür einen FÜNFTEN Enum-Wert `unknown`** — die vier Hub-Werte kennen kein „niemand liest gerade"; die Liste steht einmal in `SYSTEM_STATUS_STATES` und wird auf Bestands-Objekten beim Start nachgezogen.
21. **`supportedMessages.stopInstance` ist RAUS — und wird beim Start im eigenen Instanzobjekt korrigiert (v0.12.1/0.12.2)** — mit dem Eintrag killt der Host den Prozess hart, `onUnload` läuft nie. Das Manifest zu säubern hilft nur Neuinstallationen: die Kopie im Instanzobjekt überlebt jedes Update. `clearStopInstanceFlag()` LÖSCHT deshalb den ganzen Schlüssel (`supportedMessages: null`) und korrigiert, sobald er ÜBERHAUPT existiert — nicht nur bei gesetztem `stopInstance` (v0.14.1, Design 30); es gibt `true` zurück; **`onReady` bricht dann SOFORT ab**, sonst arbeitet der Prozess gegen die schon geschlossene Datenbank („DB closed", „Cannot find view … Connection is closed"). Ein Test in `main.test.ts` hält den Manifest-Eintrag draußen — Code kann eine Manifest-Eigenschaft nicht verteidigen. `onUnload` ruft den Rückruf erst nach den Schreibvorgängen (`.finally(callback)`), ohne eigenen Zeitgeber.
22. **Beenden ist kein Fehler (v0.13.0)** — `onUnload` setzt als Erstes `unloaded = true`; `cancelAll()` bricht danach die laufenden Anfragen ab, und diese Ablehnung („Request aborted", ohne Fehlercode) kam bisher als `Poll failed (UNKNOWN)` auf ERROR ins Log (Sentry meldet das) plus einer Runde Offline-Schreibvorgänge und einer Container-Warnung über die letzten Schreibvorgänge von `onUnload` hinweg. Jetzt: `handlePollError` und `fetchContainersSafe` enden bei gesetztem Flag mit debug, und ein Poll, dessen Antworten erst nach dem Beenden eintreffen, verwirft sein Ergebnis (`if (this.unloaded) return` direkt nach dem `Promise.all`).
23. **Offline-Markierung VOR den Konfig-Prüfungen (v0.13.0)** — `makeStateManager` + `snapshotExistingStates` + `markAllOffline` laufen in `onReady` direkt nach `info.connection=false`, also BEVOR fehlende Zugangsdaten (der Upgrade-Fall „einmal neu eingeben") oder eine ungültige URL den Start abbrechen. Vorher lagen sie hinter diesen Rückgaben, und genau in den Fällen, in denen der Adapter nichts lesen kann, blieben alle Systeme grün (Design 20 galt nur für den Weg mit gültiger Konfiguration). nut2 hat dieselbe Reihenfolge (Marker vor dem Host-Check).
24. **IPv6-Adresse als Hub-URL (v0.13.0)** — `URL.hostname` liefert für `http://[fd00::1]:8090` den Wert `[fd00::1]` MIT Klammern; Nodes http-Client reicht ihn so an die Namensauflösung weiter → `getaddrinfo ENOTFOUND [fd00::1]` (gemessen an Node 22). `hostnameForRequest()` entfernt die Klammern wie `url.urlToHttpOptions`; Test mit echtem Server auf `::1`. `validateHubUrl` und `isPlaintextRemoteUrl` kamen damit schon zurecht.
25. **Flotten-Zusammenfassung als statische `instanceObjects` (v0.13.0, krobi: „bau das um")** — `info.systemsTotal`/`systemsOnline`/`systemsAllUp` stehen im Manifest (Namen aus `admin/i18n` über `sync-iopackage-from-i18n.py`, dessen `name_mapping` die drei Schlüssel trägt) wie nut2s `info.upsTotal`-Trio. Vorher lazy beim ersten erfolgreichen Poll angelegt: eine Neuinstallation mit nicht erreichbarem Hub hatte sie gar nicht, und Beenden-/Fehlerpfad mussten mit `rollupCreated` raten, ob sie schon existieren. Jetzt schreiben beide Pfade bedingungslos, `writeRollup` schreibt nur noch Werte, und ein Manifest-Test hält die drei Objekte (Typ/Rolle/Default) fest. Bestandsinstallationen: die vorhandenen Objekte werden beim Update aus dem Manifest ergänzt, Werte bleiben.

26. **Namen und Beschreibungen erreichen BESTEHENDE Anlagen (v0.14.0)** — js-controller legt die
    `instanceObjects` des Manifests nur an, wo sie FEHLEN; `ensureChannel` benutzte
    `setObjectNotExists`, und `createAndSetState` schonte per `preserve` den alten `common.name`.
    Alle drei Wege froren den Text ein, mit dem eine Anlage einmal angelegt wurde — eine
    korrigierte Übersetzung erreichte nur Neuinstallationen, und kein Gate sah es (nur der
    Live-Baum). Jetzt: `ensureInstanceObjects()` in `onReady` erneuert alle sechs Manifest-Objekte
    per `extendObject` (ohne `preserve`), `ensureChannel` schreibt per `extendObject`, und
    `createAndSetState` verzichtet auf `preserve`. **Einzige Ausnahme ist das GERÄTE-Objekt** — sein
    Name ist der Systemname vom Hub, und ein Hub-seitiges Umbenennen erzeugt ohnehin eine neue
    sanitisierte id, also ein neues Objekt; `preserve` schützt dort nur eine Umbenennung des
    Nutzers und blockiert nichts, was der Adapter ausliefert. Preis der Umstellung: eine vom Nutzer
    in der Admin vergebene Datenpunkt-Umbenennung wird beim nächsten Start überschrieben
    (krobi 2026-09-03).
27. **`common.desc` = Erklärung, sonst leer (v0.14.0)** — 24 i18n-Schlüssel (`desc…`) in elf
    Sprachen, über `tDesc()` und das neue optionale `descKey` der `MetricDef` verdrahtet. Sie
    hängen an genau den Datenpunkten, deren Bedeutung man nicht raten kann: Mittel der drei
    heißesten Sensoren, Spitzenwert im Aggregationsintervall, `io_util` und die beiden
    `io_await`-Werte (gegen `agent/disk.go` der gebündelten 0.18.8-Quelle geprüft: Anteil der
    Zeit mit mindestens einer offenen Anfrage bzw. Durchschnittsdauer EINER Operation, wie
    `iostat` r_await/w_await), kumulative Interface-Summen, `battery.charging`, Container-`health`,
    `power_package`, Root-Dateisystem, systemd-Einheiten, Buffers/ZFS-ARC, `cpu.steal`/`iowait`.
    Alle übrigen Datenpunkte tragen bewusst KEINE Beschreibung.
28. **Einfrieren vs. Zurücksetzen, restart-fest (v0.14.0)** — `applyMetrics` unterscheidet jetzt die
    beiden Gründe, aus denen eine Metrik „nicht verfügbar" ist. **Kein Stats-Datensatz** (System
    down/paused) ⇒ nichts anfassen, die letzten Werte bleiben stehen — dieselbe Linie, der die
    dynamischen Gruppen schon folgten. **Datensatz da, FELD fehlt** (`dios`/`cpub` sind
    omitzero/omitempty) ⇒ auf `null` zurücksetzen, und zwar über `knownStateIds` statt nur
    `createdIds`: der Cache ist nach jedem Neustart leer, deshalb hörte das Zurücksetzen bisher
    still auf zu wirken und der alte Messwert stand unbegrenzt. Vorher waren beide Fälle vertauscht
    abhängig davon, ob der Adapter zwischendurch neu gestartet war.
29. **`info.legacyMigrated` ist ersatzlos entfallen (v0.14.0)** — der Marker sparte nur den
    Legacy-Scan (34 Einzelabfragen je System). Seit v0.11.0 liest `snapshotExistingStates()` beim
    Start ohnehin einmal alles und läuft VOR der Migration, also entscheidet der Sweep jetzt aus
    dem Schnappschuss: null zusätzliche Abfragen, und der Marker ist überflüssig. Er wurde
    obendrein von JEDER Neuinstallation angelegt, obwohl er nur einem Upgrade von vor 0.3.0 diente.
    Der Schnappschuss liest dafür per `getObjectListAsync` States UND Kanäle in EINEM Aufruf (statt
    einer state-View), damit auch der eine Legacy-Kanal ohne Objektabfrage erkannt wird. Auf
    Bestandsanlagen wird der Datenpunkt beim Start gelöscht und in der Datenpunkt-Bilanz gemeldet.

30. **Objekt-Auffrischung ≠ Wert-Schreiben (v0.14.1, LIVE-Fund)** — `applyMetrics` beantwortet zwei
    getrennte Fragen: gehört das OBJEKT in den Baum, und gibt es JETZT einen WERT. Vorher hingen sie
    zusammen, und ein System ohne Messwert fiel komplett aus dem Durchlauf — mit ihm die
    Namens-/Beschreibungs-Auffrischung. Am echten Baum gefunden: 24 Objekte der zwei offline-Systeme
    trugen nach dem 0.14.0-Update noch die alten festen Namen, während jedes statische Gate grün war.
    Jetzt: `ensureStateObject` frischt das Objekt immer auf, `createAndSetState` schreibt zusätzlich
    den Wert. Ein nie angelegter Datenpunkt entsteht weiterhin nicht (`createdIds`/`knownStateIds`).
    Dasselbe eine Ebene tiefer: `refreshDynamicObjects()` läuft im `else`-Zweig von
    `if (stats)` und frischt die adapter-benannten Blätter der dynamischen Gruppen
    (`DYNAMIC_LEAF_COMMONS`) plus die Gruppen-Kanäle aus dem Start-Schnappschuss auf — ohne Daten,
    ohne Prune, ohne Wert. Hub-benannte Objekte (Sensor-/Container-/GPU-/Dateisystem-/Interface-Namen)
    bleiben bewusst außen vor: ohne Daten nicht rekonstruierbar, und ein Adapter-Update ändert sie
    ohnehin nicht. **`DYNAMIC_LEAF_COMMONS` ist eine zweite Beschreibung der Erzeugungspfade** —
    dagegen hält ein Invarianten-Test, der ein voll bestücktes System abläuft und jeden
    adapter-benannten Datenpunkt nennt, der in der Tabelle fehlt (am echten Defekt bewiesen).

31. **Hub-benannte Objekte tragen `native.nameSource: "api"` (v0.14.2)** — Sensoren, Lüfter, Akkus,
    GPU-Engines und die Kanäle von Interfaces, GPUs, Dateisystemen und Containern heißen, wie Hub,
    Agent oder Betriebssystem sie nennen: einsprachig, oft gleich ihrer Kennung (`acpitz`, `eth0`).
    Der Marker sagt das dem Flotten-Inventar-Gate am Objekt selbst (krobi 2026-09-04: „als API ist
    in diesem legitim"); ohne ihn wären diese Namen ein Fund „fester String statt
    Übersetzungsobjekt". Ein Übersetzungsobjekt daraus zu bauen hieße, EINEN Text elfmal zu
    behaupten. Bestandsanlagen bekommen den Marker beim nächsten Start per `extendObject`.
32. **Objekt-Inventar aus Fixtures (v0.14.2)** — `npm run test:inventory` startet den Adapter im
    Wegwerf-Controller gegen einen Fake-Hub (`test/fixtures/inventory/hub.json`: ein voll
    bestücktes Linux-System mit jeder Metrikgruppe von Beszel 0.18.8 plus ein System `down`,
    alle Schalter an) und schreibt `test/objects.inventory.json` im Format des
    Objektstruktur-Bots; deterministisch (zwei Läufe byte-gleich). `src/inventory.test.ts` hält
    das Inventar gegen die Metrik-Registry (jeder Datenpunkt, jede dynamische Gruppe, jede
    Beschreibung als Übersetzungsobjekt, jeder feste Name als API-Name). Der Release-Vorlauf
    prüft das Inventar mit Bot- und Flottenregeln und beweist mit dem Inventar des Vorgänger-Tags
    (`INVENTORY_PREVIOUS`), dass ein Update jedes bestehende Objekt erreicht — ohne Server.
33. **Beszel 0.19.0 (v0.15.0) + `upstream.json`** — Struct-Diff 0.18.8→0.19.0 (Snapshot
    `Ressourcen/beszel/beszel-0.19.0/`, `VERIFIED-v0.19.0.md`): vier REST-sichtbare Neuerungen, alle
    `available`-gated (älterer Hub erzeugt nichts). (a) `stats.z` → Gruppe `zfs.<pool>/` (opt-in
    `metrics_zfs`, eigener Schalter wie Lüfter): `disk_percent/used/total` (GiB wie die Root-Disk,
    Label GB), `read_speed/write_speed` (Bytes/s → MB/s MiB-basiert; `omitzero` = ruhend = 0, nicht
    unbekannt), `health` (zpool-Wort, Rolle `info.status`, `common.states` als Hinweis, nie Filter);
    Pool-Kanal API-benannt. (b) `stats.diot` → `disk.total_read/total_write` (GB, am I/O-Schalter).
    (c) `efs.*.tr/tw` → `filesystems.<fs>.total_read/total_write` (nur wenn geliefert). (d) `info.rdn`
    → `disk.name`. `usedPercent()` (SM8) teilen Dateisysteme und Pools. Die Detail-Collection
    `zfs_pools` (scrub, vdevs, datasets) blieb hier zunächst ungelesen wie `smart_devices` und
    `systemd_services` — **mit v0.17.0 erledigt, siehe Design 43**. **`upstream.json`** (`github:henrygd/beszel`, `verified`, `watch`,
    `snapshot`) ist die Deklaration für das Release-Gate A12: eine neuere Beszel-Freigabe blockt das
    Release mit Notes + Diff, bis die Sichtung gemacht und `verified` gehoben ist — Anlass: 0.14.2
    ging raus, während 0.19.0 zwei Tage alt war. Mutationstabelle `mutations_beszel_2026-09-05.py`
    (13, alle gefangen; Z4/Z5 überlebten zuerst → Aufräum-Test + Invarianten-Abdeckung für `zfs`).

34. **Der Start-Schnappschuss ist der EINZIGE Objekt-Lesevorgang (v0.16.0)** — `knownStateIds`,
    `knownChannelIds` und (neu) `knownDeviceIds` kommen aus dem einen `getObjectListAsync` in
    `snapshotExistingStates()` und werden ab da mitgeführt: `ensureChannel` und `updateSystem`
    tragen ein, `dropCacheUnder` trägt aus. Jede spätere Frage „gibt es dieses Objekt" wird daraus
    beantwortet — `cleanupMetrics`, `deleteChannelIfExists`, `noteStatesRemovedUnder`, der
    Gruppen-Abgleich in `pruneDynamicChildren` und `getExistingSystemNames`. Vorher fragte der
    Adapter die Objektdatenbank erneut nach dem, was er gerade gelesen hatte: **43
    `getObjectAsync` je System und Start** bei Standardkonfiguration, dazu eine View je dynamischer
    Gruppe und eine je Poll für die Geräteliste. Der einzige blinde Fleck ist eine Löschung von
    Hand in der Admin während der Laufzeit — den hatte der `createdIds`-Cache vorher genauso, und
    der nächste Start gleicht ihn ab.
35. **Eine gelöschte Gruppe bleibt gelöscht (v0.16.0, FEHLER)** — `knownChannelIds` wurde vom
    Schnappschuss gefüllt und nie wieder gepflegt. `refreshDynamicObjects` fand dort jeden
    Gruppenkanal wieder, den `cleanupMetrics` oder die Drop-auf-null-Prune gerade gelöscht hatte,
    und legte ihn per `extendObject` **leer wieder an** — auf jedem System ohne Messwert, nach
    jedem Neustart erneut, und nur dort: erreichbare Systeme liefen über `updateDynamicStats` und
    hatten den Kanal nicht. Zwei Wege dorthin: Schalter aus, und ohne jede Konfigurationsänderung
    eine Gruppe, die im Betrieb auf null fällt. Behoben, indem `dropCacheUnder` die Kanal- und
    Gerätebuchhaltung mitführt; Regressionstests decken beide Wege ab.
36. **Ein gescheiterter Aufbauschritt kostet nicht den Poll-Timer (v0.16.0, FEHLER)** — die acht
    Schritte zwischen `I18n.init` und `setInterval` lagen in EINEM `try` um ganz `onReady`: ein
    abgelehnter Objektaufruf loggte eine Zeile und kehrte **vor** dem Timer zurück. Der Prozess
    lief weiter, pollte nie wieder, und js-controller startet einen lebenden Daemon nicht neu.
    Jetzt läuft jeder Schritt über `setupStep()` (fängt, loggt, macht weiter), und die
    Systemschleife der Aufräumung hat Einzelschutz wie die des Polls. **`I18n.init` bleibt hart**
    (ohne Übersetzungen erreicht jeder Name als roher Schlüssel den Baum), und die beiden
    Konfigurationsabbrüche — fehlende Zugangsdaten, ungültige URL — enden weiterhin ohne Timer.
37. **Eine Tabelle für die dynamischen Blätter, aus der BEIDE Wege lesen (v0.16.0)** —
    `LEAF_COMMONS` + `DYNAMIC_LEAF_PATTERNS` + `leafCommon()` in der Registry lösen
    `DYNAMIC_LEAF_COMMONS` im Manager ab. Das war eine zweite Beschreibung der 29 Erzeugungspfade,
    zusammengehalten von einem Invariantentest, der nur die ABDECKUNG prüfte (hat jedes Blatt einen
    Eintrag) und nie die GLEICHHEIT (baut der Eintrag denselben common). Der Ersatztest ersetzt einen
    Tabelleneintrag durch einen Sentinel und verlangt, dass Erzeugung **und** Auffrischung ihn
    ausliefern — nach der fakeroku-Lehre, dass eine gestrichene Aufrufzeile Gate, Linter und
    Typprüfung grün lässt.
38. **`common.states` folgen der Systemsprache (v0.16.0)** — der Flottenstandard hat zwei Hälften:
    plain-string (sonst React #31) UND auf die Systemsprache aufgelöst. beszel hielt nur die erste.
    `systemStatusStates()`, `zfsHealthStates()` und `containerHealthStates()` sind jetzt Funktionen
    über `tState()` (= `I18n.translate`, liefert den plain string der Systemsprache); 17 Schlüssel in
    elf Sprachen. Die KEYS bleiben die technischen Werte, die im State stehen. Dazu der vom Standard
    geforderte Regressionstest über alle drei Werteliste-Fabriken.
39. **Container-Zustand ist ein Statusdatenpunkt (v0.16.0)** — `containers.<name>.health` trug Rolle
    `text` und keine Werteliste, während `info.status` und `zfs.<pool>.health` beides haben —
    ausgerechnet der Datenpunkt, dessen Werteliste der ADAPTER selbst erzeugt. Jetzt Rolle
    `info.status` + `common.states`; `CONTAINER_HEALTH_LABELS` und `containerHealthLabel()` liegen
    neben ihren zwei Geschwistern in der Registry statt inline in einer I/O-Methode.
40. **Kanal-Aufräumung komplett tabellengetrieben (v0.16.0)** — `gpu`, `filesystems` und `containers`
    sind in `DYNAMIC_CHANNEL_TOGGLES` gewandert, die drei Unterkanäle in das neue
    `DYNAMIC_SUBCHANNEL_TOGGLES`; die sechs handgeschriebenen `if`-Zweige in `cleanupMetrics` sind
    weg. Ein Ende-zu-Ende-Test schaltet alles ab und verlangt, dass unter dem System nur noch der
    `info`-Kanal steht — ein neuer dynamischer Kanal ohne Aufräumregel fällt dort auf, statt einen
    siebten Zweig zu brauchen.
41. **Typen statt Casts an der i18n-Grenze (v0.16.0)** — `i18n.ts` exportiert `I18nKey`;
    `MetricDef.nameKey`/`descKey` und `CHANNEL_NAME_KEY` tragen ihn, `channelName()` nimmt
    `ChannelKey` statt `string`. Ein unbekannter Kanal reichte vorher `undefined` an adapter-core,
    das still `{ en: undefined }` antwortet — und das Flotten-Gate sieht es nicht, weil der
    Schlüssel berechnet ist. Jetzt ist es ein Compilefehler. Die drei Casts sind weg.
42. **Die Test-Vorrichtungen leiten die Schalterliste ab (v0.16.0)** — `ALL_TOGGLES` kommt aus der
    Registry plus den beiden Toggle-Tabellen, nicht mehr aus einer Handliste. Die Handliste hatte
    `metrics_diskIo` nie gelernt, weshalb DREI Tests „legt nichts an, wenn der Schalter aus ist"
    gegen einen `undefined`-Schalter liefen und nichts prüften. Dazu die Invariante
    **Manifest ↔ Admin-UI ↔ Code**: die drei Schalterlisten müssen deckungsgleich sein.

43. **Die drei Detail-Collections (v0.17.0)** — `zfs_pools`, `smart_devices` und
    `systemd_services` waren die letzten Sammlungen des Hubs, die der Adapter nicht las.
    Alle drei tragen dieselbe Leseregel wie `system_stats` (`systemScopedReadRule`,
    `internal/hub/collections.go` der gebündelten 0.19.0), die Zugangsdaten reichen also.
    Drei neue Schalter: **`metrics_zfsDetails`** (hängt an `metrics_zfs`) für Scrub-Status,
    Vdev-Fehlerzähler und Datasets je Pool · **`metrics_smart`** (eigenständig, wie Lüfter
    und ZFS: eigene Agent-Quelle) für das SMART-Gesamturteil samt Temperatur, Kapazität,
    Betriebsstunden und Einschaltvorgängen · **`metrics_servicesDetails`** (hängt an
    `metrics_services`) für Zustand, Unterzustand, CPU und Speicher je systemd-Unit.
    **Zwei Taktarten:** `systemd_services` schreibt der Hub bei JEDER Agent-Messung neu,
    also wird es wie die Container in jedem Poll gelesen; `zfs_pools` frischt der Hub etwa
    stündlich auf (`system_zfs.go:zfsFetchInterval`) und `smart_devices` noch seltener —
    beide laufen deshalb über `DETAIL_REFRESH_MS` (15 min). **`SystemExtras`** trägt die
    drei Listen je System: ein FEHLENDES Feld heißt „diese Runde nicht gelesen" und lässt
    die Datenpunkte stehen, eine LEERE Liste heißt „nichts da" und räumt auf — dieselbe
    Unterscheidung wie `containersAvailable`. Die Enums werden als WORT geschrieben
    (`active`, `running`), nicht als die Zahl des Hubs; `attributes` der SMART-Tabelle
    bleibt bewusst ungelesen (herstellerspezifischer Blob, dessen Schlüssel je Gerät
    anders heißen — ein Adapter benennt keine Datenpunkte, die er nicht erklären kann).
    Die Pool-Ebene prunt weiterhin ALLEIN der Minutentakt aus `stats.z`: zwei Pruner auf
    einer Basis würden sich um jeden Pool streiten, den der andere noch nicht gesehen hat.

## Tests (685 unit + 58 package + 1 integration + 1 inventory = 745)

Zusammensetzung (gemessen 2026-09-06 nach den drei Detail-Collections): state-manager 314 · coerce 158 · main 102 · beszel-client 70 · message-router 16 · repo-standards 12 · i18n 7 · inventory 6 (aus `iobroker-adapter-checks` — die Zahl steigt mit dessen Version). Deckung **99,2 % Stmts · 98,6 % Branch · 97,1 % Funcs**; `src/lib` 100 % Funktionen, `state-manager.ts` 100 % Zeilen. Was offen bleibt, ist unerreichbar (https-Transport ohne TLS-Server, `?? ""` auf einer garantiert gesetzten Map-Id) oder Test-Seam/Bootstrap in `main.ts`.

Tests leben neben dem Source als `src/**/*.test.ts` und laufen direkt via **vitest** (seit v0.5.0; vorher mocha+ts-node). Assertions im chai-Stil über vitests EINGEBAUTES chai-basiertes `expect` (globals) — kein chai-Import/devDep (v0.7.2: Phantom-Dependency entfernt).

## Befehle

```bash
npm run build         # Production (esbuild)
npm test              # vitest src/**/*.test.ts + @iobroker/testing packageFiles (mocha)
npm run test:inventory  # Adapter gegen Fake-Hub starten, test/objects.inventory.json erzeugen (Design 32)
npm run coverage      # vitest run --coverage
npm run lint          # ESLint
npm run format:check  # Prettier --check
npm run check         # tsc --noEmit (Type-Check)
```

## Prettier-Ausschlüsse (v0.16.0)

`npm run format:check` ist seit dem Vollaudit 0 — nach dem Flotten-Rezept in drei Klassen aufgeräumt
(`reference_prettier_vs_consistency_master`). Drei Dateien tragen ein Ausschlussmuster im
`format`/`format:check`-Skript, **keine `.prettierignore`** (die meldet der Repochecker als veraltete
Konfigurationsdatei, W0084 + W5048) — genau die Liste, die das Rezept nennt:

| Datei                    | Grund                                                                                                                                                    |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `build/**`               | esbuild-Ausgabe, unversioniert                                                                                                                           |
| `io-package.json`        | Release-Skript, `sync-iopackage-from-i18n.py` und der Konsistenz-Autofix schreiben aufgeklapptes JSON; Prettier will kurze Arrays einzeilig — nie stabil |
| `.github/dependabot.yml` | Bot-Format mit einfachen Anführungszeichen, Flottenentscheid 2026-07-01                                                                                  |

`README.md` und `CHANGELOG_OLD.md` sind **nicht** ausgeschlossen, obwohl sie das Release-Skript
schreibt: `executeCleanupStage` setzt den Platzhalter als `changelogBefore.trimEnd() + "\n" +
"### **WORK IN PROGRESS**"`, also ohne die Leerzeile, die Prettier zwischen HTML-Kommentar und
Überschrift verlangt (`@alcalzone/release-script-plugin-changelog`, `build/index.js:248`; dieselbe
Form für CHANGELOG_OLD in Zeile 230). Nach jedem Release meldet `format:check` diese eine Zeile
darum erneut. Das ist ein Fund am Flotten-Werkzeug, kein Grund, die Datei im Adapter aus dem
eigenen Gate zu nehmen — nachformatieren, nicht ausschließen.

`.remember/` steht seit v0.16.0 in der `.gitignore` (Kratzverzeichnis des Notiz-Hooks, nie
Repo-Inhalt) — damit überspringt Prettier es von selbst; es war nur sichtbar, weil Prettier die
verschachtelte `.gitignore` darin nicht liest.

`tsconfig.json`, `tsconfig.build.json` und `.vscode/settings.json` kamen aus dem Konsistenz-Master
und standen noch im alten Vorlagen-Format (Tabs, aufgeklappte Arrays). Der Master ist längst
prettier-sauber — der Adapter ist nachgezogen (`tsc --showConfig` vorher/nachher identisch). Das
Konsistenz-Gate sah die Drift nicht, weil es JSON **semantisch** vergleicht; das ist Absicht, kein
Loch.
