/**
 * The version is stated twice — in package.json, which builds and publishes the
 * image, and in `version.ts`, which is what a client is told. Nothing at
 * runtime reads one against the other, so only this notices them parting
 * company: a stale copy shows up as a client being told it is talking to a
 * release that shipped months ago.
 */

import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";

const manifest = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { name: string; version: string };

test("the version a client is told matches the one that was published", () => {
  assert.equal(SERVER_VERSION, manifest.version);
  assert.equal(SERVER_NAME, manifest.name);
});
