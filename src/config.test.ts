/** Boot-time configuration validation. */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConfigError, loadConfig } from "./config.js";

const MINIMAL = { DATABASE_URL: "postgres://memory:memory@postgres/memory" } as NodeJS.ProcessEnv;

describe("loadConfig", () => {
  it("requires PostgreSQL and trims its URL", () => {
    assert.throws(() => loadConfig({} as NodeJS.ProcessEnv), /DATABASE_URL is required/);
    assert.equal(
      loadConfig({ DATABASE_URL: " postgres://u:p@db/memory " } as NodeJS.ProcessEnv).databaseUrl,
      "postgres://u:p@db/memory",
    );
  });

  it("ignores removed S3 and knowledge-base settings", () => {
    const config = loadConfig({
      ...MINIMAL,
      VECTOR_BUCKET: "vectors",
      STATE_BUCKET: "state",
      KNOWLEDGE_BASE_ID: "KB123",
    });
    assert.equal(config.databaseUrl, MINIMAL.DATABASE_URL);
    assert.ok(!("knowledgeBaseId" in config));
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
});

describe("RECALL_MIN_SIMILARITY", () => {
  it("takes a threshold inside (0, 1]", () => {
    assert.equal(loadConfig({ ...MINIMAL, RECALL_MIN_SIMILARITY: "0.25" }).recallMinSimilarity, 0.25);
    assert.equal(loadConfig({ ...MINIMAL, RECALL_MIN_SIMILARITY: "1" }).recallMinSimilarity, 1);
  });

  it("refuses zero rather than admitting everything", () => {
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
