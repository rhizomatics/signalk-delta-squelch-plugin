"use strict";

const PLUGIN_ID = "signalk-delta-squelch-plugin";

module.exports = function (app) {
  const plugin = {
    id: PLUGIN_ID,
    name: "Delta Squelch",
    description:
      "Rounds noisy SignalK values (position, temperature, velocity, heading, height, voltage, pressure, humidity) to their sensor's real precision, " +
      "squelches repeated text/boolean values (state and switch paths), and drops deltas that don't change — cutting delta volume at the " +
      "source, for every consumer, not just one subscriber.",
  };

  // ── Config schema ──────────────────────────────────────────────────────

  plugin.schema = {
    type: "object",
    properties: {
      heartbeatSeconds: {
        type: "number",
        title: "Heartbeat interval (seconds)",
        description:
          "Forward a value at least this often even if it hasn't moved past its rounding resolution, so consumers don't see a stale timestamp.",
        default: 60,
        minimum: 1,
      },
      multiSourceHeartbeatSeconds: {
        type: "number",
        title: "Multi-source heartbeat interval (seconds)",
        description:
          "Used instead of the heartbeat above for any path currently being fed by more than one $source (e.g. two GNSS receivers). " +
          "SignalK applies source priorities after this plugin and treats a squelched value as silence, so this must be shorter than " +
          "the timeout of your lower-priority sources (15s by default) or the path will flap between sources. A per-path heartbeat " +
          "override still wins. Set it to the same as the heartbeat above to turn this off.",
        default: 10,
        minimum: 1,
      },
      unchangingCountThreshold: {
        type: "integer",
        title: "Unchanging value threshold (text/boolean paths)",
        description:
          "Text and boolean values (state/switch paths, etc.) have no rounding resolution, so they're squelched by exact-value repetition instead: this many consecutive identical readings must be seen before further repeats are dropped. Earlier repeats, and the heartbeat above, are always forwarded.",
        default: 10,
        minimum: 1,
      },
      categoryResolution: {
        type: "object",
        title: "Default rounding resolution per category",
        description: "Applied to any recognised path without its own override below. Units are each category's native SignalK SI unit.",
        properties: {
          temperature: { type: "number", title: "Temperature (K, i.e. 0.01 == 0.01°C step)", default: 0.01 },
          velocity: { type: "number", title: "Velocity (m/s)", default: 0.05 },
          heading: { type: "number", title: "Heading / angle (rad, 0.01745 ≈ 1°)", default: 0.01745 },
          height: { type: "number", title: "Height / depth (m)", default: 0.1 },
          voltage: { type: "number", title: "Voltage (V)", default: 0.1 },
          pressure: { type: "number", title: "Pressure (Pa, 100 == 1 mbar)", default: 100 },
          humidity: { type: "number", title: "Humidity (ratio 0-1, 0.001 == 0.1%)", default: 0.001 },
        },
      },
      positionResolution: {
        type: "object",
        title: "Default position rounding (degrees)",
        properties: {
          latitude: { type: "number", title: "Latitude resolution (deg, 0.000001 ≈ 0.11m)", default: 0.000001 },
          longitude: {
            type: "number",
            title: "Longitude resolution (deg, 0.000001 ≈ 0.11m at Equator, 0.044m at Polar Circles )",
            default: 0.000001,
          },
        },
      },
      positionOutlier: {
        type: "object",
        title: "Position outlier rejection (anchor-watch GNSS glitch guard)",
        description:
          "Rejects a single own-vessel position spike implying an unrealistic speed. Tackles the classic anchor-watch false-alarm " +
          "problem; it does not address slow GNSS wander at rest.",
        properties: {
          enabled: { type: "boolean", title: "Enabled", default: true },
          maxVesselSpeedKnots: {
            type: "number",
            title: "Max realistic vessel speed (knots)",
            description:
              "Set above your vessel's actual top speed. A position implying faster travel than this is treated as a GNSS glitch.",
            default: 25,
            minimum: 0,
          },
          speedMarginMultiplier: { type: "number", title: "Safety margin multiplier", default: 1.5, minimum: 1 },
          minDistanceM: {
            type: "number",
            title: "Minimum spike distance (meters)",
            description:
              "A jump smaller than this is never rejected as a spike, no matter how fast it implies the vessel moved — it's ordinary " +
              "GNSS scatter, and that variation is what lets a 'cocked hat' of recent fixes average out to a better position than any " +
              "single fix.",
            default: 2,
            minimum: 0,
          },
          confirmationCount: {
            type: "integer",
            title: "Consecutive confirming samples before accepting a jump",
            description:
              "How many readings in a row must agree on the new position before it's trusted as real movement rather than a one-off spike.",
            default: 2,
            minimum: 1,
          },
          maxConfirmationGapSeconds: { type: "number", title: "Max time between confirming samples (seconds)", default: 30, minimum: 1 },
        },
      },
      paths: {
        type: "array",
        title: "Path-specific overrides",
        description: "Add an entry to override the category default for a specific path, or to handle a path that isn't auto-recognised.",
        items: {
          type: "object",
          required: ["path"],
          properties: {
            path: { type: "string", title: "SignalK path", description: 'e.g. "navigation.position" or "propulsion.main.temperature"' },
            category: {
              type: "string",
              title: "Category (optional — auto-detected if omitted)",
              enum: ["position", "temperature", "velocity", "heading", "height", "voltage", "pressure", "humidity", "custom"],
            },
            resolution: { type: "number", title: "Resolution (non-position paths)" },
            latResolution: { type: "number", title: "Latitude resolution (deg, position only)" },
            lonResolution: { type: "number", title: "Longitude resolution (deg, position only)" },
            heartbeatSeconds: { type: "number", title: "Heartbeat override (seconds)" },
            unchangingCountThreshold: {
              type: "integer",
              title: "Unchanging value threshold override (text/boolean paths)",
              minimum: 1,
            },
          },
        },
        default: [],
      },
    },
  };

  plugin.uiSchema = {
    paths: {
      items: {
        path: { "ui:placeholder": "navigation.position" },
      },
    },
  };

  // ── Start / stop ───────────────────────────────────────────────────────

  let filter = null;
  let statsTimer = null;
  const STATS_INTERVAL_MS = 60 * 60 * 1000;

  plugin.start = function (options) {
    const { SquelchFilter } = require("./lib/filter");
    filter = new SquelchFilter(options || {});

    statsTimer = setInterval(() => {
      const { total, suppressed, spikes } = filter.takeStats();
      const pct = total > 0 ? ((suppressed / total) * 100).toFixed(1) : "0.0";
      app.debug(
        `squelch: suppressed ${suppressed}/${total} value(s) (${pct}%) in the past hour, ${spikes} rejected GNSS spike(s), ` +
          `tracking ${filter.trackedKeys} path/source key(s)`,
      );
    }, STATS_INTERVAL_MS);
    statsTimer.unref?.();

    app.registerDeltaInputHandler((delta, next) => {
      // The server unregisters this handler when the plugin stops, so this
      // guard only covers a delta already in flight during stop().
      if (!filter || !delta.updates) return next(delta);

      const isSelf = delta.context === app.selfContext;

      delta.updates = delta.updates.filter((update) => {
        const source = update.$source || update.source?.label || "unknown";
        if (update.values && update.values.length > 0) {
          update.values = update.values.filter((pv) => {
            const result = filter.process(delta.context, pv.path, pv.value, isSelf, source);
            if (!result.keep) {
              if (result.reason === "spike") {
                const { from, to, source: spikeSource, distanceM, impliedSpeedMs, elapsedS } = result.spike;
                const loggedContext = isSelf ? "self" : delta.context;
                app.debug(
                  `squelch: rejected GNSS spike on ${loggedContext}:${pv.path} [${spikeSource || "unknown"}] — ` +
                    `(${from.latitude}, ${from.longitude}) -> (${to.latitude}, ${to.longitude}) ` +
                    `over ${elapsedS.toFixed(2)}s, ${distanceM.toFixed(1)}m implying ${impliedSpeedMs.toFixed(2)}m/s`,
                );
              }
              return false;
            }
            pv.value = result.value;
            return true;
          });
        }
        return (update.values && update.values.length > 0) || (update.meta && update.meta.length > 0);
      });

      if (delta.updates.length > 0) next(delta);
      // else: the whole delta was redundant noise — intentionally dropped
    });

    app.setPluginStatus("Filtering active");
  };

  plugin.stop = function () {
    filter = null;
    if (statsTimer) clearInterval(statsTimer);
    statsTimer = null;
  };

  return plugin;
};
