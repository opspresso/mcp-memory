/** PostgreSQL adapter integration tests, enabled by TEST_DATABASE_URL. */

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { after, before, beforeEach, describe, it, mock } from "node:test";
import pg from "pg";
import { MemoryManager } from "../service.js";
import { FakeEmbedder } from "../testing/fakes.js";
import type { StoredMemory } from "../types.js";
import { ensureSchema, reportIdleFailures } from "./pg.js";
import { PgMemoryStore } from "./pgMemoryStore.js";

const DATABASE_URL = process.env.TEST_DATABASE_URL?.trim();
const skip = DATABASE_URL ? false : "TEST_DATABASE_URL is not set";

function memory(overrides: Partial<StoredMemory> = {}): StoredMemory {
  return {
    id: "01JAAAAAAAAAAAAAAAAAAAAAAA",
    tenantId: "acme",
    content: "The deploy pipeline pushes to ECR",
    memoryType: "project",
    tags: ["deploy"],
    createdAt: "2026-07-01T00:00:00.000Z",
    trustBase: 1,
    ...overrides,
  };
}

describe("PostgreSQL memory store", { skip }, () => {
  let pool: pg.Pool;
  let memories: PgMemoryStore;

  before(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    await ensureSchema(pool);
    memories = new PgMemoryStore(pool);
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE memories");
  });

  after(async () => {
    await pool?.end();
  });

  it("creates the relational schema idempotently", async () => {
    await ensureSchema(pool);
    const { rows } = await pool.query(
      "SELECT column_name FROM information_schema.columns " +
        "WHERE table_name = 'memories' ORDER BY ordinal_position",
    );
    const columns = rows.map((row: { column_name: string }) => row.column_name);
    assert.ok(columns.includes("content"));
    assert.ok(columns.includes("embedding"));
    assert.ok(columns.includes("access_count"));
    assert.ok(!columns.includes("metadata"));
  });

  it("stores, searches, lists, counts, touches and deletes per tenant", async () => {
    await memories.put(memory(), [1, 0, 0]);
    await memories.put(memory({ tenantId: "other" }), [1, 0, 0]);

    const [hit] = await memories.query("acme", [1, 0, 0], 10);
    assert.ok(hit && Math.abs(hit.similarity - 1) < 1e-6);
    assert.equal(hit.stats.accessCount, 0);
    assert.equal((await memories.list("acme", { limit: 10 })).length, 1);
    assert.deepEqual(await memories.count("acme"), { project: 1 });

    await memories.touch("acme", [memory().id], "2026-07-02T00:00:00.000Z");
    const [touched] = await memories.query("acme", [1, 0, 0], 10);
    assert.deepEqual(touched?.stats, {
      accessCount: 1,
      lastAccessedAt: "2026-07-02T00:00:00.000Z",
    });

    await memories.delete("acme", [memory().id]);
    assert.equal((await memories.get("acme", [memory().id])).length, 0);
    assert.equal((await memories.get("other", [memory().id])).length, 1);
  });

  it("filters conversation-scoped memories in SQL", async () => {
    await memories.put(memory({ id: "01JAAAAAAAAAAAAAAAAAAAAAAB" }), [1, 0, 0]);
    await memories.put(
      memory({ id: "01JAAAAAAAAAAAAAAAAAAAAAAC", scope: "conversation", conversation: "chat:1" }),
      [1, 0, 0],
    );
    await memories.put(
      memory({ id: "01JAAAAAAAAAAAAAAAAAAAAAAD", scope: "conversation", conversation: "chat:2" }),
      [1, 0, 0],
    );

    assert.equal((await memories.list("acme", { limit: 10 })).length, 1);
    assert.equal((await memories.list("acme", { limit: 10, conversation: "chat:1" })).length, 2);
    assert.equal((await memories.query("acme", [1, 0, 0], 10, "chat:2")).length, 2);
    assert.deepEqual(await memories.count("acme", "chat:1"), { project: 1, conversation: 1 });
  });

  it("accepts whatever width the embedding model produces", async () => {
    const wide = Array.from({ length: 1536 }, (_, i) => (i % 7) / 7);
    await memories.put(memory(), wide);
    const [hit] = await memories.query("acme", wide, 1);
    assert.ok(hit && Math.abs(hit.similarity - 1) < 1e-6);
  });

  it("runs all five memory operations end to end", async () => {
    const service = new MemoryManager(memories, new FakeEmbedder(), 0.1);
    const stored = await service.remember("acme", {
      content: "The deploy pipeline pushes the image to ECR",
      memoryType: "project",
      tags: ["deploy"],
    });
    await service.remember("acme", {
      content: "Tests run with node --test under tsx",
      memoryType: "pattern",
      tags: [],
    });

    assert.match(await service.recall("acme", { query: "where does the pipeline push the image" }), /ECR/);
    assert.match(await service.list("acme", { limit: 20 }), /2 memories/);
    assert.match(await service.stats("acme"), /project: 1, pattern: 1/);

    const id = /\[id:([0-9A-Z]{26})\]/.exec(stored)![1]!;
    assert.match(await service.forget("acme", id), /Deleted/);
    assert.match(await service.stats("acme"), /pattern: 1/);
  });
});

describe("an idle PostgreSQL connection dying", () => {
  it("is reported instead of taking the process down", () => {
    const pool = new EventEmitter();
    const wrote = mock.method(console, "error", () => {});
    reportIdleFailures(pool);
    try {
      assert.doesNotThrow(() => pool.emit("error", new Error("connection terminated unexpectedly")));
      assert.equal(wrote.mock.callCount(), 1);
    } finally {
      wrote.mock.restore();
    }
  });
});
