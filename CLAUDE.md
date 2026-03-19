# CLAUDE.md — ioBroker.beszel

## Project Overview

ioBroker adapter for [Beszel](https://github.com/henrygd/beszel) server monitoring.

- **Adapter name:** `beszel`
- **NPM package:** `iobroker.beszel`
- **GitHub:** `krobipd/ioBroker.beszel`
- **Version:** `0.1.8`
- **Author:** krobi <krobi@power-dreams.com>
- **Mode:** daemon (polling)
- **No extra runtime dependencies** — uses only `@iobroker/adapter-core` + Node.js built-in `http`/`https`

## Beszel API

### Base URL
User-configured (e.g. `http://192.168.1.100:8090`).

### Authentication
- `POST /api/collections/users/auth-with-password`
- Body: `{ identity, password }`
- Returns `{ token, record }`
- Token valid ~7 days; adapter refreshes after 23h or on 401

### Collections
| Endpoint | Purpose |
|----------|---------|
| `GET /api/collections/systems/records?perPage=200&sort=name` | All monitored systems |
| `GET /api/collections/system_stats/records?sort=-updated&perPage=200&filter=type%3D'1m'` | Latest 1-min stats per system |
| `GET /api/collections/containers/records?perPage=500&sort=system%2Cname` | Container metrics |

### Key fields
- `systems`: `id, name, status (up/down/paused/pending), host, info { u, v, sv, la, bat }`
- `system_stats`: `id, system (ref to systems.id), type, stats { cpu, mu, m, mp, mb, mz, su, s, du, d, dp, dr, dw, ns, nr, t, la, g, efs, bat, cpub, b }`
- `containers`: `id, system, name, status, health (0-3), cpu, memory, image`

## Source Files

| File | Purpose |
|------|---------|
| `src/main.ts` | Adapter class (lifecycle, polling, message handling) |
| `src/lib/types.ts` | TypeScript interfaces for Beszel API + adapter config |
| `src/lib/beszel-client.ts` | HTTP client (auth, systems, stats, containers) |
| `src/lib/state-manager.ts` | Create/update/cleanup ioBroker states |

## State Structure

```
beszel.0.
├── info.connection          (bool, indicator.connected)
└── systems.{sanitized_name}/
    ├── online               (bool, always)
    ├── status               (string, always)
    ├── uptime / uptime_text (if metrics_uptime)
    ├── cpu_usage            (if metrics_cpu)
    ├── load_avg_*           (if metrics_loadAvg)
    ├── memory_*             (if metrics_memory)
    ├── disk_*               (if metrics_disk / metrics_diskSpeed)
    ├── network_*            (if metrics_network)
    ├── temperature          (if metrics_temperature — avg top 3 sensors)
    ├── temperatures/        (if metrics_temperatureDetails)
    ├── gpu/                 (if metrics_gpu)
    ├── filesystems/         (if metrics_extraFs)
    └── containers/          (if metrics_containers)
```

## Config Options (native)

All boolean metric flags default to `false` except:
`metrics_uptime`, `metrics_cpu`, `metrics_loadAvg`, `metrics_memory`, `metrics_disk`, `metrics_diskSpeed`, `metrics_network`, `metrics_temperature` — these default to `true`.

## Important Notes

1. `build/` is committed to git (`.gitignore` excludes only `build/test/`)
2. `encryptedNative`/`protectedNative` are on **root level** of `io-package.json`
3. Token is stored in memory only — never in ioBroker states
4. Load avg: prefer `stats.la`, fallback to `system.info.la`
5. Temperature: compute average of top 3 hottest sensors for `temperature` state
6. Name sanitization: lowercase, non-alphanumeric → `_`, max 50 chars, trim underscores

## Build Commands

```bash
npm run build           # Full build (rm -rf build + tsc)
npm run build:test      # Build for tests (includes test/ directory)
npm run check           # TypeScript type check only (no emit)
npm run lint            # ESLint
npm test                # Build + run Mocha tests (ACHTUNG: überschreibt Production-Build!)
npm run release patch   # Release via @alcalzone/release-script
```

## Release-Workflow

`manual-review` Plugin blockiert interaktiv → manueller Workaround:
```bash
# 1. CHANGELOG.md unter ## **WORK IN PROGRESS** befüllen
# 2. npm run build  (NICHT npm test!)
# 3. Version in package.json + io-package.json bumpen
# 4. CHANGELOG + README (Badge + Changelog-Section) aktualisieren
# 5. io-package.json news (alle 11 Sprachen) hinzufügen
# 6. git add ... && git commit -m "chore: release vX.Y.Z"
# 7. git tag vX.Y.Z && git push && git push origin vX.Y.Z
```
