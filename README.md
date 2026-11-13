# signalk-delta-squelch-plugin

[![npm version](https://img.shields.io/npm/v/@rhizomatics/signalk-delta-squelch-plugin.svg)](https://www.npmjs.com/package/@rhizomatics/signalk-delta-squelch-plugin)
[![npm downloads](https://img.shields.io/npm/dm/@rhizomatics/signalk-delta-squelch-plugin.svg)](https://www.npmjs.com/package/@rhizomatics/signalk-delta-squelch-plugin)
[![SignalK Plugin CI](https://github.com/rhizomatics/signalk-delta-squelch-plugin/actions/workflows/signalk-ci.yml/badge.svg)](https://github.com/rhizomatics/signalk-delta-squelch-plugin/actions/workflows/signalk-ci.yml)
![code style: oxfmt](https://img.shields.io/badge/code_style-oxfmt-blue.svg)
[![License](https://img.shields.io/badge/License-Apache_2.0-blue.svg)](https://github.com/rhizomatics/signalk-delta-squelch-plugin/blob/main/LICENSE)
[![boat tech directory](https://boat-tech-directory.rhizomatics.org.uk/images/badge.svg)](https://boat-tech-directory.rhizomatics.org.uk) [![managed by hq](https://raw.githubusercontent.com/rhizomatics/hq/main/assets/badge-managed-by-hq.svg)](https://hq.rhizomatics.org.uk/)

Cuts noisy, redundant SignalK deltas at the source, before they reach the full
data model, other plugins, or connected clients. Reduce size of stored data both by removing pointless changes, and better efficiency for analytic column-store databases.

Use at own risk, incorrect configuration for your boat's systems may mean GNSS (e.g. GPS) positions on plotters or anchor trackers are stale, and likewise for depth, tide or wind data.

## The problem

Sources like GPS receivers emit far more precision, and far more frequent
updates (10Hz for modern ones), than the physical measurement actually supports. At anchor, a typical
GPS fix wanders by several metres from multipath and receiver noise alone —
producing a stream of deltas like this example for a berthed boat:

```json
{"path": "navigation.position", "value": {"latitude": 54.372581233333334, "longitude": -4.907908233333333}}
{"path": "navigation.position", "value": {"latitude": 54.3725812,         "longitude": -4.907908233333333}}
{"path": "navigation.position", "value": {"latitude": 54.3725811,         "longitude": -4.9079082499999995}}
```

None of that movement is real; all of it costs CPU, eMMC and SD Card wear, and power to generate, log, and re-broadcast — multiplied by every plugin and client subscribed to the path. Throttling a single websocket subscription doesn't help: the noise is still generated, still processed by every other consumer, and often still written to disk.

There's an additional benefit if using a column-oriented data store to archive data, such as Parquet, InfluxDB or QuestDB - these databases are much more efficient where there are fewer unique values to store (the 'cardinality') so trimming off the false millimetre position resolution can save on CPU and disk space both when writing data and later querying.

And if you're watching an anchor tracker, there's a little less meaningless clutter on the boat tracks.

## What this plugin does

It registers a [`registerDeltaInputHandler`](https://demo.signalk.org/documentation/develop/plugins/server_plugin_api.html) — a hook that runs _before_ the server applies a delta to the full data model
or forwards it to anyone. For each value on a recognised path, it:

1. **Rounds** the value to a resolution matching the sensor's real-world
   accuracy (configurable per category, or per path).
2. **Removes** updates that don't move past that resolution, so consumers
   see clean, sensible numbers arriving only when something actually changed.
3. **Squelches unchanging text/boolean values** — state and switch
   paths — once the same value has been seen for a configurable
   number of consecutive readings in a row (10 by default).
4. Forwards a **heartbeat** at a configurable interval even with no
   change, so nothing downstream mistakes a quiet source for a dead one.
5. Optionally **rejects GNSS position spikes** — the classic anchor-watch
   false-alarm cause, where a single bad fix implies the boat teleported —
   while always letting through small jumps that are just ordinary GNSS
   scatter, not glitches.

Everything is gated on the _raw_ value with a hysteresis margin (1.5× the
rounding step), not the rounded value — a reading sitting right on a rounding
boundary won't flip back and forth every sample.

### Categories and defaults

| Category      | Matches (auto-detected)                                      | Default resolution           |
| ------------- | ------------------------------------------------------------ | ---------------------------- |
| `position`    | `navigation.position` only                                   | 0.000001° lat & lon (~0.11m) |
| `temperature` | any path containing "temperature"                            | 0.01 K                       |
| `velocity`    | any path containing "speed"                                  | 0.05 m/s (~0.1 knot)         |
| `heading`     | heading / course / angle / direction / variation / deviation | 0.01745 rad (~1°)            |
| `height`      | depth / height / altitude / draft / freeboard                | 0.1 m                        |
| `voltage`     | any path containing "voltage"                                | 0.1 V                        |
| `pressure`    | any path containing "pressure"                               | 100 Pa (1 mbar)              |
| `humidity`    | any path containing "humidity"                               | 0.001 (0.1%)                 |

Any path that doesn't match one of these is passed through untouched unless
you add an explicit override.

For older GPS antenna, without modern L5 and SBAS for high resolution, `0.00001` may be more appropriate, the default setting covers modern systems that have <1m resolution.

### Text and boolean values

Paths whose value is a string or boolean (autopilot state, switch
positions, ...) have no physical resolution to round to, so
they're squelched by exact-value repetition instead: a value is only dropped
once it's been seen unchanged for `unchangingCountThreshold` consecutive
readings in a row (10 by default). Earlier repeats, any change of value, and
the heartbeat are always forwarded — so a path that only ever emits on an
actual change is never squelched at all, and a flappy or rarely-updated path
still gets the same protection as numeric ones.

This applies to any path emitting a string or boolean value; there's no
category to auto-detect since there are no units or rounding step involved.

### Position outlier rejection (anchor-watch GNSS spikes)

A single position implying a speed above your configured maximum (with a
safety margin) is treated as a GNSS glitch and dropped — the boat stays at its
last good fix. If several readings in a row _agree_ on the new location
within a short window, it's accepted as real movement (e.g. after a GNSS
dropout), not a one-off spike.

A jump smaller than **minimum spike distance** (2m by default) is never
rejected, no matter how fast it implies the boat moved. At that scale it's
ordinary GNSS scatter, not a glitch — and that scatter is useful: a "cocked
hat" of nearby fixes spread over time can average out to a better position
estimate than trusting any single fix, so it's worth keeping rather than
squelching away.

This only applies to the vessel's own position (`app.selfContext`) — an AIS
target moving fast isn't an anomaly just because it isn't us — and it only
addresses large, single-fix jumps. It does **not** fix slow GNSS wander at
anchor - these are genuinely different problems: a spike is one bad sample surrounded by good ones, wander is every sample being slightly wrong in a way no single-sample check can detect.

All squelch state (position or otherwise) is tracked per `$source` as well as
per path. This plugin runs upstream of the server's own source-priority
resolution, so a path fed by more than one device (e.g. a chartplotter GNSS
and an AIS transceiver's own GNSS both reporting `navigation.position`) is
seen here as each source's raw, independent stream — never compared against
each other. Without that, a legitimate correction from a poorer fix to a
better one (or a source switch driven by your SignalK priority rules) could
look like the boat teleporting relative to whichever source reported last,
and get wrongly rejected as a spike. The rejected-spike debug log names the
context (`self` for the vessel's own position), path, and source together,
along with the two positions, the time elapsed between them, and the
distance and implied speed that triggered the rejection — enough to tell
which device is actually the noisy one.

Notifications (`notifications.*`) are objects, not strings, so they always
pass through untouched.

### Source priorities

SignalK applies your source priorities _after_ this plugin. A lower-priority
source takes over a path once the preferred source has been silent for that
source's timeout (15 seconds by default for a ranked source, 10 seconds for an
unranked one). A squelched value counts as silence, so with the default
60 second heartbeat a steady preferred GNSS, for example at anchor, can lose
`navigation.position` to the backup source between heartbeats, and the boat
appears to jump between the two.

To stop that, any path currently fed by more than one `$source` automatically
gets a shorter **multi-source heartbeat** (10 seconds by default, under the
15 second timeout). A path drops back to the normal heartbeat once its other
sources have been silent for 10 normal heartbeats. If you've changed the
source timeouts in your priority rules, set the multi-source heartbeat below
the shortest of them, less one sample interval; a per-path heartbeat override
always takes precedence.

### Memory use

Squelch state is kept per context, path and source, so every AIS target adds
entries. State for anything not seen for 10 of its heartbeat intervals is
dropped, so memory tracks the targets currently in range rather than every
target seen since the server started. The hourly debug summary reports how
many path/source keys are being tracked.

## Configuration

All of the above is configurable from the plugin's config screen:

- **Heartbeat interval** — global default, overridable per path.
- **Multi-source heartbeat interval** — used for paths fed by more than one
  source (10s default).
- **Unchanging value threshold** — global default (10) for how many
  consecutive identical text/boolean readings are forwarded before
  squelching kicks in, overridable per path.
- **Default rounding resolution per category** — temperature, velocity,
  heading, height, voltage, pressure, humidity (native SignalK SI units), and
  position (lat/lon in degrees, settable independently).
- **Position outlier settings** — enable/disable, max vessel speed (knots),
  safety margin multiplier, minimum spike distance (2m default — jumps below
  this are never rejected), confirmation count, and confirmation window.
- **Path-specific overrides** — add a path to set its own resolution (or
  lat/lon resolution, for position-shaped paths), category, heartbeat, or
  unchanging value threshold, overriding the category default or handling a
  path that isn't auto-recognised.

## Install

Install from the SignalK admin UI **Apps & Plugins** **Store**, or:

```bash
cd ~/.signalk && npm install @rhizomatics/signalk-delta-squelch-plugin
```

Then enable it under **Apps & Plugins** → **Configuration*** → **Delta Squelch**.

## License

Apache-2.0
