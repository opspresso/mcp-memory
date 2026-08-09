import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  DocsError,
  KnowledgeBaseRetriever,
  MAX_EXCERPT_CHARS,
  renderDocs,
  type KnowledgeBaseOptions,
} from "./docs.js";

function retriever(invoke: KnowledgeBaseOptions["invoke"]) {
  return new KnowledgeBaseRetriever({ knowledgeBaseId: "KB123", invoke });
}

describe("KnowledgeBaseRetriever", () => {
  it("passes the knowledge base id, query and limit through", async () => {
    let seen: unknown[] | undefined;
    await retriever(async (...args) => {
      seen = args;
      return { retrievalResults: [] };
    }).retrieve("how do we deploy", 5);

    assert.deepEqual(seen, ["KB123", "how do we deploy", 5]);
  });

  it("keeps the excerpt, source and score and nothing else", async () => {
    const docs = await retriever(async () => ({
      retrievalResults: [
        {
          content: { text: "Deploys go through ArgoCD." },
          location: { type: "S3", s3Location: { uri: "s3://docs/deploy.md" } },
          score: 0.62,
          metadata: { "x-amz-bedrock-kb-chunk-id": "ignored" },
        },
      ],
    })).retrieve("q", 5);

    assert.deepEqual(docs, [
      { excerpt: "Deploys go through ArgoCD.", source: "s3://docs/deploy.md", score: 0.62 },
    ]);
  });

  it("tolerates a result with no location or score", async () => {
    const docs = await retriever(async () => ({
      retrievalResults: [{ content: { text: "just text" } }],
    })).retrieve("q", 5);

    assert.deepEqual(docs, [{ excerpt: "just text", source: undefined, score: undefined }]);
  });

  it("skips a result with no text to show", async () => {
    const docs = await retriever(async () => ({
      retrievalResults: [
        { content: {}, score: 0.9 },
        { content: { text: "   " } },
        { content: { text: "kept" } },
      ],
    })).retrieve("q", 5);

    assert.equal(docs.length, 1);
    assert.equal(docs[0]?.excerpt, "kept");
  });

  it("rejects a response with no retrieval results in it", async () => {
    for (const payload of [{}, { retrievalResults: "nope" }, undefined]) {
      const error = await retriever(async () => payload)
        .retrieve("q", 5)
        .catch((e: unknown) => e);
      assert.ok(error instanceof DocsError, `should reject ${JSON.stringify(payload)}`);
      assert.match(error.message, /no retrieval results/);
    }
  });

  it("carries a Bedrock failure through as a docs error", async () => {
    const error = await retriever(async () => {
      throw new Error("ThrottlingException: slow down");
    })
      .retrieve("q", 5)
      .catch((e: unknown) => e);

    assert.ok(error instanceof DocsError);
    assert.match(error.message, /could not be searched/);
    assert.match(error.message, /ThrottlingException/);
  });
});

describe("renderDocs", () => {
  it("numbers the excerpts under a [DOCS] header", () => {
    const body = renderDocs("deploys", [
      { excerpt: "first", source: "s3://docs/a.md", score: 0.5 },
      { excerpt: "second", source: "s3://docs/b.md", score: 0.4 },
    ]);

    assert.match(body, /^\[DOCS\] 2 excerpts matched "deploys"/);
    assert.match(body, /1\. \(100% of the top result, source: s3:\/\/docs\/a\.md\)\n   first/);
    assert.match(body, /2\. \(80% of the top result, source: s3:\/\/docs\/b\.md\)\n   second/);
  });

  it("never prints a raw score", () => {
    // What 0.62 means is a property of the KB's embedding model; the model
    // reading the result cannot calibrate it. Only the relative standing is
    // true regardless of the model — same reasoning as memory rendering.
    const body = renderDocs("q", [{ excerpt: "text", score: 0.62 }]);
    assert.ok(!body.includes("0.62"), body);
  });

  it("omits the facets it does not have", () => {
    const body = renderDocs("q", [{ excerpt: "bare" }]);
    assert.match(body, /1\.\n   bare/);
    assert.ok(!body.includes("of the top result"));
    assert.ok(!body.includes("source:"));
  });

  it("says what an empty result does and does not mean", () => {
    const body = renderDocs("quantum", []);
    assert.match(body, /^\[DOCS\] Nothing in the documentation library matched "quantum"/);
    assert.match(body, /not the same as the subject having no answer/);
  });

  it("truncates an oversized excerpt and says where the rest is", () => {
    const body = renderDocs("q", [{ excerpt: "x".repeat(MAX_EXCERPT_CHARS + 100) }]);
    assert.match(body, /truncated — read the source document for the rest/);
    assert.ok(body.length < MAX_EXCERPT_CHARS + 300, "the cut must actually bound the output");
  });
});
