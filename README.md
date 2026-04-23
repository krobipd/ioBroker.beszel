# ioBroker.beszel

[![npm version](https://img.shields.io/npm/v/iobroker.beszel)](https://www.npmjs.com/package/iobroker.beszel)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)
[![License](https://img.shields.io/badge/license-MIT-green)](LICENSE)
[![npm downloads](https://img.shields.io/npm/dt/iobroker.beszel)](https://www.npmjs.com/package/iobroker.beszel)
![Installations](https://iobroker.live/badges/beszel-installed.svg)
[![Ko-fi](https://img.shields.io/badge/Ko--fi-Support-ff5e5b?logo=ko-fi)](https://ko-fi.com/krobipd)
[![PayPal](https://img.shields.io/badge/Donate-PayPal-blue.svg)](https://paypal.me/krobipd)

<img src="https://raw.githubusercontent.com/krobipd/ioBroker.beszel/main/admin/beszel.svg" width="100" />

Connects to a [Beszel](https://github.com/henrygd/beszel) Hub and exposes server monitoring metrics for all registered systems as ioBroker states.

---

## Features

- Fetches metrics from all systems registered in your Beszel Hub
- Per-system states: CPU, memory, disk, network, temperature, load average
- Optional: GPU metrics, Docker/Podman containers, battery, extra filesystems, CPU breakdown, systemd services
- Configurable poll interval (10–300 seconds)
- Automatic re-authentication when the token expires
- Connection test button in the admin UI
- Automatic cleanup of states for removed systems and disabled metrics

---

## Requirements

- **Node.js >= 20**
- **ioBroker js-controller >= 7.0.0**
- **ioBroker Admin >= 7.6.20**
- A running [Beszel Hub](https://github.com/henrygd/beszel) with at least one registered system

---

## Configuration

### Connection

| Option | Description | Default |
|--------|-------------|---------|
| **Beszel Hub URL** | Full URL of your Beszel Hub (e.g. `http://192.168.1.100:8090`) | — |
| **Username** | Beszel Hub login email/username | — |
| **Password** | Beszel Hub password | — |
| **Poll Interval (s)** | How often to fetch data from the Hub | `60` |

Use the **Test Connection** button to verify your credentials before saving.

### Metrics

All metrics are global toggles that apply to **all** systems. Disabled metrics are automatically removed from the state tree on the next adapter start.

| Group | Metric | Default |
|-------|--------|---------|
| **System** | Uptime | on |
| | Agent Version | off |
| | Systemd Services (total / failed) | off |
| **CPU** | CPU Usage (%) | on |
| | Load Average (1m / 5m / 15m) | on |
| | CPU Breakdown (User / System / IOWait / Steal / Idle) | off |
| **Memory** | Memory Usage (% and GB) | on |
| | Memory Details (Buffers, ZFS ARC) | off |
| | Swap | off |
| **Disk** | Disk Usage (% and GB) | on |
| | Disk Read/Write Speed | on |
| | Additional Filesystems | off |
| **Network** | Network Traffic (Upload / Download MB/s) | on |
| **Temperature** | Temperature (hottest sensors avg) | on |
| | Individual Temperature Sensors | off |
| **GPU** | GPU Metrics (Usage, Memory, Power) | off |
| **Containers** | Container Monitoring (Docker / Podman) | off |
| **Battery** | Battery Status | off |

---

## State Tree

States are organized into channels per metric group. Optional channels (marked *) are only created when the corresponding metric is enabled.

```
beszel.0.
├── info.connection                   — Connection status (bool)
└── systems.
    └── {system_name}/                — Device (sanitized name)
        ├── info/                     — System info
        │   ├── online               — Is system up? (bool, used as device indicator)
        │   ├── status               — Status string (up/down/paused/pending)
        │   ├── uptime               — Uptime in seconds
        │   ├── uptime_text          — Human-readable uptime (e.g. "14d 6h")
        │   ├── agent_version *      — Beszel agent version
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
        │   └── idle *               — CPU idle (%)
        ├── memory/                   — Memory metrics
        │   ├── percent              — RAM usage (%)
        │   ├── used                 — RAM used (GB)
        │   ├── total                — RAM total (GB)
        │   ├── buffers *            — Buffers + cache (GB)
        │   ├── zfs_arc *            — ZFS ARC (GB)
        │   ├── swap_used *          — Swap used (GB)
        │   └── swap_total *         — Swap total (GB)
        ├── disk/                     — Disk metrics
        │   ├── percent              — Disk usage (%)
        │   ├── used                 — Disk used (GB)
        │   ├── total                — Disk total (GB)
        │   ├── read                 — Disk read (MB/s)
        │   └── write                — Disk write (MB/s)
        ├── network/                  — Network metrics
        │   ├── sent                 — Upload (MB/s)
        │   └── recv                 — Download (MB/s)
        ├── temperature/              — Temperature metrics
        │   ├── average              — Avg of top 3 sensors (°C)
        │   └── sensors/ *           — Individual sensor readings
        ├── battery/ *                — Battery metrics
        │   ├── percent              — Battery level (%)
        │   └── charging             — Is charging? (bool)
        ├── gpu/ *                    — GPU metrics (per GPU)
        │   └── {gpu_name}/
        │       ├── usage            — GPU usage (%)
        │       ├── memory_used      — VRAM used (GB)
        │       ├── memory_total     — VRAM total (GB)
        │       └── power            — Power draw (W)
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
                └── image            — Image name
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

### **WORK IN PROGRESS**
- Separate test-build output (`build-test/`) from production `build/`, so `npm test` no longer risks leaving duplicated `build/src` + `build/test` trees in the published package.
- Declare `systems` folder as instance object so the parent exists before per-system devices appear.
- Wrap async `onReady` and `onMessage` with `.catch()` to prevent unhandled promise rejections from SIGKILLing the adapter.
- Drop now-redundant dynamic creation of `info` and `info.connection` in `onReady` — both are declared via `instanceObjects` and created by the adapter framework at install time.

### 0.3.3 (2026-04-19)
- Latest-repo review compliance: `common.messagebox=true` added because the `Check Connection` button in the admin UI routes through `onMessage`. Runtime behaviour unchanged.

### 0.3.2 (2026-04-18)
- API boundary hardening: every field from the Beszel Hub passes through a type-coercion layer (NaN, Infinity, missing fields, wrong types can no longer reach states)
- Records missing required identifiers (`id`, `name`) are skipped rather than written as malformed objects
- `+105` new drift tests covering primitive coercers, API response shape changes, and state-writer edge cases

### 0.3.1 (2026-04-12)
- Fix: handle response stream errors (prevents unhandled exceptions on connection drop)
- Fix: isolate per-system poll failures (one broken system no longer blocks all others)
- Fix: harden onMessage with try/catch and callback guard
- Fix: classify EHOSTUNREACH as network error for proper log deduplication

### 0.3.0 (2026-04-12)
- **Breaking:** Reorganize state tree into channels (info, cpu, memory, disk, network, temperature, battery)
- Automatic migration removes legacy flat state paths on first start
- Fix: read-only percentage states use correct `value` role instead of `level`
- Complete state tree documentation in README

### 0.2.7 (2026-04-12)
- Fix README state tree (add 8 missing default-on states), add `no-floating-promises` lint rule, remove redundant CI checkout

### 0.2.6 (2026-04-08)
- Use `node:` prefix for built-in modules (http, https, url)

### 0.2.5 (2026-04-08)
- Restore standard GitHub-based tests, remove CHANGELOG.md, add FORBIDDEN_CHARS reference

### 0.2.4 (2026-04-05)
- Cleaner log messages, remove redundant adapter name prefix

Older entries have been moved to [CHANGELOG_OLD.md](CHANGELOG_OLD.md).

---

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

*Developed with assistance from Claude.ai*
