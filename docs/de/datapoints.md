# Datenpunkte und Metrik-Schalter

Jeder Schalter im Reiter _Metrics_ gilt global, also für alle überwachten Systeme. Ihn
auszuschalten stoppt nicht nur die Aktualisierung — die zugehörigen Datenpunkte werden beim
nächsten Start entfernt, und die Protokollzeile `Object tree updated: removed N datapoint(s)` sagt,
wie viele. Wieder einschalten legt sie neu an.

Ein Kategorie-Schalter regiert auch seine Detail-Schalter. Mit ausgeschaltetem _CPU Usage_ bleiben
die Kernauslastung, die Aufschlüsselung und die Spitzenwerte ebenfalls aus — in der Admin
ausgegraut und im Baum gar nicht erst angelegt. Nur die Kategorie System hat keinen solchen
Basis-Schalter; ihre drei Einträge sind unabhängig.

## System

| Schalter         | Datenpunkte                                                                                                                                                 | Hinweis                                                               |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| Uptime _(an)_    | `info.uptime`, `info.uptime_text`                                                                                                                           | Sekunden, dazu lesbar als `3d 4h 12m`                                 |
| System info      | `info.hostname`, `info.os`, `info.os_name`, `info.kernel`, `info.cpu_model`, `info.arch`, `info.cores`, `info.threads`, `info.podman`, `info.agent_version` | statische Daten, einmal beim Start und bei einem neuen System gelesen |
| Systemd Services | `info.services_total`, `info.services_failed`                                                                                                               | nur Linux mit systemd                                                 |

Immer vorhanden, unabhängig von jedem Schalter: `info.online` und `info.status`. `info.online` ist
der Wert, den das Gerätesymbol im Objektbaum liest. `info.status` trägt die vier Werte des Hubs
(`up`, `down`, `paused`, `pending`) und einen fünften des Adapters, `unknown` — für die Zeit, in der
der Adapter gestoppt ist oder den Hub nicht erreicht. Einen der vier Hub-Werte zu schreiben, würde
dort etwas behaupten, das niemand gemessen hat.

## CPU

| Schalter            | Datenpunkte                                                     |
| ------------------- | --------------------------------------------------------------- |
| CPU Usage _(an)_    | `cpu.usage`                                                     |
| Load Average _(an)_ | `cpu.load_1m`, `cpu.load_5m`, `cpu.load_15m`                    |
| CPU Breakdown       | `cpu.user`, `cpu.system`, `cpu.iowait`, `cpu.steal`, `cpu.idle` |
| Per-core usage      | `cpu.cores.core0`, `core1`, …                                   |
| Peak values         | `cpu.peak`                                                      |

`cpu.steal` ist der Zeitanteil, den der Hypervisor anderen Gästen gegeben hat — auf echter Hardware
bleibt er bei null, auf einer überbuchten VM ist er die Zahl, die erklärt, warum sich alles zäh
anfühlt.

## Arbeitsspeicher

| Schalter            | Datenpunkte                                     |
| ------------------- | ----------------------------------------------- |
| Memory Usage _(an)_ | `memory.percent`, `memory.used`, `memory.total` |
| Memory Details      | `memory.buffers`, `memory.zfs_arc`              |
| Swap                | `memory.swap_used`, `memory.swap_total`         |
| Peak values         | `memory.peak`                                   |

Puffer und ZFS-ARC zählen als belegter Speicher, das System kann sie aber jederzeit zurückholen —
deshalb kann eine Maschine „voll" aussehen und trotzdem völlig gesund sein.

## Festplatte

| Schalter                | Datenpunkte                                                                                    |
| ----------------------- | ---------------------------------------------------------------------------------------------- |
| Disk Usage _(an)_       | `disk.percent`, `disk.used`, `disk.total`                                                      |
| Read/Write Speed _(an)_ | `disk.read`, `disk.write`                                                                      |
| Additional Filesystems  | `filesystems.<mount>.disk_percent`, `.disk_used`, `.disk_total`, `.read_speed`, `.write_speed` |
| I/O load                | `disk.io_util`, `disk.io_await_read`, `disk.io_await_write`                                    |
| Peak values             | `disk.read_peak`, `disk.write_peak`                                                            |

