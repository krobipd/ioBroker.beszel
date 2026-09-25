# ioBroker.beszel — Benutzerdokumentation

Dieser Adapter spiegelt einen [Beszel](https://beszel.dev)-Hub nach ioBroker. Beszel ist ein
schlanker Server-Monitor: auf den überwachten Maschinen laufen kleine Agenten, die an einen
zentralen Hub melden; der Adapter liest diesen Hub über seine REST-Schnittstelle und legt pro
überwachtem System ein Gerät an.

Alles ist rein lesend. Der Adapter schreibt nie zum Hub und legt keine beschreibbaren Datenpunkte an.

- [Datenpunkte und Metrik-Schalter](datapoints.md)
- [Fragen und Fehlersuche](faq.md)

## Voraussetzungen

Sie brauchen einen laufenden Beszel-Hub mit mindestens einem verbundenen Agenten und eine
Anmeldung für diesen Hub. Der Adapter meldet sich als normaler Beszel-Benutzer an — mit derselben
E-Mail-Adresse und demselben Passwort wie in der Beszel-Weboberfläche; einen Benutzernamen nimmt
Beszel dort nicht an. Ein Administratorkonto ist nicht nötig, die Mehr-Faktor-Anmeldung muss für
diesen Benutzer aber aus sein: den Einmal-Code kann der Adapter nicht beantworten.

Der Benutzer sieht nur die Systeme, denen er zugeordnet ist: die er selbst angelegt hat, die ein
Hub-Administrator ihm zugeordnet hat (PocketBase-Verwaltung unter `/_/`, Sammlung `systems`, Feld
`users`), oder alle, wenn der Hub mit `SHARE_ALL_SYSTEMS=true` läuft. Ein Benutzer ohne Zuordnung
meldet sich problemlos an und sieht eine leere Liste — der Verbindungstest sagt das.

## Einrichtung

1. **Installieren und Instanz anlegen.** In ioBroker `beszel` installieren und die
   Instanz-Einstellungen öffnen.
2. **Hub-Adresse eintragen** unter _Beszel Hub URL_ — dieselbe Adresse, mit der Sie die
   Beszel-Weboberfläche öffnen, zum Beispiel `http://192.168.1.100:8090`. Eine IPv6-Adresse steht
   in eckigen Klammern: `http://[fd00::1]:8090`. `http` und `https` funktionieren beide; ein
   https-Hub braucht ein Zertifikat, dem der ioBroker-Rechner vertraut. Ein Hub hinter einem
   Reverse-Proxy behält seinen Pfad (`https://example.org/beszel`). Leerzeichen und ein
   abschließender Schrägstrich werden entfernt; eine Adresse mit `?`, `#` oder Benutzername und
   Passwort darin wird abgelehnt.
3. **E-Mail und Passwort** Ihrer Beszel-Anmeldung eintragen.
4. **Auf _Test Connection_ drücken.** Es wird eine echte Anmeldung am Hub durchgeführt; die
   Antwort nennt, wie viele Systeme Ihr Benutzer sieht — oder bei einem Problem den tatsächlichen
   Fehler: abgelehnte Anmeldung, nicht erreichbarer Host, Tippfehler in der Adresse.
5. **Metriken auswählen** im Reiter _Metrics_ (siehe
   [Datenpunkte und Metrik-Schalter](datapoints.md)). Voreingestellt sind Laufzeit, CPU,
   Lastmittel, Arbeitsspeicher, Festplatte, Festplattendurchsatz, Netzwerk und Temperatur. Alles
   andere ist aus, bis Sie es einschalten.
6. **Speichern.** Die Instanz startet, liest den Hub einmal und legt den Objektbaum an.

## Abfrageintervall und Zeitlimit

_Poll Interval_ nimmt 10 bis 300 Sekunden, voreingestellt 60. Die Beszel-Agenten zeichnen einen
Messwert pro Minute auf; ein Wert unter 60 Sekunden erzeugt also zusätzliche Anfragen ohne neuere
Daten. Ein Wert außerhalb dieses Bereichs — etwa von einem Skript direkt in die Konfiguration
geschrieben — wird begrenzt statt übernommen.

_Request timeout_ (5 bis 120 Sekunden, voreingestellt 15) ist die Zeit, die eine einzelne Anfrage
dauern darf. Bei langsamer Verbindung oder einem Hub mit sehr vielen Containern erhöhen.

## Was der Adapter anlegt

```
beszel.0.
├── info.connection      ist der Hub erreichbar
├── info.systemsTotal    am Hub registrierte Systeme
├── info.systemsOnline   davon auf „up"
├── info.systemsAllUp    wahr, solange alle auf „up" stehen
└── systems.<name>.      ein Gerät je überwachtem System
```

Der Gerätename ist der Systemname vom Hub, kleingeschrieben und mit `_` für alles, was kein
Buchstabe und keine Ziffer ist. Zwei Systeme, deren Namen auf dieselbe Kennung zusammenfallen,
bekommen ein kurzes Hash-Anhängsel, damit sie sich nicht gegenseitig überschreiben — der Adapter
weist einmal im Protokoll darauf hin. Ein Name ohne lateinischen Buchstaben und ohne Ziffer
(Kyrillisch, Chinesisch, …) wird zu `sys_` plus einem kurzen Hash der System-Id des Hubs und bleibt
so über Neustarts gleich.

Wird ein System am Hub umbenannt, wandert es auf eine neue Geräte-Kennung: der Adapter meldet
`System renamed on the Hub: systems.a → systems.b`, und der alte Baum geht — mit Historie und
anderen Einstellungen an seinen Datenpunkten. Ein am Hub entferntes System wird ebenso gemeldet.

## Wie sich der Adapter verhält, wenn etwas fehlt

- **Ein System geht aus oder ist pausiert.** `info.online` wird falsch und `info.status` zeigt, was
  der Hub meldet. Die Messwerte bleiben auf dem letzten Stand stehen, statt auf null zu springen —
  der Adapter berichtet, was er weiß, und er weiß gerade nichts Neues.
- **Der Hub ist nicht erreichbar.** `info.connection` wird falsch, jedes System geht auf
  `info.online: false` und `info.status: unknown`, die Flottenzähler fallen auf null. Dasselbe
  passiert beim Stoppen der Instanz — nichts behauptet weiter „online", während niemand liest.
- **Der Hub antwortet mit einer leeren Liste.** Es wird nichts gelöscht. PocketBase beantwortet
  eine Anmeldung, die es nicht mehr annimmt (geändertes Passwort, gelöschter Benutzer,
  zurückgespielte Hub-Datenbank), mit einer leeren Liste statt mit einem Fehler — deshalb meldet
  sich der Adapter zuerst neu an und fragt noch einmal. Bleibt die Liste leer, bleibt der Baum,
  wie er ist, und das Protokoll sagt einmal, dass der Benutzer keine Systeme sieht.
- **Die Anmeldung wird abgelehnt.** Das Protokoll nennt den Grund — falsche E-Mail oder falsches
  Passwort, Mehr-Faktor-Anmeldung, oder Passwort-Anmeldung am Hub abgeschaltet. Nach drei
  Fehlversuchen versucht es der Adapter in wachsenden Abständen, höchstens alle 15 Minuten, statt
  bei jeder Abfrage das Passwort zu schicken.
- **Ein Sensor, Lüfter, eine GPU, ein Dateisystem, Container oder ein anderes Gruppenmitglied
  verschwindet.** Die zugehörigen Datenpunkte werden entfernt, sobald es in zwei aufeinander
  folgenden Abfragen fehlt — ein einzelner Aussetzer räumt nichts ab.
- **Eine Liste ist länger, als der Adapter liest.** Der Adapter liest höchstens 50 Seiten je Liste
  (bei den Listen der Systeme, Container, Units und Geräte je 1000 Einträge). Auf einem Hub, der
  groß genug ist, das zu überschreiten, wird die abgeschnittene Liste einmal gemeldet und lässt den
  Baum, wie er ist, statt die Systeme an ihrem Ende zu löschen.

## Beim Update

Ein Update legt Namen und Beschreibungen erneut auf die bereits vorhandenen Datenpunkte, damit
korrigierte Formulierungen und neue Übersetzungen auch bestehende Anlagen erreichen und nicht nur
Neuinstallationen. Die Kehrseite: ein Datenpunkt, den Sie selbst in der Admin umbenannt haben,
trägt beim nächsten Start wieder den Namen des Adapters.
