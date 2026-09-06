# <img src="https://cdn.jsdelivr.net/gh/krobipd/ioBroker.beszel@main/admin/beszel.svg" width="48" align="top" /> ioBroker.beszel

**Release:** [![npm version](https://img.shields.io/npm/v/iobroker.beszel)](https://www.npmjs.com/package/iobroker.beszel) ![stable](https://iobroker.live/badges/beszel-stable.svg) ![Installations](https://iobroker.live/badges/beszel-installed.svg) [![npm downloads](https://img.shields.io/npm/dt/iobroker.beszel)](https://www.npmjs.com/package/iobroker.beszel)

**Build:** [![Test and Release](https://github.com/krobipd/ioBroker.beszel/actions/workflows/test-and-release.yml/badge.svg)](https://github.com/krobipd/ioBroker.beszel/actions/workflows/test-and-release.yml) ![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen) ![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue) [![License](https://img.shields.io/badge/license-MIT-green)](LICENSE) [![Sentry](https://img.shields.io/badge/error%20reporting-Sentry-362d59?logo=sentry&logoColor=white)](https://github.com/ioBroker/plugin-sentry#plugin-sentry)

**Support:** [![Ko-fi](https://img.shields.io/badge/Ko--fi-Support-ff5e5b?logo=ko-fi)](https://ko-fi.com/krobipd) [![PayPal](https://img.shields.io/badge/Donate-PayPal-blue.svg)](https://paypal.me/krobipd)

Connects to a [Beszel](https://github.com/henrygd/beszel) Hub and exposes server monitoring metrics for all registered systems as ioBroker states.

---

## Features

- Fetches metrics from all systems registered in your Beszel Hub
- Per-system states: CPU, memory, disk, network, temperature, load average
- Optional detail: per-core CPU, peak values, disk I/O load, per-interface traffic, fan speeds, GPU details, hardware/OS info, Docker/Podman containers, battery (incl. per-battery level), extra filesystems, CPU breakdown, systemd services
- Each option has a help text explaining the states it creates; detail options stay greyed out until their category is enabled
- Configurable poll interval (10–300 seconds)
- Automatic re-authentication when the token expires (including mid-poll)
- Connection test button in the admin UI
- Automatic cleanup of states for removed systems, stale containers and disabled metrics

---

## Sentry / Error reporting

**This adapter uses Sentry libraries to automatically report exceptions and code errors to the developers.** Reporting only happens if you have enabled error reporting in the ioBroker diagnostics (**System settings → Diagnostics and error reporting**). Only an anonymous installation ID is transmitted — no name, e-mail address or IP address.

For details and how to disable it, see the [Sentry plugin documentation](https://github.com/ioBroker/plugin-sentry#plugin-sentry). Error reporting requires js-controller 3.0 or newer.

---

## Requirements

- **Node.js >= 22**
- **ioBroker js-controller >= 7.2.2**
- **ioBroker Admin >= 8.0.11**
- A running [Beszel Hub](https://github.com/henrygd/beszel) with at least one registered system

> The adapter CANNOT be installed via GitHub: The adapter must be installed via the ioBroker repository (stable or latest).

---

## Documentation

Step-by-step setup, what every metric switch creates, and the questions that keep coming up:
[English](docs/en/README.md) · [Deutsch](docs/de/README.md).

---

## Configuration

### Connection

| Option                  | Description                                                                             | Default |
| ----------------------- | --------------------------------------------------------------------------------------- | ------- |
| **Beszel Hub URL**      | Full URL of your Beszel Hub (e.g. `http://192.168.1.100:8090`)                          | —       |
| **Username**            | Beszel Hub login email/username                                                         | —       |
| **Password**            | Beszel Hub password                                                                     | —       |
| **Poll Interval (s)**   | How often to fetch data from the Hub (10–300)                                           | `60`    |
| **Request Timeout (s)** | Per-request HTTP timeout. Raise for slow Hubs or large container/stats payloads (5–120) | `15`    |

Use the **Test Connection** button to verify your credentials before saving.

### Metrics

All metrics are global toggles that apply to **all** systems. Disabled metrics are automatically removed from the state tree on the next adapter start.

Detail options stay greyed out until their category's main metric is enabled, and each option carries a help text describing exactly which states it creates.

| Group           | Metric                                                | Default |
| --------------- | ----------------------------------------------------- | ------- |
| **System**      | Uptime                                                | on      |
|                 | System info (hardware, OS, agent version)             | off     |
|                 | Systemd Services (total / failed)                     | off     |
|                 | Service details (state, CPU, memory per unit)         | off     |
| **CPU**         | CPU Usage (%)                                         | on      |
|                 | Load Average (1m / 5m / 15m)                          | on      |
|                 | CPU Breakdown (User / System / IOWait / Steal / Idle) | off     |
|                 | Per-core usage                                        | off     |
|                 | Peak values                                           | off     |
| **Memory**      | Memory Usage (% and GB)                               | on      |
|                 | Memory Details (Buffers, ZFS ARC)                     | off     |
|                 | Swap                                                  | off     |
|                 | Peak values                                           | off     |
| **Disk**        | Disk Usage (% and GB)                                 | on      |
|                 | Read/Write Speed                                      | on      |
|                 | I/O load (utilization, wait times, totals since boot) | off     |
|                 | Additional Filesystems                                | off     |
|                 | Peak values                                           | off     |
| **Network**     | Network Traffic (Upload / Download MB/s)              | on      |
|                 | Per interface                                         | off     |
|                 | Peak values                                           | off     |
| **Temperature** | Temperature (hottest sensors avg + hottest single)    | on      |
|                 | Individual Temperature Sensors                        | off     |
| **Fans**        | Fan Speeds (rpm, Beszel 0.18.8+, Linux hosts)         | off     |
| **ZFS**         | ZFS Pools (usage, throughput, health; Beszel 0.19.0+) | off     |
|                 | ZFS details (scrub, vdev errors, datasets)            | off     |
| **SMART**       | SMART devices (verdict, temperature, hours, cycles)   | off     |
| **GPU**         | GPU Metrics (Usage, Memory, Power)                    | off     |
|                 | GPU details (engines, package power)                  | off     |
| **Containers**  | Container Monitoring incl. network (Docker / Podman)  | off     |
| **Battery**     | Battery Status (incl. level per battery)              | off     |

---

## State Tree

States are organized into channels per metric group. Optional channels (marked \*) are only created when the corresponding metric is enabled.

```
beszel.0.
├── info.connection                   — Connection status (bool)
├── info.systemsTotal                 — Systems registered on the Hub (number)
├── info.systemsOnline                — Systems currently reporting "up" (number)
├── info.systemsAllUp                 — All systems up? (bool)
└── systems.
    └── {system_name}/                — Device (sanitized name)
        ├── info/                     — System info
        │   ├── online               — Is system up? (bool, used as device indicator)
        │   ├── status               — Status string (up/down/paused/pending, or unknown while the adapter is not reading)
        │   ├── uptime               — Uptime in seconds
        │   ├── uptime_text          — Human-readable uptime (e.g. "14d 6h")
        │   ├── agent_version *      — Beszel agent version
        │   ├── hostname *           — Host name (System info)
        │   ├── os *                 — Operating system (Linux/macOS/Windows/FreeBSD)
        │   ├── os_name *            — OS version (e.g. "Ubuntu 22.04")
        │   ├── kernel *             — Kernel version
        │   ├── cpu_model *          — CPU model
        │   ├── arch *               — CPU architecture
        │   ├── cores *              — Physical CPU cores
        │   ├── threads *            — Logical CPU threads
        │   ├── podman *             — Container engine is Podman (bool)
        │   ├── services_total *     — Systemd services total
        │   └── services_failed *    — Systemd services failed
        ├── cpu/                      — CPU metrics
        │   ├── usage                — CPU usage (%)
        │   ├── load_1m              — Load average 1 min
        │   ├── load_5m              — Load average 5 min
        │   ├── load_15m             — Load average 15 min
        │   ├── user *               — CPU user (%)
        │   ├── system *             — CPU system (%)
        │   ├── iowait *             — CPU I/O wait (%)
        │   ├── steal *              — CPU steal (%)
        │   ├── idle *               — CPU idle (%)
        │   ├── peak *               — Peak CPU usage in interval (%)
        │   └── cores/ *             — Per-core usage (core0, core1, …) (%)
        ├── memory/                   — Memory metrics
        │   ├── percent              — RAM usage (%)
        │   ├── used                 — RAM used (GB)
        │   ├── total                — RAM total (GB)
        │   ├── buffers *            — Buffers + cache (GB)
        │   ├── zfs_arc *            — ZFS ARC (GB)
        │   ├── swap_used *          — Swap used (GB)
        │   ├── swap_total *         — Swap total (GB)
        │   └── peak *               — Peak RAM used in interval (GB)
        ├── disk/                     — Disk metrics
        │   ├── percent              — Disk usage (%)
        │   ├── used                 — Disk used (GB)
        │   ├── total                — Disk total (GB)
        │   ├── name *               — Root disk name set on the agent (Beszel 0.19.0+)
        │   ├── read                 — Disk read (MB/s)
        │   ├── write                — Disk write (MB/s)
        │   ├── read_peak *          — Peak read in interval (MB/s)
        │   ├── write_peak *         — Peak write in interval (MB/s)
        │   ├── io_util *            — I/O utilization (%)
        │   ├── io_await_read *      — Read wait time (ms)
        │   ├── io_await_write *     — Write wait time (ms)
        │   ├── total_read *         — Read since boot (GB, Beszel 0.19.0+)
        │   └── total_write *        — Written since boot (GB, Beszel 0.19.0+)
        ├── network/                  — Network metrics
        │   ├── sent                 — Upload (MB/s)
        │   ├── recv                 — Download (MB/s)
        │   ├── sent_peak *          — Peak upload in interval (MB/s)
        │   ├── recv_peak *          — Peak download in interval (MB/s)
        │   └── interfaces/ *        — Per interface: up, down (MB/s) + total_up, total_down (cumulative GB)
        ├── temperature/              — Temperature metrics
        │   ├── average              — Avg of top 3 sensors (°C)
        │   ├── max                  — Hottest single sensor (°C)
        │   └── sensors/ *           — Individual sensor readings
        ├── fans/ *                   — Fan speeds (rpm), one state per fan
        ├── battery/ *                — Battery metrics
        │   ├── percent              — Battery level (%)
        │   ├── charging             — Is charging? (bool)
        │   └── batteries/ *         — Level per battery (%), on multi-battery systems
        ├── gpu/ *                    — GPU metrics (per GPU)
        │   └── {gpu_name}/
        │       ├── usage            — GPU usage (%)
        │       ├── memory_used      — VRAM used (MB)
        │       ├── memory_total     — VRAM total (MB)
        │       ├── power            — Power draw (W)
        │       ├── power_package *  — Package power (W) (GPU details)
        │       └── engines/ *       — Per-engine usage (render, video, …) (%)
        ├── filesystems/ *            — Extra filesystems (per mount)
        │   └── {fs_name}/
        │       ├── disk_percent     — Usage (%)
        │       ├── disk_used        — Used (GB)
        │       ├── disk_total       — Total (GB)
        │       ├── read_speed       — Read (MB/s)
        │       ├── write_speed      — Write (MB/s)
        │       ├── total_read *     — Read since boot (GB, Beszel 0.19.0+)
        │       └── total_write *    — Written since boot (GB, Beszel 0.19.0+)
        ├── zfs/ *                    — ZFS pools (Beszel 0.19.0+), one channel per pool
        │   └── <pool>/
        │       ├── disk_percent     — Used (%)
        │       ├── disk_used        — Used (GB)
        │       ├── disk_total       — Size (GB)
        │       ├── read_speed       — Read (MB/s)
        │       ├── write_speed      — Write (MB/s)
        │       ├── health           — Pool health (ONLINE, DEGRADED, …)
        │       ├── scrub_state *    — Scrub status (NONE/SCANNING/FINISHED/CANCELED)
        │       ├── scrub_progress * — Scrub progress as the pool reports it
        │       ├── scrub_errors *   — Errors the last scrub found
        │       ├── vdevs/ *          — one channel per vdev
        │       │   └── <vdev>/
        │       │       ├── state             — Vdev state
        │       │       ├── read_errors       — Read errors
        │       │       ├── write_errors      — Write errors
        │       │       └── checksum_errors   — Checksum errors
        │       └── datasets/ *       — one channel per dataset
        │           └── <dataset>/
        │               ├── used              — Used (GB)
        │               ├── avail             — Available (GB)
        │               └── mountpoint        — Mount point
        ├── smart/ *                  — SMART devices, one channel per drive
        │   └── <device>/
        │       ├── state            — SMART verdict (PASSED / FAILED)
        │       ├── model            — Model
        │       ├── serial           — Serial number
        │       ├── firmware         — Firmware
        │       ├── interface        — Interface (sat, nvme, …)
        │       ├── temperature      — Temperature (°C)
        │       ├── capacity         — Capacity (GB)
        │       ├── power_on_hours   — Power-on hours
        │       └── power_cycles     — Power cycles
        ├── services/ *               — systemd units, one channel per unit
        │   └── <unit>/
        │       ├── state            — State (active, inactive, failed, …)
        │       ├── sub_state        — Sub-state (running, exited, dead, …)
        │       ├── cpu              — CPU (%)
        │       ├── cpu_peak         — CPU peak (%)
        │       ├── memory           — Memory (MB)
        │       └── memory_peak      — Memory peak (MB)
        └── containers/ *             — Docker/Podman containers
            └── {container_name}/
                ├── status           — Container status
                ├── health           — Health (none/starting/healthy/unhealthy)
                ├── cpu              — CPU usage (%)
                ├── memory           — Memory (MB)
                ├── image            — Image name
                └── network          — Combined network throughput (bytes/s)
```

> **Breaking change in 0.3.0:** States moved from flat paths (e.g. `cpu_usage`) to channels (e.g. `cpu.usage`). Legacy states are automatically cleaned up on first start.

---

## Troubleshooting

### Connection failed

- Verify the Hub URL is reachable from the ioBroker host
- Check username and password (use the Test Connection button)
- Check that no firewall blocks access to the Beszel Hub port

### States not updating

- Check the ioBroker log for errors from the `beszel` adapter
- Ensure the poll interval is not too short (minimum 10 seconds)
- Check `info.connection` state — if `false`, authentication failed

### Missing states for a system

- The system may be `down` or `paused` in Beszel — no stats records exist yet
- Verify the metric is enabled in the adapter configuration

---

## Changelog

<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->

### **WORK IN PROGRESS**

- New: SMART data per drive as an opt-in metric — the drive's own overall verdict plus temperature, capacity, power-on hours and power cycles
- New: ZFS pool details as an opt-in metric — scrub status, per-vdev error counters and the datasets of each pool
- New: systemd service details as an opt-in metric — state, sub-state, CPU and memory for every unit the agent reports
- Improved: the two slow detail sources are read every 15 minutes instead of every poll, so switching them on costs your Hub almost nothing

### 0.16.0 (2026-09-06)

- Fixed: switching a metric group off now really empties it — a system that was offline at the time kept the empty channel and got it back after every restart
- Fixed: a stumble while starting no longer leaves the adapter alive but silent — it keeps going and updates your values as usual
- Changed: the status words of a system, of a ZFS pool and of a container are shown in your ioBroker language instead of English
- Changed: a container's health is now a proper status datapoint with its list of possible values, like the system status next to it
- Improved: starting up puts far less load on the ioBroker database, which shows most with many systems or many metrics switched off
- Changed: user documentation now covers the ZFS pools, the root disk name and the read/write totals

### 0.15.0 (2026-09-05)

- New: ZFS pools with usage, throughput and health as an opt-in metric, the root disk's custom name and cumulative read/write totals for disks and filesystems on Beszel 0.19.0.

### 0.14.2 (2026-09-05)

- Changed: Internal cleanup. No user-facing changes.

### 0.14.1 (2026-09-04)

- Fixed: a system that is offline right now kept the old datapoint names and got no descriptions — the update reached only systems the Hub had a current reading for

### 0.14.0 (2026-09-04)

- New: user documentation in the repository, in English and German — setup step by step, what every metric switch creates, and the questions that keep coming up
- New: every datapoint whose meaning is not obvious now carries a short explanation in all eleven languages — the top-3 temperature average, peak values, I/O wait times and more
- Fixed: the counts of total, online and all-up systems were shown in English on nine of the eleven languages
- Fixed: corrected names and descriptions now reach installations that already have the datapoints, instead of only new installations
- Fixed: a value that the Hub stopped delivering was reset to empty while the adapter kept running, but stayed on its old reading after a restart — now it is reset in both cases
- Changed: a system the Hub has no reading for keeps its last measured values instead of having them cleared, matching what the individual sensors, fans and containers already did
- Changed: the datapoint "Legacy state migration completed" disappears from the object tree — it never said anything about a monitored system

[Older changelogs can be found there](CHANGELOG_OLD.md)

## Support

- [ioBroker Forum](https://forum.iobroker.net/)
- [GitHub Issues](https://github.com/krobipd/ioBroker.beszel/issues)

### Support Development

This adapter is free and open source. If you find it useful, consider buying me a coffee:

[![Ko-fi](https://img.shields.io/badge/Ko--fi-Support-ff5e5b?style=for-the-badge&logo=ko-fi)](https://ko-fi.com/krobipd)
[![PayPal](https://img.shields.io/badge/Donate-PayPal-blue.svg?style=for-the-badge)](https://paypal.me/krobipd)

---

## License

MIT License

Copyright (c) 2026 krobi <krobi@power-dreams.com>

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

---

_Developed with assistance from Claude.ai_
