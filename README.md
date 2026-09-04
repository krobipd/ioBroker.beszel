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
|                 | I/O load (utilization, read/write wait times)         | off     |
|                 | Additional Filesystems                                | off     |
|                 | Peak values                                           | off     |
| **Network**     | Network Traffic (Upload / Download MB/s)              | on      |
|                 | Per interface                                         | off     |
|                 | Peak values                                           | off     |
| **Temperature** | Temperature (hottest sensors avg + hottest single)    | on      |
|                 | Individual Temperature Sensors                        | off     |
| **Fans**        | Fan Speeds (rpm, Beszel 0.18.8+, Linux hosts)         | off     |
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
        │   ├── read                 — Disk read (MB/s)
        │   ├── write                — Disk write (MB/s)
        │   ├── read_peak *          — Peak read in interval (MB/s)
        │   ├── write_peak *         — Peak write in interval (MB/s)
        │   ├── io_util *            — I/O utilization (%)
        │   ├── io_await_read *      — Read wait time (ms)
        │   └── io_await_write *     — Write wait time (ms)
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
        │       └── write_speed      — Write (MB/s)
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

### 0.13.0 (2026-09-02)

- Fixed: a Beszel Hub configured by IPv6 address can now be reached — the connection used to fail with a name lookup error because the address kept its square brackets
- Fixed: stopping the adapter while a poll was still running no longer writes a false "Poll failed" error line to the log, and no longer sends that false error to the error reporting
- Fixed: when the adapter cannot start — credentials to re-enter after an upgrade, or an invalid Hub URL — every system is now marked offline instead of keeping the previous run's green dot
- Changed: the three fleet summary states for systems total, online and all-up now exist from the installation on — a fresh install with an unreachable Hub shows 0 and false instead of nothing
- Changed: ioBroker Admin 8.0.11 or newer is required, in line with the current ioBroker stable repository — older Admin installations must be updated before installing this version

### 0.12.2 (2026-08-27) — stable

- Fixed: the first start after an update no longer puts warnings and an error into the log while the instance corrects itself and restarts.

### 0.12.1 (2026-08-27)

- Fixed: on an installation that was updated rather than freshly installed, the systems kept showing as online when the adapter was stopped — they now go offline there as well.
- Fixed: the count of systems currently online no longer keeps its last value while the adapter is stopped — it drops to zero along with the individual systems.

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
