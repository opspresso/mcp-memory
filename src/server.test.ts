/**
 * The protocol surface, over a real socket.
 *
 * Agent Studio speaks this by hand too (`infrastructure/mcp/session.ts`), so
 * these assert the exact shapes it depends on: a result envelope on 200, a
 * notification answered with 202 and no body, a `DELETE` that succeeds against
 * a server with nothing to release.
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { loadConfig } from "./config.js";
import {
  createMcpServer,
  PROTOCOL_VERSION,
  SERVER_VERSION,
  type ToolHandler,
} from "./server.js";

const BASE_ENV = {
  VECTOR_BUCKET: "vectors",
  STATE_BUCKET: "state",
  EMBEDDING_BASE_URL: "https://llm.example/v1",
  EMBEDDING_API_KEY: "k",
} as NodeJS.ProcessEnv;

const calls: { tenant: string; name: string; args: Record<string, unknown> }[] = [];

const tools: ToolHandler = {
  definitions: () => [{ name: "recall", description: "d", inputSchema: { type: "object" } }],
  call: async (tenant, name, args) => {
    calls.push({ tenant, name, args });
    return { content: [{ type: "text", text: `${name} for ${tenant}` }] };
  },
};

function serve(env: NodeJS.ProcessEnv = BASE_ENV) {
  const server = createMcpServer({ config: loadConfig(env), tools });
  return new Promise<{ url: string; close: () => Promise<void> }>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise<void>((done) => server.close(() => done())),
      });
    });
  });
}

let instance: Awaited<ReturnType<typeof serve>>;

before(async () => {
  instance = await serve();
});
after(async () => {
  await instance.close();
});

/** Loosely typed on purpose: these tests assert the wire shape, not a model of it. */
interface JsonRpcReply {
  result?: any;
  error?: { code: number; message: string };
}

async function rpc(
  method: string,
  params?: Record<string, unknown>,
  headers: Record<string, string> = { "x-memory-tenant": "demo" },
  id: number | string | null = 1,
): Promise<{ status: number; body: JsonRpcReply }> {
  const response = await fetch(`${instance.url}/mcp`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({ jsonrpc: "2.0", ...(id === null ? {} : { id }), method, params }),
  });
  return { status: response.status, body: (await response.json()) as JsonRpcReply };
}

/** Asserts an error came back, and says what did instead when one did not. */
function errorOf(body: JsonRpcReply): { code: number; message: string } {
  assert.ok(body.error, `expected a JSON-RPC error, got ${JSON.stringify(body)}`);
  return body.error;
}

describe("health", () => {
  it("answers without touching a dependency", async () => {
    const response = await fetch(`${instance.url}/health`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: "ok" });
  });

  it("404s anything that is not the endpoint", async () => {
    assert.equal((await fetch(`${instance.url}/nope`)).status, 404);
  });
});

describe("what the server calls itself", () => {
  it("reports the version in package.json", () => {
    // Two copies of one number, and the handshake is where a stale one shows
    // up — as a client being told it is talking to a release that shipped
    // months ago. Nothing else notices, so this has to.
    const manifest = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version: string };
    assert.equal(SERVER_VERSION, manifest.version);
  });
});

describe("initialize", () => {
  it("returns the negotiated version and the server's identity", async () => {
    const { body } = await rpc("initialize");
    assert.equal(body.result.protocolVersion, PROTOCOL_VERSION);
    assert.equal(body.result.serverInfo.name, "mcp-memory");
    assert.deepEqual(body.result.capabilities, { tools: { listChanged: false } });
  });

  it("does not require a tenant", async () => {
    // A client initializes lazily and may not have asked for anything yet;
    // telling it about a header problem here would be premature.
    const { body } = await rpc("initialize", undefined, {});
    assert.ok(body.result);
  });
});

