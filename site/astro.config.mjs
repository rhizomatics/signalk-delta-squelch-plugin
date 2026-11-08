// @ts-check
import { defineConfig } from "astro/config";
import starlight from "@astrojs/starlight";

// https://astro.build/config
export default defineConfig({
  site: "https://rhizomatics.github.io",
  base: "/signalk-delta-squelch-plugin",
  integrations: [
    starlight({
      title: "Delta Squelch for SignalK",
      description:
        "Clean up noisy SignalK path deltas by rounding to sensor's real precision and throttling insignificant or unchanging deltas.",
      favicon: "/favicon.png",
      social: [
        {
          icon: "github",
          label: "GitHub",
          href: "https://github.com/rhizomatics/signalk-delta-squelch-plugin",
        },
      ],
      // The single page is generated from ../README.md by scripts/sync-docs.mjs; its sections appear in the
      // right-hand "On this page" table of contents.
      sidebar: [{ label: "Overview", link: "/" }],
    }),
  ],
});
