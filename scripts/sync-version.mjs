/**
 * Copy package.json's version into `src/server.ts`.
 *
 * Run by npm's `version` lifecycle hook, which fires after package.json has been
 * bumped and before anything is committed — so one `npm version` moves both
 * files, and the pair cannot drift by way of somebody editing one and
 * forgetting the other.
 *
 * The constant stays a literal rather than becoming a `readFileSync` of the
 * manifest: `server.ts` is what a client is told it connected to, and a
 * handshake that dies because a file moved under the build is a worse trade
 * than a line this script keeps in step. The version check in
 * `src/server.test.ts` is the backstop if it ever fails, or if a release is made
 * some other way.
 */

import { readFileSync, writeFileSync } from "node:fs";

const root = new URL("../", import.meta.url);
const manifest = JSON.parse(readFileSync(new URL("package.json", root), "utf8"));
const path = new URL("src/server.ts", root);

const source = readFileSync(path, "utf8");
const updated = source.replace(
  /export const SERVER_VERSION = "[^"]*";/,
  `export const SERVER_VERSION = "${manifest.version}";`,
);

if (updated === source && !source.includes(`"${manifest.version}"`)) {
  // A replacement that changed nothing means the pattern stopped matching —
  // silence here would ship a version that says whatever it said last release.
  console.error("sync-version: could not find SERVER_VERSION in src/server.ts");
  process.exit(1);
}

writeFileSync(path, updated);
console.log(`sync-version: src/server.ts is now ${manifest.version}`);
