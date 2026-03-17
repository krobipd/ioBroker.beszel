# ioBroker.beszel

![Version](https://img.shields.io/badge/version-0.1.0-blue)
![Node](https://img.shields.io/badge/node-%3E%3D20-brightgreen)
![TypeScript](https://img.shields.io/badge/TypeScript-strict-blue)
![License](https://img.shields.io/badge/license-MIT-green)
[![PayPal](https://img.shields.io/badge/Donate-PayPal-blue.svg)](https://paypal.me/krobipd)
![npm downloads](https://img.shields.io/npm/dt/iobroker.beszel)
![Installations](https://iobroker.live/badges/beszel-installed.svg)

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

## Installation

Install via the ioBroker Admin UI:

1. Open Admin → Adapters
2. Search for **Beszel**
3. Click Install

Or from GitHub (Expert Mode → Install from GitHub → `krobipd/ioBroker.beszel`).

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

## Development

The adapter is fully written in **TypeScript** with `strict` mode. No extra runtime dependencies — the Beszel API client uses only Node.js built-in `http`/`https` modules.

```bash
npm run build      # Build
npm test           # Tests
npm run lint       # Lint
npm run watch      # Watch mode
npm run check      # TypeScript type check only
```

### Project Structure

```
src/
├── main.ts                # Adapter main class
└── lib/
    ├── types.ts           # TypeScript interfaces
    ├── beszel-client.ts   # Beszel API HTTP client
    └── state-manager.ts   # ioBroker state management
test/
└── testPackageFiles.ts    # Package validation tests
build/                     # Compiled JavaScript (committed to git)
admin/
├── jsonConfig.json        # Admin UI schema
├── beszel.svg             # Adapter icon
└── i18n/                  # Translations (11 languages)
```

---

## Changelog

See [CHANGELOG.md](CHANGELOG.md).

---

## Support

- [ioBroker Forum](https://forum.iobroker.net/)
- [GitHub Issues](https://github.com/krobipd/iobroker.beszel/issues)

If this adapter is useful to you, consider a small donation:

[![PayPal](https://img.shields.io/badge/Donate-PayPal-blue.svg)](https://paypal.me/krobipd)

---

## License

MIT License — see [LICENSE](LICENSE)

---

*Developed with support from Claude.ai*
