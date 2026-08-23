/**
 * The PostgreSQL backend against a real database.
 *
 * The stubs in `pgObjects.test.ts` and `pgVectors.test.ts` pin what is sent;
 * only a database can say whether what is sent does what the port promises —
 * that `"C"` collation really lists the recency index newest-first, that the
 * version condition really loses a race, that `<=>` really comes back as the
 * cosine the ranking expects. So these run when `TEST_DATABASE_URL` names a
 * database with pgvector available, and are skipped, visibly, when it does
 * not: `npm test` on a laptop without one still passes.
 *
 *   TEST_DATABASE_URL=postgres://user:pass@localhost:5432/mcp_memory_test npm test
 *
 * The database is the test's own. Both tables are emptied before each case,
 * and `node --test` runs files in parallel, so everything that touches the
 * database lives in this one file.
 */

import assert from "node:assert/strict";
import { after, before, beforeEach, describe, it } from "node:test";
import pg from "pg";
import { S3MemoryService } from "../service.js";
import { FakeEmbedder } from "../testing/fakes.js";
import { PreconditionFailed } from "./objects.js";
import { ensureSchema } from "./pg.js";
import { PgObjectStore } from "./pgObjects.js";
import { PgVectorStore } from "./pgVectors.js";
import { StatsTracker } from "./stats.js";
import type { StoredMemory } from "../types.js";

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

