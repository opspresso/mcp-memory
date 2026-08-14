/**
 * What this server calls itself.
 *
 * Its own file because two kinds of caller need it and neither should have to
 * reach the other: `server.ts` tells a client what it connected to, and
 * `main.ts` writes it to the log the moment the port is bound.
 *
 * `SERVER_VERSION` restates package.json's `version`, and `npm version` keeps
 * the two in step through `scripts/sync-version.mjs`. `version.test.ts` is the
 * backstop for a release made some other way: nothing at runtime compares them,
 * so without it what a client is told it is talking to could quietly stop being
 * true.
 */

export const SERVER_NAME = "mcp-memory";
export const SERVER_VERSION = "0.5.0";
