# Changelog

All notable changes to this plugin are documented here. Format loosely follows [Keep a Changelog](https://keepachangelog.com/).

## [0.5.0]

- Paths fed by more than one `$source` automatically get a shorter heartbeat, so a steady preferred source isn't mistaken for a silent one by SignalK's source priorities and the path doesn't flap between sources
  - Defaults to 10 seconds, configurable as `multiSourceHeartbeatSeconds`
  - A per-path heartbeat override still wins
  - A path drops back to the normal heartbeat once its other sources have been silent for 10 heartbeats
- Squelch state is now pruned for any context/path/source not seen for 10 of its heartbeat intervals, so memory no longer grows with every AIS target seen since restart
- Hourly debug summary includes the number of path/source keys being tracked

## [0.4.6]

- Correct missing changed from 0.4.5

## [0.4.5]

- Apply a configurable minimum distance for rejecting GNSS spikes
  - Defaults to 2m
  - Can be configured to anything, including down to 0m, in the plugin config

## [0.4.4]

- When logging a GNSS spike, include the elapsed time between the two positions

## [0.4.3]

- Refer to `GNSS spikes` rather than `GPS Spikes` since could be Galileo, Glonass, Beidou etc
- When logging GNSS spikes, refer to current boat as `self` rather than its full URN

## [0.4.2]

- Log squelch as a percentage of total delta volume over period

## [0.4.1]

- Improved handling of GNSS position spikes
  - Elapsed time floor moved to 50ms from 1ms to cope better with modern 10Hz GPS
  - Multiple GNSS sources handled independently
- Improved logging of rejected GNSS position spikes

## [0.4.0]

- Squelching repeated values now only kicks in after a sequence of n unchanging values, where n is configurable and defaults to 10
  - This helps avoid trying to squelch genuinely changing data that has occasional repeat
- Squelching applies also to repeated text and boolean values

## [0.3.1]

- Adjusted defaults
- Position one extra decimal place, to support by default modern <1m resolution GPS, e.g. Garmin 24xd
- Temperature one extra decimal place, since Kelvin conversion is always to two decimal places

## [0.3.0]

- Additional logging, to summarize suppressed deltas, and for spike detection

## [0.2.0]

- Added voltage, humidity and pressure to scope

## [0.1.0]

- Initial release
- Rounds/squelches position, temperature, velocity, heading, and height paths via `registerDeltaInputHandler`
- Anchor-watch GNSS (e.g. GPS) spike rejection for the vessel's own position, with multi-sample confirmation for real jumps, ignores other AIS vessels
- Per-path overrides (category, resolution, lat/lon resolution, heartbeat)
