#!/usr/bin/env node
// Builds the site's home page from the repo's README.md, so GitHub, npm and the site all read from
// the same file and never drift. Runs automatically before `dev`/`build` (see package.json pre* scripts).
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const siteDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const rootDir = resolve(siteDir, "..");
const pkg = JSON.parse(readFileSync(resolve(rootDir, "package.json"), "utf8"));
const repoUrl = "https://github.com/rhizomatics/signalk-delta-squelch-plugin/blob/main/";

let body = readFileSync(resolve(rootDir, "README.md"), "utf8");
// Starlight renders the title from frontmatter, so drop the README's own `#` heading.
body = body.replace(/^#\s+.*\n+/, "");
// Relative links to repo files (LICENSE, BUILD.md, ...) don't exist on the site - point them at GitHub.
body = body.replace(/\]\((?!https?:|#|mailto:)([^)]+)\)/g, (_, target) => `](${repoUrl}${target.replace(/^\.\//, "")})`);

const frontmatter = [
  "---",
  `title: ${pkg.signalk?.displayName ?? pkg.name}`,
  `description: ${JSON.stringify(pkg.description)}`,
  "---",
  "",
  "<!-- Generated from ../README.md by scripts/sync-docs.mjs - edit the README, not this file. -->",
  "",
].join("\n");

const out = resolve(siteDir, "src/content/docs/index.md");
mkdirSync(dirname(out), { recursive: true });
writeFileSync(out, frontmatter + body);
console.log(`synced README.md -> ${out.slice(siteDir.length + 1)}`);
