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

  it("rejects invalid ports before opening storage", () => {
    for (const port of ["0", "65536", "1.5", "Infinity"]) {
      assert.throws(() => loadConfig({ ...MINIMAL, PORT: port }), /PORT must be an integer/);
    }
    assert.equal(loadConfig({ ...MINIMAL, PORT: "65535" }).port, 65535);
  });

  it("validates and normalizes the HTTP embedding base URL", () => {
    const env = { ...MINIMAL, EMBEDDING_PROVIDER: "openai", EMBEDDING_API_KEY: "k" };
    for (const url of ["not-a-url", "file:///tmp/model", "https://llm/v1?key=private", "https://llm/v1#x", "https://user:private@llm/v1"]) {
      assert.throws(() => loadConfig({ ...env, EMBEDDING_BASE_URL: url }), (error: unknown) => {
        assert.ok(error instanceof ConfigError);
        assert.doesNotMatch(error.message, /private/);
        return true;
      });
    }
    const config = loadConfig({ ...env, EMBEDDING_BASE_URL: "https://llm.example/v1///" });
    assert.ok(config.embedding.provider === "openai");
    assert.equal(config.embedding.baseUrl, "https://llm.example/v1");
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