Die `disk.*`-Werte beschreiben das Dateisystem, das der Agent als Wurzel führt. Alles weitere, was
Sie in Beszel eingerichtet haben, steht unter `filesystems.`. `io_util` ist der Zeitanteil, in dem
mindestens eine Anfrage an der Platte offen war; die beiden `io_await`-Werte sind die
Durchschnittsdauer eines einzelnen Lese- bzw. Schreibvorgangs — dieselben Größen, die `iostat` als
`r_await` und `w_await` ausgibt.

## Netzwerk

| Schalter               | Datenpunkte                                                         |
| ---------------------- | ------------------------------------------------------------------- |
| Network Traffic _(an)_ | `network.sent`, `network.recv`                                      |
| Per interface          | `network.interfaces.<name>.up`, `.down`, `.total_up`, `.total_down` |
| Peak values            | `network.sent_peak`, `network.recv_peak`                            |

`up`/`down` sind Raten in MB/s; `total_up`/`total_down` sind kumulierte Mengen in GB seit dem Start
des Agenten und beginnen bei einem Agenten-Neustart wieder bei null.

## Temperatur und Lüfter

| Schalter                       | Datenpunkte                              |
| ------------------------------ | ---------------------------------------- |
| Temperature _(an)_             | `temperature.average`, `temperature.max` |
| Individual Temperature Sensors | `temperature.sensors.<name>`             |
| Fan Speeds                     | `fans.<name>`                            |

`temperature.average` mittelt die drei heißesten Sensoren, nicht alle — ein Board mit zwanzig
Sensoren würde eine heiße CPU sonst in kühlen Nachbarn ertränken. `temperature.max` ist der
heißeste Einzelwert und damit meist der, auf den sich eine Warnung lohnt.

Lüfter brauchen Beszel 0.18.8 oder neuer und gibt es nur unter Linux, weil der Agent sie aus hwmon
liest. Sie stehen in einem eigenen Kanal `fans` statt unter Temperatur: andere Quelle, andere
Bedeutung. Ein Lüfter mit 0 rpm bleibt stehen — ein stehender Lüfter ist ein Messwert, kein
fehlender Wert.

## GPU

| Schalter    | Datenpunkte                                                 |
| ----------- | ----------------------------------------------------------- |
| GPU Metrics | `gpu.<id>.usage`, `.memory_used`, `.memory_total`, `.power` |
| Details     | `gpu.<id>.power_package`, `gpu.<id>.engines.<name>`         |

Der GPU-Speicher wird in MB gemeldet.

## Container

| Schalter             | Datenpunkte                                                                    |
| -------------------- | ------------------------------------------------------------------------------ |
| Container Monitoring | `containers.<name>.status`, `.health`, `.cpu`, `.memory`, `.image`, `.network` |

`health` ist das Ergebnis der Health-Prüfung des Images und steht auf `none`, wenn das Image keine
definiert. `network` ist Gesendet und Empfangen zusammen in Byte pro Sekunde und erscheint nur,
wenn der Hub den Wert liefert.

## Akku

| Schalter       | Datenpunkte                                                       |
| -------------- | ----------------------------------------------------------------- |
| Battery Status | `battery.percent`, `battery.charging`, `battery.batteries.<name>` |

`battery.charging` ist nur wahr, während der Akku wirklich lädt — nicht wenn er voll ist, im
Leerlauf oder entlädt. Die Werte je Akku brauchen Beszel 0.18.8 oder neuer; eine Maschine mit einem
einzigen Akku bekommt genau diesen einen Eintrag, ohne Schwelle, die beim Entfernen eines zweiten
Akkus die Kinder löschen würde.
