/**
 * The endpoint, over a real socket and a real client.
 *
 * The protocol itself moved to the SDK, so what is worth asserting here is what
 * this repository still decides: the health probe, the shared-secret gate, the
 * routing between them — and the tenant, which is this server's own idea and
 * has to reach a tool from the request that carried it.
 *
 * The client is the SDK's, on both eras. AgentDure speaks `2026-07-28` and
 * other callers still open with the `initialize` handshake; the endpoint serves
 * both, and a change that quietly dropped either would look exactly like
 * everything working.
 */

import assert from "node:assert/strict";
import type { AddressInfo } from "node:net";
import { after, before, describe, it } from "node:test";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { loadConfig } from "./config.js";
import { createMcpServer, type ToolHandler } from "./server.js";

const BASE_ENV = {
  VECTOR_BUCKET: "vectors",
  STATE_BUCKET: "state",
  EMBEDDING_BASE_URL: "https://llm.example/v1",
  EMBEDDING_API_KEY: "k",
} as NodeJS.ProcessEnv;

const calls: { tenant: string; name: string; args: Record<string, unknown> }[] = [];

const tools: ToolHandler = {
  definitions: () => [
    {
      name: "recall",
      description: "d",
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
    },
  ],
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

async function connect(
  headers: Record<string, string> = { "x-memory-tenant": "demo" },
  mode: "auto" | "legacy" = "auto",
): Promise<Client> {
  const client = new Client(
    { name: "test-client", version: "1.0.0" },
    { versionNegotiation: { mode } },
  );
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${instance.url}/mcp`), {
      requestInit: { headers },
    }),
    { timeout: 5_000 },
  );
  return client;
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

describe("authentication", () => {
  it("answers anyone when no key is configured", async () => {
    const client = await connect();
    assert.equal((await client.listTools()).tools.length, 1);
    await client.close();
  });

  it("demands the key when one is configured, before any server is built", async () => {
    const guarded = await serve({ ...BASE_ENV, MCP_API_KEY: "s3cret" });
    try {
      const unauthenticated = await fetch(`${guarded.url}/mcp`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-memory-tenant": "demo" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "server/discover" }),
      });
      assert.equal(unauthenticated.status, 401);
      const refusal = (await unauthenticated.json()) as { error?: { code: number } };
      assert.equal(refusal.error?.code, -32001);

      const client = new Client({ name: "t", version: "1" });
      await client.connect(
        new StreamableHTTPClientTransport(new URL(`${guarded.url}/mcp`), {
          requestInit: {
            headers: { "x-memory-tenant": "demo", authorization: "Bearer s3cret" },
          },
        }),
        { timeout: 5_000 },
      );
      assert.equal((await client.listTools()).tools.length, 1);
      await client.close();
    } finally {
      await guarded.close();
    }
  });
});

describe("what a client is offered", () => {
  it("serves a client that opens with the 2026-07-28 probe", async () => {
    // The era AgentDure speaks, and the reason this server moved to the SDK.
    const client = await connect();

    assert.equal(client.getProtocolEra(), "modern");
    assert.deepEqual(
      (await client.listTools()).tools.map((tool) => tool.name),
      ["recall"],
    );
    await client.close();
  });

  it("still serves a client that opens with the handshake", async () => {
    // The era every other client is still on. Dropping it would be invisible
    // until somebody's existing configuration stopped working.
    const client = await connect({ "x-memory-tenant": "demo" }, "legacy");

    assert.equal(client.getProtocolEra(), "legacy");
    assert.equal((await client.listTools()).tools.length, 1);
    await client.close();
  });

  it("connects without a tenant, because the handshake says what this server is", async () => {
    // True regardless of whose memories the caller may reach, and a client that
    // connects lazily should not be told about a header problem before it has
    // asked for anything. This is a change: the hand-written server refused
    // `tools/list` without a tenant so a misconfigured entry failed at Test
    // connection. The refusal now arrives at the first call instead, where it
    // reaches the model as text rather than as a connection that would not open.
    const client = await connect({});

    assert.equal((await client.listTools()).tools.length, 1);
    await client.close();
  });
});

describe("the tenant", () => {
  it("comes from the header, never from the arguments", async () => {
    const client = await connect({ "x-memory-tenant": "acme" });
    calls.length = 0;

    await client.callTool({ name: "recall", arguments: { q: "x" } });

    assert.equal(calls.at(-1)?.tenant, "acme");
    await client.close();
  });

  it("reads the generic header when no explicit tenant is set", async () => {
    // What the platform stamps on every MCP request it makes.
    const client = await connect({ "x-tenant-id": "project-a" });
    calls.length = 0;

    await client.callTool({ name: "recall", arguments: {} });

    assert.equal(calls.at(-1)?.tenant, "project-a");
    await client.close();
  });

  it("prefers an explicit tenant over the generic one", async () => {
    const client = await connect({ "x-memory-tenant": "chosen", "x-tenant-id": "project-a" });
    calls.length = 0;

    await client.callTool({ name: "recall", arguments: {} });

    assert.equal(calls.at(-1)?.tenant, "chosen");
    await client.close();
  });

  it("refuses a call with no tenant, naming the header to set", async () => {
    const client = await connect({});
    calls.length = 0;

    const result = await client.callTool({ name: "recall", arguments: {} });

    assert.equal(result.isError, true);
    assert.match(JSON.stringify(result.content), /x-memory-tenant/);
    assert.equal(calls.length, 0, "no tool should have run");
    await client.close();
  });

  it("refuses a malformed tenant the same way", async () => {
    const client = await connect({ "x-memory-tenant": "not a slug!" });
    calls.length = 0;

    const result = await client.callTool({ name: "recall", arguments: {} });

    assert.equal(result.isError, true);
    assert.equal(calls.length, 0, "no tool should have run");
    await client.close();
  });
});
