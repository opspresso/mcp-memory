/**
 * Who may call this server.
 *
 * The rule has two modes and the choice is the deployment's, not a request's:
 * with `MCP_API_KEY` set every call must present it, and with the key unset the
 * server answers anyone. The second mode exists because the intended deployment
 * is a Deployment behind a ClusterIP with no ingress — there the network is the
 * boundary, and a shared secret every pod already reaches adds a thing to
 * rotate without adding a thing it protects against.
 *
 * That reasoning depends entirely on the server not being reachable from
 * outside. `describeAuth` exists so the process says which mode it is in at
 * startup: the day someone puts an ingress in front of it, the log line is what
 * makes the open mode visible instead of silent.
 *
 * Note what this does *not* decide. Authentication says a caller may talk to
 * the server; it says nothing about whose memories they get. That is
 * `tenant.ts`, and it is enforced separately on every request.
 */

import { timingSafeEqual } from "node:crypto";

const BEARER = "bearer";

/** Constant-time compare so a wrong key cannot be found one character at a time. */
function keyMatches(presented: string, expected: string): boolean {
  const a = Buffer.from(presented);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * `apiKey` undefined or empty means no key is configured, and every caller is
 * allowed. Otherwise the header must carry exactly that key as a bearer token.
 */
export function authorizes(apiKey: string | undefined, authorization: string | undefined): boolean {
  if (!apiKey) {
    return true;
  }
  const header = authorization ?? "";
  const separator = header.indexOf(" ");
  if (separator < 0 || header.slice(0, separator).toLowerCase() !== BEARER) {
    return false;
  }
  const token = header.slice(separator).trimStart();
  return token.length > 0 && keyMatches(token, apiKey);
}

/** Browser-originated requests have no valid caller in this cluster-internal deployment. */
export function authorizesOrigin(origin: string | undefined): boolean {
  return origin === undefined;
}

/** The startup line. Loud in the open mode, because that mode is a bet on the network. */
export function describeAuth(apiKey: string | undefined): string {
  return apiKey
    ? "auth: MCP_API_KEY is set; every request must present it as a bearer token"
    : "auth: MCP_API_KEY is NOT set — this server answers ANY caller that can reach it. " +
        "That is only safe while nothing routes to it from outside the cluster.";
}
