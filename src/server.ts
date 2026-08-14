/**
 * One streamable-HTTP MCP endpoint: the JSON-RPC handshake followed by
 * `tools/list` / `tools/call`, over `node:http`.
 *
 * The protocol is implemented directly rather than through an SDK, for the
 * reason the sibling server in this cluster gives: the surface is four methods,
 * and an SDK whose schema generation moves under a server written against an
 * older release is a failure mode with no upside here.
 *
 * The server is stateless. Every pod answers every request, nothing is pinned
 * to a session, and a `DELETE` has nothing to release — which is what lets this
 * scale horizontally and survive a rolling deploy without draining anything.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { authorizes } from "./auth.js";
import type { Config } from "./config.js";
import { logError } from "./log.js";
import { TENANT_ID_HEADER, parseTenant, TENANT_HEADER, TenantError } from "./tenant.js";
import type { ToolDefinition, ToolResult } from "./tools.js";

export const PROTOCOL_VERSION = "2025-06-18";
export const SERVER_NAME = "mcp-memory";
/** Tracks `version` in package.json; both are what a client is told this is. */
export const SERVER_VERSION = "0.4.2";
/** A remembered body is capped well below this by the tools; this only bounds the frame. */
const MAX_BODY_BYTES = 1024 * 1024;

/** JSON-RPC codes. `-32001` is this server's own, matching the sibling's choice for auth. */
const UNAUTHORIZED = -32001;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INTERNAL_ERROR = -32603;
const PARSE_ERROR = -32700;

interface JsonRpcRequest {
  jsonrpc: string;
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

/** What the HTTP layer needs from the tool layer, and nothing more. */
export interface ToolHandler {
  definitions(): readonly ToolDefinition[];
  call(tenant: string, name: string, args: Record<string, unknown>): Promise<ToolResult>;
}

export interface ServerDeps {
  config: Config;
  tools: ToolHandler;
}

class RpcError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
  }
}

async function handle(deps: ServerDeps, request: IncomingMessage, message: JsonRpcRequest) {
  switch (message.method) {
    case "initialize":
      // Deliberately not tenant-checked. The handshake says what this server is,
      // which is true regardless of whose memories the caller may reach — and a
      // client that initializes lazily should not be told about a header problem
      // before it has asked for anything.
      return {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      };
    case "tools/list":
      // Tenant-checked even though the catalogue does not vary by tenant. Agent
      // Studio's "Test connection" sends the entry's headers and shows what
      // comes back, so checking here is what makes a missing header a visible
      // failure at the moment someone configures the entry — rather than a
      // working test button and a broken agent run later.
      requireTenant(request);
      return { tools: deps.tools.definitions() };
    case "tools/call": {
      const tenant = requireTenant(request);
      const name = message.params?.name;
      if (typeof name !== "string" || !deps.tools.definitions().some((t) => t.name === name)) {
        throw new RpcError(METHOD_NOT_FOUND, `unknown tool: ${String(name)}`);
      }
      const args = message.params?.arguments;
      return deps.tools.call(
        tenant,
        name,
        args && typeof args === "object" && !Array.isArray(args)
          ? (args as Record<string, unknown>)
          : {},
      );
    }
    default:
      throw new RpcError(METHOD_NOT_FOUND, `unsupported method: ${message.method}`);
  }
}

function requireTenant(request: IncomingMessage): string {
  try {
    return parseTenant(
      request.headers[TENANT_HEADER] ?? request.headers[TENANT_ID_HEADER],
    );
  } catch (error) {
    if (error instanceof TenantError) {
      throw new RpcError(INVALID_REQUEST, error.message);
    }
    throw error;
  }
}

/** Its own type so the frame limit is not reported as though the JSON were bad. */
class PayloadTooLarge extends Error {}

async function readBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  let overflowed = false;
  for await (const chunk of request) {
    size += (chunk as Buffer).byteLength;
    if (size > MAX_BODY_BYTES) {
      // Stop *buffering*, and keep reading. Destroying the socket here is the
      // obvious move and the wrong one: it takes the response down with it, so
      // the sender gets a connection reset in place of the reason it was
      // refused. Draining costs bytes already on the wire and nothing else —
      // the memory this limit exists to bound stays bounded either way.
      overflowed = true;
      chunks.length = 0;
      continue;
    }
    chunks.push(chunk as Buffer);
  }
  if (overflowed) {
    throw new PayloadTooLarge(`request body exceeds ${MAX_BODY_BYTES} bytes`);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function send(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

export function createMcpServer(deps: ServerDeps): Server {
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
      if (request.method === "DELETE") {
        // Session teardown: this server is stateless, so there is nothing to release.
        response.writeHead(204).end();
        return;
      }
      if (request.method !== "POST") {
        send(response, 405, { error: "method not allowed" });
        return;
      }
      let message: JsonRpcRequest;
      try {
        message = JSON.parse(await readBody(request)) as JsonRpcRequest;
      } catch (error) {
        if (error instanceof PayloadTooLarge) {
          send(response, 413, {
            jsonrpc: "2.0",
            id: null,
            error: { code: INVALID_REQUEST, message: error.message },
          });
          return;
        }
        send(response, 400, {
          jsonrpc: "2.0",
          id: null,
          error: { code: PARSE_ERROR, message: "parse error" },
        });
        return;
      }
      // A JSON-RPC batch. Refused rather than answered — this protocol revision
      // removed batching — but refused *out loud*: an array has no `id`, so the
      // notification branch below would take it for a notification and reply
      // 202, leaving a client that sent one waiting for a response that is
      // never coming.
      if (Array.isArray(message)) {
        send(response, 400, {
          jsonrpc: "2.0",
          id: null,
          error: {
            code: INVALID_REQUEST,
            message: `batched requests are not supported in protocol ${PROTOCOL_VERSION}`,
          },
        });
        return;
      }
      // A notification carries no id and expects no reply.
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      try {
        send(response, 200, {
          jsonrpc: "2.0",
          id: message.id,
          result: await handle(deps, request, message),
        });
      } catch (error) {
        // An RpcError is a answer this server meant to give — a bad tenant, an
        // unknown method — and the client is being told. Anything else got here
        // by surprise and is the only kind worth waking someone for.
        if (!(error instanceof RpcError)) {
          logError("request_failed", error, { method: message.method });
        }
        const rpc =
          error instanceof RpcError
            ? error
            : new RpcError(INTERNAL_ERROR, error instanceof Error ? error.message : String(error));
        send(response, 200, {
          jsonrpc: "2.0",
          id: message.id,
          error: { code: rpc.code, message: rpc.message },
        });
      }
    })();
  });
}
