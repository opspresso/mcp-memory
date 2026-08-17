/**
 * One streamable-HTTP MCP endpoint, over `node:http`.
 *
 * The protocol comes from `@modelcontextprotocol/server`, which serves **both
 * eras from one endpoint**: a client that opens with `server/discover` gets
 * revision `2026-07-28`, and one that opens with the `initialize` handshake is
 * served statelessly as before. Why that replaced a hand-written protocol, and
 * how a tenant reaches a tool through it, are in `mcp.ts` beside the
 * registration.
 *
 * What stays here is what the SDK has no opinion about: the health probe, the
 * shared-secret gate, and the routing between them.
 *
 * The server is stateless. Every pod answers every request, nothing is pinned
 * to a session, and a `DELETE` has nothing to release — which is what lets this
 * scale horizontally and survive a rolling deploy without draining anything.
 */

import { createServer, type Server, type ServerResponse } from "node:http";
import { createMcpHandler } from "@modelcontextprotocol/server";
import { toNodeHandler } from "@modelcontextprotocol/node";
import { authorizes } from "./auth.js";
import type { Config } from "./config.js";
import { logError } from "./log.js";
import { buildServer, contextOf, type ToolHandler } from "./mcp.js";

/** This server's own JSON-RPC code for auth, matching the siblings' choice. */
const UNAUTHORIZED = -32001;

export type { ToolHandler };

export interface ServerDeps {
  config: Config;
  tools: ToolHandler;
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

export function createMcpServer(deps: ServerDeps): Server {
  const mcp = toNodeHandler(
    // One instance per request, carrying that request's tenant. Resolved
    // anywhere else it would have to be threaded back down through the SDK,
    // and the only place to put it would be a module-level variable — which
    // two concurrent callers would share.
    createMcpHandler(({ requestInfo }) => buildServer(deps.tools, () => contextOf(requestInfo)), {
      onerror: (error) => logError("mcp_handler_failed", error, {}),
    }),
  );

  return createServer((request, response) => {
    void (async () => {
      if (request.url === "/health") {
        // Dependency-free on purpose: this answers "is the process serving",
        // and a probe that also checked S3 would restart pods over an outage
        // they cannot fix by restarting.
        send(response, 200, { status: "ok" });
        return;
      }
      if (!request.url?.startsWith("/mcp")) {
        send(response, 404, { error: "not found" });
        return;
      }
      if (!authorizes(deps.config.apiKey, request.headers.authorization)) {
        send(response, 401, {
          jsonrpc: "2.0",
          id: null,
          error: { code: UNAUTHORIZED, message: "missing or invalid bearer token" },
        });
        return;
      }
      await mcp(request, response);
    })();
  });
}