describe("PostgreSQL backend", { skip }, () => {
  let pool: pg.Pool;
  let objects: PgObjectStore;
  let vectors: PgVectorStore;

  before(async () => {
    pool = new pg.Pool({ connectionString: DATABASE_URL });
    await ensureSchema(pool);
    objects = new PgObjectStore(pool);
    vectors = new PgVectorStore(pool);
  });

  beforeEach(async () => {
    await pool.query("TRUNCATE memories, objects");
  });

  after(async () => {
    await pool?.end();
  });

  it("creates the schema once and tolerates being asked again", async () => {
    // Every pod runs this at boot, so the second run — and the fiftieth — must
    // be a no-op rather than a failure on a name already taken.
    await ensureSchema(pool);
    const { rows } = await pool.query(
      "SELECT table_name FROM information_schema.tables WHERE table_name IN ('memories', 'objects') ORDER BY 1",
    );
    assert.deepEqual(
      rows.map((row: { table_name: string }) => row.table_name),
      ["memories", "objects"],
    );
  });

  describe("objects", () => {
    it("round-trips a body with an etag that changes on every write", async () => {
      await objects.put("k", "one");
      const first = await objects.get("k");
      await objects.put("k", "two");
      const second = await objects.get("k");

      assert.equal(first?.body, "one");
      assert.equal(second?.body, "two");
      assert.notEqual(first?.etag, second?.etag);
      assert.equal(await objects.get("missing"), undefined);
    });

    it("lets exactly one of two compare-and-swaps on the same etag win", async () => {
      await objects.put("stats/demo/merged.json", "{}");
      const { etag } = (await objects.get("stats/demo/merged.json"))!;

      await objects.put("stats/demo/merged.json", "winner", { ifMatch: etag });
      await assert.rejects(
        () => objects.put("stats/demo/merged.json", "loser", { ifMatch: etag }),
        PreconditionFailed,
      );
      assert.equal((await objects.get("stats/demo/merged.json"))?.body, "winner");
    });

    it("refuses a compare-and-swap against a key that is not there", async () => {
      await assert.rejects(() => objects.put("absent", "v", { ifMatch: "1" }), PreconditionFailed);
    });

    it("creates only once under ifNoneMatch", async () => {
      await objects.put("k", "first", { ifNoneMatch: true });
      await assert.rejects(() => objects.put("k", "second", { ifNoneMatch: true }), PreconditionFailed);
      assert.equal((await objects.get("k"))?.body, "first");
    });

    it("does not let an etag from a row's earlier life win", async () => {
      // Versions come from one sequence, so a deleted and recreated key never
      // hands out a number a stale reader might still be holding.
      await objects.put("k", "v1");
      const { etag } = (await objects.get("k"))!;
      await objects.delete(["k"]);
      await objects.put("k", "v2");

      await assert.rejects(() => objects.put("k", "v3", { ifMatch: etag }), PreconditionFailed);
    });

    it("lists in byte order, which is what the recency index is built on", async () => {
      // `#` is 0x23 and `0` is 0x30, so in byte order `1#z` comes before
      // `10#a`. A locale collation sets punctuation aside and compares `1z`
      // against `10a` — the other way round — and the inverted timestamp in
      // an index key stops meaning newest-first.
      const keys = ["index/t/9#b", "index/t/10#a", "index/t/1#z", "index/t/1#Z", "index/u/0"];
      for (const key of keys) {
        await objects.put(key, "");
      }

      assert.deepEqual(await objects.list("index/t/"), [
        "index/t/1#Z",
        "index/t/1#z",
        "index/t/10#a",
        "index/t/9#b",
      ]);
      assert.deepEqual(await objects.list("index/t/", 2), ["index/t/1#Z", "index/t/1#z"]);
      assert.deepEqual(await objects.list("index/t/", 10, "index/t/1#z"), ["index/t/10#a", "index/t/9#b"]);
    });

    it("matches a prefix literally, wildcards included", async () => {
      await objects.put("stats/a_b/shard/x", "");
      await objects.put("stats/axb/shard/x", "");
      await objects.put("stats/a%b/shard/x", "");

      assert.deepEqual(await objects.list("stats/a_b/"), ["stats/a_b/shard/x"]);
      assert.deepEqual(await objects.list("stats/a%b/"), ["stats/a%b/shard/x"]);
    });

    it("deletes what it is given and nothing else", async () => {
      await objects.put("a", "");
      await objects.put("b", "");
      await objects.put("c", "");
      await objects.delete(["a", "c", "never-existed"]);
      assert.deepEqual(await objects.list(""), ["b"]);
    });
  });

  describe("vectors", () => {
    it("answers the nearest neighbour with a cosine similarity", async () => {
      await vectors.put(memory({ id: "01JAAAAAAAAAAAAAAAAAAAAAAA" }), [1, 0, 0]);
      await vectors.put(memory({ id: "01JBBBBBBBBBBBBBBBBBBBBBBB" }), [0, 1, 0]);

      const hits = await vectors.query("acme", [1, 0, 0], 10);
      assert.equal(hits.length, 2);
      assert.equal(hits[0]?.memory.id, "01JAAAAAAAAAAAAAAAAAAAAAAA");
      assert.ok(Math.abs(hits[0]!.similarity - 1) < 1e-6, `identical vectors score 1, got ${hits[0]!.similarity}`);
      assert.ok(Math.abs(hits[1]!.similarity) < 1e-6, `orthogonal vectors score 0, got ${hits[1]!.similarity}`);
    });

    it("keeps tenants apart on every read", async () => {
      await vectors.put(memory({ tenantId: "acme" }), [1, 0, 0]);
      await vectors.put(memory({ tenantId: "other" }), [1, 0, 0]);

      assert.equal((await vectors.query("acme", [1, 0, 0], 10)).length, 1);
      assert.equal((await vectors.get("acme", [memory().id])).length, 1);
      await vectors.delete("acme", [memory().id]);
      assert.equal((await vectors.get("acme", [memory().id])).length, 0);
      assert.equal((await vectors.get("other", [memory().id])).length, 1, "the other tenant's copy survives");
    });

    it("reads back every field it wrote, and drops ids it does not hold", async () => {
      const written = memory({
        category: "decision",
        tags: ["deploy", "ecr"],
        scope: "conversation",
        conversation: "chat:1",
      });
      await vectors.put(written, [0.5, 0.5, 0]);

      const [read] = await vectors.get("acme", [written.id, "01JMISSINGMISSINGMISSINGXX"]);
      assert.deepEqual(read, written);
    });

    it("accepts whatever width the embedding model produces", async () => {
      // No width on the column, so the first write decides nothing and a
      // 1536-wide model needs no schema change.
      const wide = Array.from({ length: 1536 }, (_, i) => (i % 7) / 7);
      await vectors.put(memory(), wide);
      const [hit] = await vectors.query("acme", wide, 1);
      assert.ok(hit && Math.abs(hit.similarity - 1) < 1e-6);
    });
  });

  describe("the service, end to end", () => {
    it("remembers, recalls, lists, counts and forgets through PostgreSQL", async () => {
      const stats = new StatsTracker(objects, {
        podId: "test",
        flushMs: 60_000,
        compactThreshold: 20,
        cacheTtlMs: 0,
      });
      // The fake embedder's similarity is roughly the fraction of shared words,
      // which at 0.1 and above is what the floor asks for.
      const service = new S3MemoryService(vectors, objects, stats, new FakeEmbedder(), 0.1);

      const stored = await service.remember("acme", {
        content: "The deploy pipeline pushes the image to ECR",
        memoryType: "project",
        tags: ["deploy"],
      });
      assert.match(stored, /Stored as/);
      await service.remember("acme", {
        content: "Tests run with node --test under tsx",
        memoryType: "pattern",
        tags: [],
      });

      const recalled = await service.recall("acme", { query: "where does the deploy pipeline push the image" });
      assert.match(recalled, /pushes the image to ECR/);

      const listed = await service.list("acme", { limit: 20 });
      assert.match(listed, /2 memories, newest first/);
      assert.match(await service.list("acme", { memoryType: "pattern", limit: 20 }), /node --test/);
      assert.match(await service.stats("acme"), /2 memories for this project \(project: 1, pattern: 1\)/);

      // Counters reach the database and come back.
      await stats.flush();
      assert.ok((await objects.list("stats/acme/shard/")).length === 1);

      const id = /\[id:([0-9A-Z]{26})\]/.exec(stored)![1]!;
      assert.match(await service.forget("acme", id), /Deleted/);
      assert.match(await service.stats("acme"), /1 memories/);
      assert.match(await service.list("other", { limit: 20 }), /no memories/);
    });
  });
});
