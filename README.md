# <img src="https://cdn.jsdelivr.net/gh/krobipd/ioBroker.beszel@main/admin/beszel.svg" width="48" align="top" /> ioBroker.beszel

**Release:** [![npm version](https://img.shields.io/npm/v/iobroker.beszel)](https://www.npmjs.com/package/iobroker.beszel) ![stable](https://iobroker.live/badges/beszel-stable.svg) ![Installations](https://iobroker.live/badges/beszel-installed.svg) [![npm downloads](https://img.shields.io/npm/dt/iobroker.beszel)](https://www.npmjs.com/package/iobroker.beszel)

**Build:** [![Test and Release](https://github.com/krobipd/ioBroker.beszel/actions/workflows/test-and-release.yml/badge.svg)](https://github.com/krobipd/ioBroker.beszel/actions/workflows/test-and-release.yml) ![Node](https://img.shields.io/badge/node-%3E%3D22-brightgreen) ![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue) [![License](https://img.shields.io/badge/license-MIT-green)](LICENSE) [![Sentry](https://img.shields.io/badge/error%20reporting-Sentry-362d59?logo=sentry&logoColor=white)](https://github.com/ioBroker/plugin-sentry#plugin-sentry)

**Support:** [![Ko-fi](https://img.shields.io/badge/Ko--fi-Support-ff5e5b?logo=ko-fi)](https://ko-fi.com/krobipd) [![PayPal](https://img.shields.io/badge/Donate-PayPal-blue.svg)](https://paypal.me/krobipd)

Connects to a [Beszel](https://github.com/henrygd/beszel) Hub and exposes server monitoring metrics for all registered systems as ioBroker states.

---

## Features

- Fetches metrics from all systems registered in your Beszel Hub
- Per-system states: CPU, memory, disk, network, temperature, load average
- Every system carries a pictogram of its operating system (Linux, macOS, Windows, FreeBSD) in the object tree, drawn to read in the light and the dark theme
- Optional detail: per-core CPU, disk I/O load, per-interface traffic, fan speeds, GPU details, hardware/OS info, Docker/Podman containers (incl. whether an image update is available), battery (incl. per-battery level), extra filesystems, CPU breakdown, systemd services, storage pools (ZFS and btrfs), SMART drive health, network monitors (ping/TCP/HTTP/DNS response times and loss)
- Each option has a help text explaining the states it creates; detail options stay greyed out until their category is enabled
- Configurable poll interval (10–300 seconds)
- Automatic re-authentication when the token expires or the Hub stops accepting it (e.g. after a password change), with a clear log line when the login itself is refused
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
- A Beszel user (log-in by e-mail, without multi-factor authentication) that is assigned to the systems — the ones it added, the ones a Hub admin added it to (`systems` → `users`), or all of them when the Hub runs with `SHARE_ALL_SYSTEMS=true`; a user assigned to nothing sees an empty list

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
| **E-mail**              | E-mail address of your Beszel login — Beszel does not accept a username here            | —       |
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
| **Memory**      | Memory Usage (% and GB)                               | on      |
|                 | Memory Details (Buffers, ZFS ARC)                     | off     |
|                 | Swap                                                  | off     |
| **Disk**        | Disk Usage (% and GB)                                 | on      |
|                 | Read/Write Speed                                      | on      |
|                 | I/O load (utilization, wait times, totals since boot) | off     |
|                 | Additional Filesystems                                | off     |
| **Network**     | Network Traffic (Upload / Download MB/s)              | on      |
|                 | Per interface                                         | off     |
| **Temperature** | Temperature (hottest sensors avg + hottest single)    | on      |
|                 | Individual Temperature Sensors                        | off     |
| **Fans**        | Fan Speeds (rpm, Beszel 0.18.8+, Linux hosts)         | off     |
| **Storage**     | Storage pools: ZFS (Beszel 0.19.0+), btrfs (0.20.0+)  | off     |
|                 | Pool details (scrub, vdev errors, datasets)           | off     |
| **SMART**       | SMART devices (verdict, temperature, hours, cycles)   | off     |
| **Monitors**    | Network monitors (Beszel 0.20.0+)                     | off     |
| **GPU**         | GPU Metrics (Usage, Memory, Power)                    | off     |
|                 | GPU details (engines, package power)                  | off     |
| **Containers**  | Container Monitoring incl. network (Docker / Podman)  | off     |
| **Battery**     | Battery Status (incl. level per battery)              | off     |

---

## State Tree

States are organized into channels per metric group. Optional channels (marked \*) are only created when the corresponding metric is enabled. Datapoints that describe hardware a host may not have (temperature sensors, a battery, swap, a ZFS cache) exist only on hosts that report it. While a system is down or paused, all of its datapoints keep their last values.

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
        │   └── cores/ *             — Per-core usage (core0, core1, …) (%)
        ├── memory/                   — Memory metrics
        │   ├── percent              — RAM usage (%)
        │   ├── used                 — RAM used (GB)
        │   ├── total                — RAM total (GB)
        │   ├── buffers *            — Buffers + cache (GB)
        │   ├── zfs_arc *            — ZFS ARC (GB, only on hosts with ZFS)
        │   ├── swap_used *          — Swap used (GB, only on hosts with swap)
        │   └── swap_total *         — Swap total (GB, only on hosts with swap)
        ├── disk/                     — Disk metrics
        │   ├── percent              — Disk usage (%)
        │   ├── used                 — Disk used (GB)
        │   ├── total                — Disk total (GB)
        │   ├── name *               — Root disk name set on the agent (Beszel 0.19.0+)
        │   ├── read                 — Disk read (MB/s, 0 while idle)
        │   ├── write                — Disk write (MB/s, 0 while idle)
        │   ├── io_util *            — I/O utilization (%)
        │   ├── io_await_read *      — Read wait time (ms)
        │   ├── io_await_write *     — Write wait time (ms)
        │   ├── total_read *         — Read since boot (GB, Beszel 0.19.0+)
        │   └── total_write *        — Written since boot (GB, Beszel 0.19.0+)
        ├── network/                  — Network metrics
        │   ├── sent                 — Upload (MB/s, 0 while idle)
        │   ├── recv                 — Download (MB/s, 0 while idle)
        │   └── interfaces/ *        — Per interface: up, down (MB/s) + total_up, total_down (cumulative GB)
        ├── temperature/              — Temperature metrics (only on hosts that report sensors)
        │   ├── average              — Avg of top 3 sensors (°C)
        │   ├── max                  — Hottest single sensor (°C)
        │   └── sensors/ *           — Individual sensor readings
        ├── fans/ *                   — Fan speeds (rpm), one state per fan
        ├── battery/ *                — Battery metrics (only on hosts with a battery)
        │   ├── percent              — Battery level (%)
        │   ├── charging             — Is charging? (bool)
        │   └── batteries/ *         — Level per battery (%), on multi-battery systems
        ├── gpu/ *                    — GPU metrics (per GPU)
        │   └── {gpu_name}/
        │       ├── usage            — GPU usage (%)
        │       ├── memory_used      — VRAM used (MB, only on GPUs that report memory)
        │       ├── memory_total     — VRAM total (MB, only on GPUs that report memory)
        │       ├── power            — Power draw (W)
        │       ├── power_package *  — Package power (W) (GPU details, only on GPUs with a package sensor)
        │       └── engines/ *       — Per-engine usage (render, video, …) (%)
        ├── filesystems/ *            — Extra filesystems (named after the device or the custom name set on the agent)
        │   └── {fs_name}/
        │       ├── disk_percent     — Usage (%)
        │       ├── disk_used        — Used (GB)
        │       ├── disk_total       — Total (GB)
        │       ├── read_speed       — Read (MB/s)
        │       ├── write_speed      — Write (MB/s)
        │       ├── total_read *     — Read since boot (GB, Beszel 0.19.0+)
        │       └── total_write *    — Written since boot (GB, Beszel 0.19.0+)
        ├── zfs/ *                    — Storage pools: ZFS (Beszel 0.19.0+) and btrfs (0.20.0+), one channel per pool
        │   └── <pool>/
        │       ├── pool_type        — zfs or btrfs
        │       ├── disk_percent     — Used (%; not on raw-size pools)
        │       ├── disk_used        — Used (GB)
        │       ├── disk_total       — Size (GB)
        │       ├── raw              — Size and usage are raw physical bytes of all member devices (bool)
        │       ├── read_speed       — Read (MB/s)
        │       ├── write_speed      — Write (MB/s)
        │       ├── health           — Pool health (ONLINE, DEGRADED, …, UNKNOWN)
        │       ├── scrub_state *    — Scrub status (SCANNING/FINISHED/CANCELED), only once a pool has been scrubbed
        │       ├── scrub_progress * — Scrub progress as the pool reports it (e.g. 42.10%)
        │       ├── scrub_errors *   — Errors the last scrub found
        │       ├── vdevs/ *          — one channel per vdev (or btrfs device)
        │       │   └── <vdev>/
        │       │       ├── state             — Vdev state (ONLINE, …, MISSING)
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
        │       ├── state            — Overall verdict (PASSED / WARNING / FAILED / UNKNOWN)
        │       ├── model            — Model
        │       ├── serial           — Serial number
        │       ├── firmware         — Firmware
        │       ├── interface        — Interface (sat, nvme, …)
        │       ├── temperature      — Temperature (°C, only when the drive reports one)
        │       ├── capacity         — Capacity (GB, only when the drive reports one)
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
        ├── containers/ *             — Docker/Podman containers
        │   └── {container_name}/
        │       ├── status           — Container status
        │       ├── health           — Health (none/starting/healthy/unhealthy)
        │       ├── cpu              — CPU usage (%)
        │       ├── memory           — Memory (MB)
        │       ├── image            — Image name
        │       ├── network          — Combined network throughput (bytes/s)
        │       └── update_available — Image update available (bool, Beszel 0.20.0+)
        └── monitors/ *               — Network monitors set up on the Hub (Beszel 0.20.0+)
            └── <protocol>_<target>/
                ├── protocol         — icmp / tcp / http / dns
                ├── target           — Host, address or URL
                ├── port             — Port (tcp only)
                ├── interval         — Probe interval (s)
                ├── enabled          — Monitor enabled on the Hub (bool)
                ├── response         — Latest response time (ms, empty without a successful probe)
                ├── response_avg_1h  — Average response time, last hour (ms)
                ├── response_min_1h  — Fastest response, last hour (ms)
                ├── response_max_1h  — Slowest response, last hour (ms)
                ├── loss_1h          — Loss over the last hour (%)
                ├── last_probe_loss  — Loss of the latest probe record (%)
                ├── last_probe       — Time of the latest probe record
                └── last_update      — Time the Hub last updated the monitor
```

> **Breaking change in 0.3.0:** States moved from flat paths (e.g. `cpu_usage`) to channels (e.g. `cpu.usage`).

---

## Troubleshooting

### Connection failed

- Verify the Hub URL is reachable from the ioBroker host — without `?`, `#` or a user name and password in it
- "API was not found at this URL (404)": the address answers, but not with the Beszel API — a Hub behind a reverse proxy needs its path in the URL
- Check e-mail and password (use the Test Connection button); the log says whether the login was refused, needs multi-factor authentication or is switched off on the Hub
- An https Hub needs a certificate the ioBroker host trusts — a self-signed one is refused
- Check that no firewall blocks access to the Beszel Hub port

### States not updating

- Check the ioBroker log for errors from the `beszel` adapter
- Ensure the poll interval is not too short (minimum 10 seconds)
- Check `info.connection` — `false` means the adapter cannot read the Hub right now (network, login or a Hub error; the log names which)
- The Test Connection button reports how many systems your user can see — 0 means the user is assigned to no system

### Missing states for a system

- A system that has never connected (`pending`) has no metrics yet — they appear with its first stats record
- A system that is `down` or `paused` keeps its last values; nothing is removed while it is away
- Verify the metric is enabled in the adapter configuration
- Temperature, battery, swap and ZFS ARC datapoints exist only on hosts whose agent reports that hardware

---

## Changelog

<!--
    Placeholder for the next version (at the beginning of the line):
    ### **WORK IN PROGRESS**
-->

### **WORK IN PROGRESS**

- New: network monitors (Beszel 0.20.0) as an opt-in metric — response time, hourly average/fastest/slowest and loss for every ping, TCP, HTTP and DNS monitor set up on the Hub
- New: containers show whether an image update is available (Beszel 0.20.0)
- New: btrfs filesystems appear next to the ZFS pools (Beszel 0.20.0), with their own name, the pool type and a flag for raw physical sizes
- New: the connection test tells how many systems your user can see, and says so when it is none
- Fixed: after a password change, a deleted user or a restored Hub database the adapter kept every system green without new values for up to a day — it now logs in again right away
- Fixed: a refused login says why — wrong e-mail or password, multi-factor authentication, or password login switched off on the Hub — and the adapter stops retrying every poll
- Fixed: a paused or never-connected system no longer shows uptime 0 or empty system details; its last values stay
- Fixed: on current Hubs, swap, ZFS cache, GPU memory and GPU package power appeared on hosts that do not have them — they are removed
- Fixed: drives without a temperature or capacity reading showed 0; they now get no such datapoint
- Fixed: a storage pool that was removed came back with the next detail refresh and stayed until the next restart
- Fixed: a system whose name has no Latin letters or digits (e.g. Cyrillic or Chinese) got no object tree; it now gets a stable fallback id
- Fixed: two containers or group members whose names turn into the same id could swap their datapoints after a restart, and a container's id suffix changed with every re-create
- Fixed: a member of a group (sensor, container, unit, …) that was missing from a single poll was deleted at once; it now has to be missing twice
- Fixed: spaces and a trailing slash around the Hub URL are removed; a URL with `?`, `#` or a user name and password in it is rejected with a clear message, also in the connection test
- Fixed: on a very large Hub, the systems at the end of a long list lost their datapoints — a cut-off list now leaves the tree as it is and is reported once
- Fixed: a request that trickled in slowly could run far past the configured timeout
- Changed: a Hub URL that does not lead to the Beszel API (e.g. a missing reverse-proxy path) is named as such in the log and in the connection test
- Changed: a short network outage no longer fills the log with warnings; the systems are still marked offline
- Changed: a renamed or removed system on the Hub is reported in the log
- Changed: the login field is called E-mail — Beszel does not accept a username
- Changed: the SMART verdict also knows WARNING and UNKNOWN, the pool health UNKNOWN and the vdev state MISSING
- Changed: help texts, descriptions and translations corrected; drive model, serial number, firmware and host name carry more specific roles

### 0.18.0 (2026-09-15) — stable

- New: every system carries a pictogram of its operating system in the object tree — the same icons the Beszel web UI uses, readable in the light and the dark theme
- Fixed: network upload/download were always empty against a Beszel Hub 0.19.0 or newer; they carry values again, and older Hubs keep working
- Fixed: disk read/write, network upload/download and swap used show 0 while idle instead of an empty value
- Fixed: containers and systemd units of a system that is down or paused were deleted after a few minutes — they now keep their last values like every other datapoint
- Fixed: the last SMART device, ZFS pool detail or systemd unit of a system was never removed once it disappeared on the Hub
- Fixed: hardware and OS details are refreshed when a system reconnects — a new kernel shows after the reboot, not after the next adapter restart
- Fixed: a system that was still pending gets its hardware and OS details on its first contact
- Fixed: a Hub that is slow at adapter start no longer blanks the hardware/OS datapoints of all systems for one poll
- Fixed: renaming a system on the Hub in a way that keeps its object id (e.g. only the case) now reaches the object tree
- Fixed: a system added later with the same name as an existing one no longer takes over the existing system's object tree; the newcomer gets the suffix
- Fixed: a container, dataset or unit whose name equals a group name (e.g. `gpu`, `network`, `containers`) kept being renamed while its system was down
- Fixed: stopping the adapter in the middle of a poll no longer leaves late value changes behind
- Fixed: after the Hub briefly reported an empty system list, the offline markers written on errors and on shutdown reached no system
- Changed: temperature, battery, swap and ZFS ARC datapoints exist only on hosts that report that hardware; existing empty ones are removed
- Changed: uptime, load average and agent version appear only once a system has connected; existing empty ones are removed
- Changed: the ZFS error counters and the SMART power-cycle counter no longer show an empty unit in the object tree
- Changed: the four "Peak values" options are gone — a Hub never delivers peak values in the minute records the adapter reads, so they never produced a datapoint
- Changed: the messages of the connection test follow the system language, and the test runs with the configured request timeout
- Changed: SMART and dataset text columns the Hub does not carry read as empty (null) instead of an empty string
- Changed: the warning about a plain-http Hub URL is gone — http on the local network is how Beszel is normally deployed
- Changed: `info.uptime_text` is gone — it was `info.uptime` a second time as text; existing installations lose it on the first start

### 0.17.1 (2026-09-07)

- Improved: sixteen datapoints now carry an explanation in the object tree — online state, OS name, load average, container and service CPU, ZFS scrub errors and drive power cycles
- Fixed: the datapoint carrying the distribution name was labelled "OS Version" — it now reads "OS Name" in all eleven languages, matching what it actually shows

### 0.17.0 (2026-09-06)

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
