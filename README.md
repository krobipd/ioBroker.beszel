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
- Automatic token refresh (every 23 hours) and re-authentication on 401
- Connection test button directly in the admin UI
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
| | CPU Breakdown (User / System / IOWait / Idle) | off |
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

```
beszel.0.
├── info.connection          — Connection status (bool)
└── systems.
    └── {system_name}/       — Device (sanitized name)
        ├── online           — Is system up? (bool)
        ├── status           — Status string (up/down/paused/pending)
        ├── uptime           — Uptime in seconds
        ├── uptime_text      — Human-readable uptime (e.g. "14d 6h")
        ├── cpu_usage        — CPU %
        ├── memory_percent   — RAM %
        ├── memory_used      — RAM used (GB)
        ├── disk_percent     — Disk %
        ├── network_sent     — Upload (MB/s)
        ├── network_recv     — Download (MB/s)
        ├── temperature      — Avg temperature (°C)
        ├── temperatures/    — Individual sensors (if enabled)
        ├── gpu/             — GPU metrics (if enabled)
        ├── filesystems/     — Extra filesystems (if enabled)
        └── containers/      — Container metrics (if enabled)
```

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

### 0.2.0 (2026-03-28)
- Adapter timer methods, synchronous onUnload, merge About tab, Windows/macOS CI, full MIT license

### 0.1.9 (2026-03-19)
- Logging cleanup: stale system removal moved to debug level

### 0.1.8 (2026-03-19)
- Add online/offline indicator to system device folders

### 0.1.7 (2026-03-19)
- Add system count to startup log message

### 0.1.6 (2026-03-18)
- Code cleanup: remove dead code, fix duplicate container filter, extract load avg helper

### 0.1.5 (2026-03-17)
- Migrate to @alcalzone/release-script, enable npm Trusted Publishing

### 0.1.4 (2026-03-17)
- Fix all repochecker issues; rename repo to ioBroker.beszel; add responsive grid sizes

Older changelog: [CHANGELOG.md](CHANGELOG.md)

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
