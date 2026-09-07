import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, it } from "node:test";
import { BedrockEmbedder, EmbeddingError, HttpEmbedder } from "./embeddings.js";

function embedder(fetchImpl: typeof fetch, dimension = 3) {
  return new HttpEmbedder({
    baseUrl: "https://llm.example/v1",
    apiKey: "k",
    model: "text-embedding-3-small",
    dimension,
    fetchImpl,
  });
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

describe("HttpEmbedder", () => {
  it("posts to the embeddings route and returns the vector", async () => {
    let seen: { url: string; init: RequestInit } | undefined;
    const result = await embedder((async (url: string, init: RequestInit) => {
      seen = { url, init };
      return jsonResponse({ data: [{ embedding: [0.1, 0.2, 0.3] }] });
    }) as unknown as typeof fetch).embed("hello");

    assert.deepEqual(result, [0.1, 0.2, 0.3]);
    assert.equal(seen?.url, "https://llm.example/v1/embeddings");
    assert.equal((seen?.init.headers as Record<string, string>).authorization, "Bearer k");
    assert.deepEqual(JSON.parse(seen?.init.body as string), {
      model: "text-embedding-3-small",
      input: "hello",
    });
  });

  it("names the required re-embedding when the dimension does not match", async () => {
    const error = await embedder((async () =>
      jsonResponse({ data: [{ embedding: [1, 2] }] })) as unknown as typeof fetch)
      .embed("hello")
      .catch((e: unknown) => e);

    assert.ok(error instanceof EmbeddingError);
    assert.match(error.message, /returned 2 dimensions but this deployment expects 3/);
    assert.match(error.message, /clear or re-embed existing memories/);
  });

  it("reports the HTTP status without reflecting the provider error body", async () => {
    const error = await embedder((async () =>
      new Response("private memory echoed by the provider", { status: 401 })) as unknown as typeof fetch)
      .embed("hello")
      .catch((e: unknown) => e);

    assert.ok(error instanceof EmbeddingError);
    assert.match(error.message, /HTTP 401/);
    assert.doesNotMatch(error.message, /private memory/);
  });

  it("rejects a response with no embedding in it", async () => {
    for (const body of [{}, { data: [] }, { data: [{ embedding: "nope" }] }]) {
      const error = await embedder((async () => jsonResponse(body)) as unknown as typeof fetch)
        .embed("hello")
        .catch((e: unknown) => e);
      assert.ok(error instanceof EmbeddingError, `should reject ${JSON.stringify(body)}`);
    }
  });

  it("rejects an all-zero vector", async () => {
    // Cosine distance cannot rank an all-zero vector.
    const error = await embedder((async () =>
      jsonResponse({ data: [{ embedding: [0, 0, 0] }] })) as unknown as typeof fetch)
      .embed("hello")
      .catch((e: unknown) => e);

    assert.ok(error instanceof EmbeddingError);
    assert.match(error.message, /all-zero/);
  });

  it("rejects JSON numbers that overflow to infinity", async () => {
    await assert.rejects(
      embedder((async () => new Response('{"data":[{"embedding":[1e400,0,1]}]}')) as typeof fetch)
        .embed("hello"),
      /non-finite vector component/,
    );
  });

  it("times out while reading an unfinished response body", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "application/json" });
      response.write('{"data":[');
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      await assert.rejects(new HttpEmbedder({
        baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
        apiKey: "k", model: "test", dimension: 3, timeoutMs: 50,
      }).embed("hello"), /did not respond within 50ms/);
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });

  it("reports a timeout as a timeout", async () => {
    const error = await embedder((async () => {
      const abort = new Error("aborted");
      abort.name = "TimeoutError";
      throw abort;
    }) as unknown as typeof fetch)
      .embed("hello")
      .catch((e: unknown) => e);

    assert.ok(error instanceof EmbeddingError);
    assert.match(error.message, /did not respond within/);
  });
});

describe("BedrockEmbedder", () => {
  function bedrock(invoke: (body: string, model: string) => Promise<unknown>, dimension = 3) {
    return new BedrockEmbedder({ model: "amazon.titan-embed-text-v2:0", dimension, invoke });
  }

  it("asks Titan for the configured dimension rather than taking the model default", async () => {
    let body: Record<string, unknown> | undefined;
    const result = await bedrock(async (raw) => {
      body = JSON.parse(raw);
      return { embedding: [0.1, 0.2, 0.3] };
    }).embed("hello");

    assert.deepEqual(result, [0.1, 0.2, 0.3]);
    assert.equal(body?.inputText, "hello");
    assert.equal(body?.dimensions, 3);
    assert.equal(body?.normalize, true, "the database metric is cosine");
  });

  it("names the required re-embedding when the dimension does not match", async () => {
    const error = await bedrock(async () => ({ embedding: [1, 2] }))
      .embed("hello")
      .catch((e: unknown) => e);

    assert.ok(error instanceof EmbeddingError);
    assert.match(error.message, /returned 2 dimensions but this deployment expects 3/);
    assert.match(error.message, /clear or re-embed existing memories/);
  });

  it("rejects a response with no embedding in it", async () => {
    for (const payload of [{}, { embedding: "nope" }, undefined]) {
      const error = await bedrock(async () => payload)
        .embed("hello")
        .catch((e: unknown) => e);
      assert.ok(error instanceof EmbeddingError, `should reject ${JSON.stringify(payload)}`);
    }
  });

  it("rejects an all-zero vector", async () => {
    const error = await bedrock(async () => ({ embedding: [0, 0, 0] }))
      .embed("hello")
      .catch((e: unknown) => e);
    assert.ok(error instanceof EmbeddingError);
    assert.match(error.message, /all-zero/);
  });

  it("rejects non-finite components before they reach PostgreSQL", async () => {
    for (const value of [NaN, Infinity, -Infinity]) {
      await assert.rejects(
        bedrock(async () => ({ embedding: [value, 0, 1] })).embed("hello"),
        /non-finite vector component/,
      );
    }
  });

  it("bounds the entire invocation and signals cancellation", async () => {
    let signal: AbortSignal | undefined;
    const instance = new BedrockEmbedder({
      model: "test", dimension: 3, timeoutMs: 20,
      invoke: async (_body, _model, received) => {
        signal = received;
        return new Promise(() => {});
      },
    });
    await assert.rejects(instance.embed("hello"), /did not respond within 20ms/);
    assert.equal(signal?.aborted, true);
  });

  it("carries a Bedrock failure through as an embedding error", async () => {
    const error = await bedrock(async () => {
      throw Object.assign(new Error("private memory echoed by Bedrock"), { name: "AccessDeniedException" });
    })
      .embed("hello")
      .catch((e: unknown) => e);

    assert.ok(error instanceof EmbeddingError);
    assert.match(error.message, /Bedrock could not embed the text/);
    assert.match(error.message, /AccessDeniedException/);
    assert.doesNotMatch(error.message, /private memory/);
  });
});
