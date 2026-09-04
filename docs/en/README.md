# ioBroker.beszel — User documentation

This adapter mirrors a [Beszel](https://beszel.dev) Hub into ioBroker. Beszel is a lightweight
server monitor: small agents run on the machines you want to watch and report to a central Hub;
the adapter reads that Hub over its REST API and writes one device per monitored system.

Everything is read-only. The adapter never writes to the Hub and creates no writable datapoints.

- [Datapoints and metric switches](datapoints.md)
- [Questions and troubleshooting](faq.md)

## Before you start

You need a running Beszel Hub with at least one agent connected, and a login for that Hub.
The adapter authenticates as a normal Beszel user — the same email and password you use for the
Beszel web interface. An admin account is not required.

If you want container data, that user also needs read access to the Hub's `containers` collection.
Without it every other metric still works; the adapter warns once and keeps the container
datapoints it already created.

## Setting it up

1. **Install and create an instance.** In ioBroker, install `beszel` and open the instance settings.
2. **Enter the Hub URL** under _Beszel Hub URL_ — the same address you open the Beszel web
   interface with, for example `http://192.168.1.100:8090`. An IPv6 address goes in brackets:
   `http://[fd00::1]:8090`. Both `http` and `https` work; over `http` to a machine other than the
   ioBroker host, login and token travel the network unencrypted and the adapter says so once in
   the log.
3. **Enter username and password.** The username is the email address of your Beszel login.
4. **Press _Test Connection_.** It performs a real login against the Hub and reports the actual
   error if something is wrong — a wrong password, an unreachable host, a typo in the URL.
5. **Choose your metrics** on the _Metrics_ tab (see [Datapoints and metric switches](datapoints.md)).
   The defaults cover uptime, CPU, load average, memory, disk, disk throughput, network and
   temperature. Everything else is off until you switch it on.
6. **Save.** The instance starts, reads the Hub once, and creates the object tree.

## Poll interval and timeout

_Poll Interval_ accepts 10 to 300 seconds and defaults to 60. Beszel's agents record one
measurement per minute, so a value below 60 seconds produces extra requests without newer data.
A value entered outside that range — for example by a script writing the config directly — is
clamped rather than accepted.

_Request timeout_ (5 to 120 seconds, default 15) is how long a single request may take. Raise it
for a slow link or a Hub with many containers.

## What the adapter creates

```
beszel.0.
├── info.connection      is the Hub reachable
├── info.systemsTotal    systems registered on the Hub
├── info.systemsOnline   of those, how many report "up"
├── info.systemsAllUp    true while all of them do
└── systems.<name>.      one device per monitored system
```

The device name is the system name from the Hub, lower-cased with anything that is not a letter
or digit replaced by `_`. Two systems whose names reduce to the same id get a short hash suffix so
they cannot overwrite each other, and the adapter warns once when that happens.

## How the adapter behaves when something is missing

- **A system goes down or is paused.** Its `info.online` turns false and `info.status` shows what
  the Hub says. The measured values stay at their last reading rather than jumping to zero —
  the adapter reports what it knows, and it knows nothing new.
- **The Hub becomes unreachable.** `info.connection` turns false, every system goes to
  `info.online: false` and `info.status: unknown`, and the fleet counters drop to zero. The same
  happens when you stop the instance, so nothing keeps claiming to be online while nobody reads.
- **The Hub answers with an empty list.** Nothing is deleted. An outage must not wipe your object
  tree, so devices only disappear when the Hub genuinely reports a shorter list.
- **A sensor, fan, GPU, filesystem or container disappears.** Its datapoints are removed. If a
  whole group empties at once, the adapter waits for a second consecutive poll before deleting —
  a single hiccup does not clear the tree.

## Updating

An update reapplies names and descriptions to the datapoints you already have, so corrected
wording and new translations reach existing installations, not just fresh ones. The consequence
is that a datapoint you renamed yourself in the admin gets the adapter's name back on the next
start.
