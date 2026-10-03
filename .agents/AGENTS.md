# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm install               # install dependencies (oxlint/oxfmt only — zero runtime deps)
npm test                  # run the test suite (node:test)
npm run test:coverage     # same, plus coverage report (90% line/functions, 85% branches)
npm run lint              # oxlint
npm run fmt:check         # oxfmt --check
npm run fmt               # oxfmt (auto-fix)
```

There is no build step. The plugin is loaded by the SignalK server from `index.js`.

To exercise it locally, install into a running SignalK server:

```bash
cd ~/.signalk/node_modules && ln -s /path/to/signalk-delta-squelch-plugin @rhizomatics/signalk-delta-squelch-plugin
```

## Architecture

CommonJS SignalK plugin (factory function exporting `{id, name, description, schema, start, stop}`).
All the actual logic is pure and lives in `lib/`, tested directly without touching `app.*`; `index.js`
is a thin wire-up between the SignalK plugin API and that logic.

```
index.js
  → app.registerDeltaInputHandler(...)   — runs before the server applies/broadcasts any delta
    → for each update.values[] entry:
      → lib/filter.js: SquelchFilter#process(context, path, value, isSelf, source)
        → lib/categorize.js: categorize(path)   — auto-detect category, or use a path override
        → lib/geo.js: haversineMeters / roundTo / knotsToMs
      → returns { keep, value } — drop the value, or replace it with its rounded form
    → updates/deltas left with no values (and no meta) are dropped entirely;
      next(delta) is only called if something survives
```

### Why `registerDeltaInputHandler` and not a subscription-level throttle

A per-subscription throttle (e.g. a websocket client's `minPeriod` policy) only reduces traffic to
that one subscriber — the noisy deltas are still generated, still processed by every other plugin,
and often still logged to disk. `registerDeltaInputHandler` runs once, upstream of the full data
model and every consumer (other plugins, REST/websocket clients, loggers), so filtering there is the
only way to reduce the actual CPU/eMMC/power cost rather than just hiding it from one client. See
the [SignalK server-api docs](https://demo.signalk.org/documentation/develop/plugins/server_plugin_api.html).

### `lib/filter.js` — `SquelchFilter`

The stateful core. One instance per plugin `start()`, holding three maps keyed by
`` `${context}:${path}:${source}` `` (`source` being the delta update's `$source`) — this plugin runs
upstream of the server's own source-priority resolution, so a path fed by more than one device is
seen here as each source's raw, independently-noisy stream, interleaved. Keying state per-source
stops one source's readings from being compared against another's — otherwise a legitimate switch
from a poor fix to a better one can look like the vessel teleporting relative to whichever source
happened to report last:

- `lastAccepted` — the last raw value actually forwarded, plus its timestamp. Movement is always
  checked against this _raw_ value, not the rounded one, with a `1.5×` resolution margin
  (`HYSTERESIS_FACTOR`) — comparing against the rounded value would let a reading sitting on a
  rounding-grid boundary chatter back and forth every sample.
- `pendingSpike` — position-only, tracks a candidate cluster of rejected (spike) readings so a
  _real_ jump (e.g. after a GPS dropout) can still be confirmed and accepted after enough
  consecutive samples agree, rather than freezing the position forever.
- `unchangingCount` — text/boolean-only, counts consecutive identical readings so far.

`resolveConfig(path)` resolves category + resolution once per path: an explicit entry in the
`paths` config array wins, else `categorize()`'s auto-detected category and its default resolution,
else `null` (path untouched). Position is special-cased throughout since its value is a
`{latitude, longitude}` object rather than a scalar, and needs two independent resolutions.

`process()` special-cases `typeof rawValue === "boolean" || "string"` before consulting
`resolveConfig`/`categorize()` at all — text/boolean values (notification, state, switch paths) have
no unit or rounding step, so there's no category to auto-detect. `_processState` dedupes on exact
equality instead of a resolution: the first `unchangingCountThreshold` consecutive identical
readings (default 10, `resolveConfig`-independent — see `_stateConfig`) are still forwarded, and only
once that streak is exceeded does it start being squelched, subject to the same heartbeat as numeric
paths. A path that only ever emits on a real change never reaches the threshold and is never
squelched.

Position outlier rejection (`_isSpike`) is only invoked when `isSelf` is true — an AIS contact
travelling fast isn't a "spike" just because it isn't the vessel we're on.

### `lib/categorize.js`

Keyword-based path → category mapping (`temperature`, `velocity`, `heading`, `height`) plus the
literal `navigation.position` check for `position`. Deliberately simple regexes over SignalK's path
vocabulary; a path outside these five categories needs an explicit `paths` config entry with its own
`category`/`resolution` to be handled at all.

### `lib/geo.js`

`haversineMeters`, `knotsToMs`, and `roundTo`. `roundTo` runs the snapped value through
`toPrecision(12)` before returning — a plain `Math.round(v / r) * r` leaves binary float noise
behind (e.g. `288.09999999999997` instead of `288.1`), which would defeat the point of rounding to a
"sensible" value in the first place.

## Testing

All three `lib/` modules are pure and tested directly via `node:test`, injecting a controllable
clock (`{ now: () => t }`) into `SquelchFilter` rather than relying on real time — this is what lets
`test/filter.test.js` assert on hysteresis and heartbeat timing deterministically. The position
rounding test uses the exact at-anchor GPS sample sequence that motivated this plugin.
