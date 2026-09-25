# ioBroker.beszel — User documentation

This adapter mirrors a [Beszel](https://beszel.dev) Hub into ioBroker. Beszel is a lightweight
server monitor: small agents run on the machines you want to watch and report to a central Hub;
the adapter reads that Hub over its REST API and writes one device per monitored system.

Everything is read-only. The adapter never writes to the Hub and creates no writable datapoints.

- [Datapoints and metric switches](datapoints.md)
- [Questions and troubleshooting](faq.md)

## Before you start

You need a running Beszel Hub with at least one agent connected, and a login for that Hub.
The adapter authenticates as a normal Beszel user — the same e-mail address and password you use
for the Beszel web interface; Beszel does not accept a username there. An admin account is not
required, but multi-factor authentication must be off for that user: the adapter cannot answer
the one-time code.

The user only sees the systems it is assigned to: the ones it added itself, the ones a Hub admin
added it to (PocketBase admin panel at `/_/`, collection `systems`, field `users`), or every system
when the Hub runs with `SHARE_ALL_SYSTEMS=true`. A user that is assigned to nothing logs in fine
and sees an empty list — the connection test says so.

## Setting it up

1. **Install and create an instance.** In ioBroker, install `beszel` and open the instance settings.
2. **Enter the Hub URL** under _Beszel Hub URL_ — the same address you open the Beszel web
   interface with, for example `http://192.168.1.100:8090`. An IPv6 address goes in brackets:
   `http://[fd00::1]:8090`. Both `http` and `https` work; an https Hub needs a certificate the
   ioBroker host trusts. A Hub behind a reverse proxy keeps its path
   (`https://example.org/beszel`). Spaces and a trailing slash are removed; a URL with `?`, `#` or
   a user name and password in it is refused.
3. **Enter e-mail and password** of your Beszel login.
4. **Press _Test Connection_.** It performs a real login against the Hub and reports how many
   systems your user can see — or the actual error if something is wrong: a refused login, an
   unreachable host, a typo in the URL.
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
they cannot overwrite each other, and the adapter warns once when that happens. A name without any
Latin letter or digit (Cyrillic, Chinese, …) becomes `sys_` plus a short hash of the Hub's system
id, so it stays the same across restarts.

Renaming a system on the Hub moves it to a new device id: the adapter logs
`System renamed on the Hub: systems.a → systems.b`, and the old tree goes — including history
and other settings you made on its datapoints. Removing a system is logged the same way.

## How the adapter behaves when something is missing

- **A system goes down or is paused.** Its `info.online` turns false and `info.status` shows what
  the Hub says. The measured values stay at their last reading rather than jumping to zero —
  the adapter reports what it knows, and it knows nothing new.
- **The Hub becomes unreachable.** `info.connection` turns false, every system goes to
  `info.online: false` and `info.status: unknown`, and the fleet counters drop to zero. The same
  happens when you stop the instance, so nothing keeps claiming to be online while nobody reads.
- **The Hub answers with an empty list.** Nothing is deleted. PocketBase answers a login it no
  longer accepts (a changed password, a deleted user, a restored Hub database) with an empty list
  instead of an error, so the adapter first logs in again and asks once more. If the list stays
  empty, the tree stays as it is and the log says once that the user sees no systems.
- **The login is refused.** The log says why — wrong e-mail or password, multi-factor
  authentication, or password login switched off on the Hub. After three failures the adapter
  retries at growing intervals, at most every 15 minutes, instead of sending the password every
  poll.
- **A sensor, fan, GPU, filesystem, container or any other group member disappears.** Its
  datapoints are removed once it has been missing in two consecutive polls — a single hiccup does
  not clear anything.
- **A list is longer than the adapter reads.** The adapter reads at most 50 pages per list (1000
  records each for the lists of systems, containers, units and devices). On a Hub large enough to
  exceed that, the cut-off list is reported once and leaves the tree as it is, instead of deleting
  the systems at its end.

## Updating

An update reapplies names and descriptions to the datapoints you already have, so corrected
wording and new translations reach existing installations, not just fresh ones. The consequence
is that a datapoint you renamed yourself in the admin gets the adapter's name back on the next
start.
