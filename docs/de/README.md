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
E-Mail-Adresse und demselben Passwort wie in der Beszel-Weboberfläche. Ein Administratorkonto ist
nicht nötig.

Für Container-Daten braucht dieser Benutzer zusätzlich Leserecht auf die `containers`-Sammlung des
Hubs. Ohne das funktionieren alle anderen Metriken weiter; der Adapter warnt einmal und behält die
bereits angelegten Container-Datenpunkte.

## Einrichtung

1. **Installieren und Instanz anlegen.** In ioBroker `beszel` installieren und die
   Instanz-Einstellungen öffnen.
2. **Hub-Adresse eintragen** unter _Beszel Hub URL_ — dieselbe Adresse, mit der Sie die
   Beszel-Weboberfläche öffnen, zum Beispiel `http://192.168.1.100:8090`. Eine IPv6-Adresse steht
   in eckigen Klammern: `http://[fd00::1]:8090`. `http` und `https` funktionieren beide; bei `http`
   auf eine andere Maschine als den ioBroker-Host laufen Anmeldung und Sitzungsschlüssel
   unverschlüsselt über das Netz, und der Adapter sagt das einmal im Protokoll.
3. **Benutzername und Passwort eintragen.** Der Benutzername ist die E-Mail-Adresse Ihrer
   Beszel-Anmeldung.
4. **Auf _Test Connection_ drücken.** Es wird eine echte Anmeldung am Hub durchgeführt; bei einem
   Problem erscheint der tatsächliche Fehler — falsches Passwort, nicht erreichbarer Host,
   Tippfehler in der Adresse.
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
weist einmal im Protokoll darauf hin.

## Wie sich der Adapter verhält, wenn etwas fehlt

- **Ein System geht aus oder ist pausiert.** `info.online` wird falsch und `info.status` zeigt, was
  der Hub meldet. Die Messwerte bleiben auf dem letzten Stand stehen, statt auf null zu springen —
  der Adapter berichtet, was er weiß, und er weiß gerade nichts Neues.
- **Der Hub ist nicht erreichbar.** `info.connection` wird falsch, jedes System geht auf
  `info.online: false` und `info.status: unknown`, die Flottenzähler fallen auf null. Dasselbe
  passiert beim Stoppen der Instanz — nichts behauptet weiter „online", während niemand liest.
- **Der Hub antwortet mit einer leeren Liste.** Es wird nichts gelöscht. Ein Aussetzer darf den
  Objektbaum nicht leeren; Geräte verschwinden nur, wenn der Hub tatsächlich eine kürzere Liste
  meldet.
- **Ein Sensor, Lüfter, eine GPU, ein Dateisystem oder Container verschwindet.** Die zugehörigen
  Datenpunkte werden entfernt. Leert sich eine ganze Gruppe auf einmal, wartet der Adapter eine
  zweite Abfrage ab — ein einzelner Aussetzer räumt den Baum nicht ab.

## Beim Update

Ein Update legt Namen und Beschreibungen erneut auf die bereits vorhandenen Datenpunkte, damit
korrigierte Formulierungen und neue Übersetzungen auch bestehende Anlagen erreichen und nicht nur
Neuinstallationen. Die Kehrseite: ein Datenpunkt, den Sie selbst in der Admin umbenannt haben,
trägt beim nächsten Start wieder den Namen des Adapters.
