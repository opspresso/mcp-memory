/** PostgreSQL adapter integration tests, enabled by TEST_DATABASE_URL. */

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
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
  let admin: pg.Pool;
  const schema = `memory_test_${randomUUID().replaceAll("-", "")}`;
  let memories: PgMemoryStore;

  before(async () => {
    admin = new pg.Pool({ connectionString: DATABASE_URL });
    await admin.query("CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public");
    await admin.query(`CREATE SCHEMA ${schema}`);
    const connection = new URL(DATABASE_URL!);
    connection.searchParams.set("options", `-c search_path=${schema},public`);
    pool = new pg.Pool({ connectionString: connection.toString() });
    const { rows } = await pool.query("SELECT current_schema() AS schema");
    assert.equal(rows[0]?.schema, schema);
    await ensureSchema(pool, 3);
    memories = new PgMemoryStore(pool);
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE memories");
    await ensureSchema(pool, 3);
  });

  after(async () => {
    await pool?.end();
    if (admin) {
      try {
        await admin.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      } finally {
        await admin.end();
      }
    }
  });

  it("creates the relational schema idempotently", async () => {
    await ensureSchema(pool, 3);
    const { rows } = await pool.query(
      "SELECT column_name FROM information_schema.columns " +
        "WHERE table_schema = current_schema() AND table_name = 'memories' ORDER BY ordinal_position",
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
    assert.deepEqual(await memories.count("acme"), { project: 1 });
    assert.deepEqual(await memories.count("acme", "chat:1"), { project: 2 });
  });

  it("supports a different configured width after memories are cleared", async () => {
    await ensureSchema(pool, 1536);
    const wide = Array.from({ length: 1536 }, (_, i) => (i % 7) / 7);
    await memories.put(memory(), wide);
    const [hit] = await memories.query("acme", wide, 1);
    assert.ok(hit && Math.abs(hit.similarity - 1) < 1e-6);
  });

  it("rejects a new memory with incompatible dimensions without breaking recall", async () => {
    await memories.putIfAbsent(memory(), [1, 0, 0]);
    await assert.rejects(
      memories.putIfAbsent(memory({ id: "incompatible", content: "A different fact" }), [1, 0]),
      /dimensions/,
    );
    assert.deepEqual(await memories.count("acme"), { project: 1 });
    assert.equal((await memories.query("acme", [1, 0, 0], 10)).length, 1);
  });

  it("constrains an existing untyped vector column without losing memories", async () => {
    await pool.query("ALTER TABLE memories ALTER COLUMN embedding TYPE vector");
    await memories.put(memory(), [1, 0, 0]);
    await ensureSchema(pool, 3);
    assert.equal((await memories.query("acme", [1, 0, 0], 10)).length, 1);
    await assert.rejects(memories.put(memory({ id: "wrong-width" }), [1, 0]), /dimensions/);
  });

  it("fails startup and preserves data when existing dimensions do not match", async () => {
    await pool.query("ALTER TABLE memories ALTER COLUMN embedding TYPE vector");
    await memories.put(memory(), [1, 0]);
    await assert.rejects(ensureSchema(pool, 3), /clear or re-embed/);
    assert.equal((await memories.query("acme", [1, 0], 10)).length, 1);
  });

  it("inserts concurrent repeats once and records each duplicate access", async () => {
    const results = await Promise.all(Array.from({ length: 8 }, (_, i) =>
      memories.putIfAbsent(memory({ id: `concurrent-${i}` }), [1, 0, 0]),
    ));
    assert.equal(results.filter((existing) => existing === undefined).length, 1);
    assert.deepEqual(await memories.count("acme"), { project: 1 });
    const [hit] = await memories.query("acme", [1, 0, 0], 1);
    assert.equal(hit?.stats.accessCount, 7);
  });

  it("deduplicates only within the same tenant and storage scope", async () => {
    const variants: Partial<StoredMemory>[] = [
      {}, { tenantId: "other" },
      { scope: "conversation", conversation: "chat:1" },
      { scope: "conversation", conversation: "chat:2" },
    ];
    for (const [i, variant] of variants.entries()) {
      assert.equal(await memories.putIfAbsent(memory({ id: `scope-${i}`, ...variant }), [1, 0, 0]), undefined);
    }
    const repeated = await memories.putIfAbsent(memory({ id: "repeat", conversation: "chat:1" }), [1, 0, 0]);
    assert.equal(repeated?.id, "scope-0");
    assert.deepEqual(await memories.count("acme", "chat:1"), { project: 2 });
  });

  it("releases a failed insertion transaction so it can be retried", async () => {
    await assert.rejects(memories.putIfAbsent(memory(), []));
    assert.equal(await memories.putIfAbsent(memory(), [1, 0, 0]), undefined);
  });

  it("runs all five memory operations end to end", async () => {
    await ensureSchema(pool, 64);
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