describe("tools/list", () => {
  it("returns the catalogue", async () => {
    const { body } = await rpc("tools/list");
    assert.equal(body.result.tools[0].name, "recall");
  });

  it("fails without a tenant, so a misconfigured entry shows up in Test connection", async () => {
    const { body } = await rpc("tools/list", undefined, {});
    assert.equal(body.result, undefined);
    assert.match(errorOf(body).message, /x-memory-tenant header is required/);
  });

  it("fails on a malformed tenant", async () => {
    const { body } = await rpc("tools/list", undefined, { "x-memory-tenant": "../other" });
    assert.match(errorOf(body).message, /must start with a letter or digit/);
  });
});

describe("tools/call", () => {
  it("passes the tenant from the header, never from the arguments", async () => {
    calls.length = 0;
    await rpc("tools/call", { name: "recall", arguments: { query: "x", tenant: "attacker" } });

    assert.equal(calls[0]?.tenant, "demo");
    assert.deepEqual(calls[0]?.args, { query: "x", tenant: "attacker" });
  });

  it("rejects an unknown tool", async () => {
    const { body } = await rpc("tools/call", { name: "drop_everything", arguments: {} });
    assert.match(errorOf(body).message, /unknown tool: drop_everything/);
  });

  it("tolerates missing or non-object arguments", async () => {
    calls.length = 0;
    await rpc("tools/call", { name: "recall" });
    await rpc("tools/call", { name: "recall", arguments: "nope" });
    assert.deepEqual(
      calls.map((call) => call.args),
      [{}, {}],
    );
  });
});

describe("transport", () => {
  it("answers a notification with 202 and no body", async () => {
    const response = await fetch(`${instance.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-memory-tenant": "demo" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    assert.equal(response.status, 202);
    assert.equal(await response.text(), "");
  });

  it("accepts the session teardown it has nothing to do for", async () => {
    const response = await fetch(`${instance.url}/mcp`, { method: "DELETE" });
    assert.equal(response.status, 204);
  });

  it("405s a method it does not speak", async () => {
    assert.equal((await fetch(`${instance.url}/mcp`, { method: "PUT" })).status, 405);
  });

  it("reports unparseable JSON as a parse error", async () => {
    const response = await fetch(`${instance.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ not json",
    });
    assert.equal(response.status, 400);
    assert.equal(errorOf((await response.json()) as JsonRpcReply).code, -32700);
  });

  it("reports an oversized body as too large, not as bad JSON", async () => {
    // It parsed fine; it was never read. Calling that a parse error sends
    // whoever is debugging it after the wrong thing.
    const response = await fetch(`${instance.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-memory-tenant": "demo" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", pad: "x".repeat(2e6) }),
    });
    assert.equal(response.status, 413);
    const error = errorOf((await response.json()) as JsonRpcReply);
    assert.notEqual(error.code, -32700, "not a parse error");
    assert.match(error.message, /exceeds/);
  });

  it("refuses a batch out loud rather than answering 202", async () => {
    // An array carries no `id`, so the notification branch would take it for
    // one and reply 202 — leaving the sender waiting on a response that is
    // never coming.
    const response = await fetch(`${instance.url}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-memory-tenant": "demo" },
      body: JSON.stringify([{ jsonrpc: "2.0", id: 1, method: "initialize" }]),
    });
    assert.equal(response.status, 400);
    assert.match(errorOf((await response.json()) as JsonRpcReply).message, /batched requests/);
  });

  it("reports an unsupported method rather than hanging", async () => {
    const { body } = await rpc("resources/list");
    // Agent Studio never asks for this, but something else might.
    assert.equal(errorOf(body).code, -32601);
  });
});

describe("authentication", () => {
  it("answers anyone when no key is configured", async () => {
    const { status } = await rpc("initialize");
    assert.equal(status, 200);
  });

  it("demands the key when one is configured", async () => {
    const guarded = await serve({ ...BASE_ENV, MCP_API_KEY: "s3cret" });
    try {
      const unauthenticated = await fetch(`${guarded.url}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-memory-tenant": "demo" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      assert.equal(unauthenticated.status, 401);

      const authenticated = await fetch(`${guarded.url}/mcp`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-memory-tenant": "demo",
          authorization: "Bearer s3cret",
        },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
      });
      assert.equal(authenticated.status, 200);
    } finally {
      await guarded.close();
    }
  });
});
