/**
 * What this server offers a model, registered on the SDK's `McpServer`.
 *
 * Separate from `server.ts` so it can be built without binding a port — the
 * tests connect to it over HTTP, which is the only way to assert what a client
 * on either protocol era actually sees.
 *
 * **The protocol comes from the SDK.** It used to be implemented by hand, for
 * the reason the sibling servers gave: the surface was four methods, and an SDK
 * whose schema generation moves under a server written against an older release
 * is a failure mode with no upside. Revision `2026-07-28` ended that trade. It
 * removed the `initialize` handshake and added a per-request `_meta` envelope,
 * `server/discover`, `resultType` on every result, the `ttlMs`/`cacheScope`
 * hints the list verbs now require, `Mcp-Param-*` mirroring from a tool's own
 * schema, and multi round-trip results. Four methods became a moving surface,
 * and following it by hand is the larger risk now.
 *
 * **The tenant rides the factory, not a global.** `createMcpHandler` builds one
 * instance per request and hands it that request, so the tenant belongs to that
 * request alone — which is what keeps two concurrent callers from ever seeing
 * each other's memories. A tenant resolved anywhere above this would have to be
 * threaded back down through the SDK, and the only place to put it would be a
 * module-level variable.
 *
 * It is read **when a tool runs**, not when the instance is built, and that is
 * deliberate: the handshake says what this server is, which is true regardless
 * of whose memories the caller may reach, and a client that connects lazily
 * should not be told about a header problem before it has asked for anything.
 * A missing header therefore reaches the model as a tool error naming the
 * header to set, rather than as a connection that would not open.
 */

import { fromJsonSchema, McpServer, type CallToolResult } from "@modelcontextprotocol/server";
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/server/validators/ajv";
import { TENANT_HEADER, TENANT_ID_HEADER, parseTenant } from "./tenant.js";
import { SERVER_NAME, SERVER_VERSION } from "./version.js";
import type { ToolDefinition, ToolResult } from "./tools.js";

/** What the protocol layer needs from the tool layer, and nothing more. */
export interface ToolHandler {
  definitions(): readonly ToolDefinition[];
  call(tenant: string, name: string, args: Record<string, unknown>): Promise<ToolResult>;
}

/** One validator for every tool: compiling per registration would repeat the work. */
const validator = new AjvJsonSchemaValidator();

/**
 * The tenant this request belongs to.
 *
 * Both spellings are accepted for the same reason the hand-written server
 * accepted both: `x-tenant-id` is what the platform stamps on every MCP request
 * it makes, and `x-memory-tenant` is what an operator can set on a registry
 * entry when they want one project's memories under a name of their own.
 *
 * @throws {TenantError} which the caller turns into a refusal naming the header.
 */
export function tenantOf(request: Request | undefined): string {
  return parseTenant(
    request?.headers.get(TENANT_HEADER) ?? request?.headers.get(TENANT_ID_HEADER) ?? undefined,
  );
}

/**
 * A server for one request. `tenant` is a getter rather than a value so the
 * header is only required once a tool is actually called — see the note above.
 */
export function buildServer(tools: ToolHandler, tenant: () => string): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });
  for (const tool of tools.definitions()) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        // Converted rather than rewritten: the schemas are what a model reads
        // to know how to ask, and restating them in another schema language
        // would be a transcription exercise with every chance of an omission.
        inputSchema: fromJsonSchema(tool.inputSchema, validator),
      },
      // The cast is the one seam between the two type systems: `ToolResult` is
      // this repository's own `{ content, isError? }`, which is a
      // CallToolResult — but not the whole union the SDK's callback may return.
      async (args) =>
        tools.call(tenant(), tool.name, args as Record<string, unknown>) as Promise<CallToolResult>,
    );
  }
  return server;
}
