/**
 * Configuration is validated before anything binds a port, so what these
 * assert is which settings are allowed to stop a rollout — a bad value caught
 * here is a failed readiness probe rather than a tool error inside somebody's
 * agent run.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigError, loadConfig } from "./config.js";

const MINIMAL = { VECTOR_BUCKET: "vectors", STATE_BUCKET: "state" } as NodeJS.ProcessEnv;

describe("loadConfig", () => {
  it("needs both buckets named", () => {
    assert.throws(() => loadConfig({} as NodeJS.ProcessEnv), ConfigError);
    assert.throws(
      () => loadConfig({ VECTOR_BUCKET: "vectors" } as NodeJS.ProcessEnv),
      /STATE_BUCKET is required/,
    );
  });

  it("defaults to Bedrock, which needs no key", () => {
    const config = loadConfig(MINIMAL);
    assert.equal(config.embedding.provider, "bedrock");
    assert.equal(config.embedding.dimension, 1024);
    assert.equal(config.apiKey, undefined);
  });

  it("demands a base URL and key once the provider is openai", () => {
    assert.throws(
      () => loadConfig({ ...MINIMAL, EMBEDDING_PROVIDER: "openai" }),
      /EMBEDDING_BASE_URL is required/,
    );
  });

  it("treats the knowledge base as optional, with nothing else implied", () => {
    // Unset is a mode, not a mistake: memories-only, and search_docs is simply
    // not offered. Nothing becomes required alongside it when set — the region
    // is AWS_REGION either way.
    assert.equal(loadConfig(MINIMAL).knowledgeBaseId, undefined);
    assert.equal(loadConfig({ ...MINIMAL, KNOWLEDGE_BASE_ID: "   " }).knowledgeBaseId, undefined);
    assert.equal(loadConfig({ ...MINIMAL, KNOWLEDGE_BASE_ID: " KB123 " }).knowledgeBaseId, "KB123");
  });
});

describe("RECALL_MIN_SIMILARITY", () => {
  it("takes a threshold inside (0, 1]", () => {
    assert.equal(loadConfig({ ...MINIMAL, RECALL_MIN_SIMILARITY: "0.25" }).recallMinSimilarity, 0.25);
    assert.equal(loadConfig({ ...MINIMAL, RECALL_MIN_SIMILARITY: "1" }).recallMinSimilarity, 1);
  });

  it("refuses zero rather than admitting everything", () => {
    // A floor of zero passes every hit, and confidence is a multiple of the
    // floor — so every result, however remote, would reach the model labelled
    // HIGH CONFIDENCE. Confidently wrong is worse than not starting.
    assert.throws(
      () => loadConfig({ ...MINIMAL, RECALL_MIN_SIMILARITY: "0" }),
      /must be greater than 0/,
    );
  });

  it("refuses a value that is not a fraction at all", () => {
    for (const raw of ["-0.5", "2", "many"]) {
      assert.throws(() => loadConfig({ ...MINIMAL, RECALL_MIN_SIMILARITY: raw }), ConfigError, raw);
    }
  });
});
