/**
 * What this store actually sends to pgvector — the counterpart of
 * `vectors.test.ts` for the other backend.
 *
 * The tenant filter is the thing worth pinning, as there: it is a WHERE clause
 * and nothing else, and every read carries it. The rest is that a distance
 * comes back as the similarity the ranking expects, and that a record is read
 * through the same `fromMetadata` as the S3 store, so a memory means the same
 * thing whichever backend held it.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { Queryable } from "./pgObjects.js";
import { PgVectorStore, toVectorLiteral } from "./pgVectors.js";
import { toMetadata, VectorStoreError } from "./vectors.js";
import type { StoredMemory } from "../types.js";

interface Sent {
  text: string;
  values: unknown[];
}

function stub(answers: { rows?: Record<string, unknown>[] }[] = []) {
  const sent: Sent[] = [];
  let next = 0;
  const db: Queryable = {
    query: async (text, values = []) => {
      sent.push({ text, values });
      const rows = answers[next++]?.rows ?? [];
      return { rows, rowCount: rows.length };
    },
  };
  return { store: new PgVectorStore(db), sent };
}

function memory(overrides: Partial<StoredMemory> = {}): StoredMemory {
  return {
    id: "01JAAAAAAAAAAAAAAAAAAAAAAA",
    tenantId: "acme",
    content: "The deploy pipeline pushes to ECR",
    memoryType: "project",
    tags: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    trustBase: 1,
    ...overrides,
  };
}

describe("put", () => {
  it("writes the vector in pgvector's text form beside the same metadata S3 would hold", async () => {
    const { store, sent } = stub();
    await store.put(memory({ tags: ["deploy"] }), [0.1, 0.2]);

    assert.match(sent[0]!.text, /^INSERT INTO memories/);
    assert.deepEqual(sent[0]!.values, [
      "acme",
      "01JAAAAAAAAAAAAAAAAAAAAAAA",
      "[0.1,0.2]",
      JSON.stringify(toMetadata(memory({ tags: ["deploy"] }))),
    ]);
  });

  it("refuses what S3 Vectors would refuse, before spending a round trip", async () => {
    // The documented ceiling on a memory is one number, not one per backend.
    const { store, sent } = stub();
    await assert.rejects(
      () => store.put(memory({ content: "c".repeat(32_001) }), [0.1]),
      VectorStoreError,
    );
    assert.equal(sent.length, 0);
  });
});

describe("query", () => {
  it("filters by tenant in the WHERE clause and orders by cosine distance", async () => {
    const { store, sent } = stub([{ rows: [] }]);
    await store.query("acme", [0.1, 0.2], 30);

    assert.match(sent[0]!.text, /WHERE tenant_id = \$1 ORDER BY embedding <=> \$2::vector LIMIT \$3/);
    assert.deepEqual(sent[0]!.values, ["acme", "[0.1,0.2]", 30]);
  });

  it("converts distance to similarity", async () => {
    const { store } = stub([
      { rows: [{ id: "01JAAAAAAAAAAAAAAAAAAAAAAA", metadata: toMetadata(memory()), distance: 0.25 }] },
    ]);
    const [hit] = await store.query("acme", [0.1], 30);

    assert.equal(hit?.similarity, 0.75);
    assert.equal(hit?.memory.id, "01JAAAAAAAAAAAAAAAAAAAAAAA");
    assert.equal(hit?.memory.content, "The deploy pipeline pushes to ECR");
  });

  it("reads a distance the driver handed back as text", async () => {
    // `float8` arrives as a number, but a `numeric` — or a driver without type
    // parsers — arrives as a string. Either way it is a distance.
    const { store } = stub([
      { rows: [{ id: "01JAAAAAAAAAAAAAAAAAAAAAAA", metadata: toMetadata(memory()), distance: "0.5" }] },
    ]);
    const [hit] = await store.query("acme", [0.1], 30);
    assert.equal(hit?.similarity, 0.5);
  });

  it("drops a record whose metadata names another tenant", async () => {
    const { store } = stub([
      {
        rows: [
          { id: "01JBBBBBBBBBBBBBBBBBBBBBBB", metadata: toMetadata(memory({ tenantId: "other" })), distance: 0 },
          { id: "01JAAAAAAAAAAAAAAAAAAAAAAA", metadata: toMetadata(memory()), distance: 0.1 },
        ],
      },
    ]);
    const hits = await store.query("acme", [0.1], 30);

    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.memory.tenantId, "acme");
  });
});

describe("get and delete", () => {
  it("carry the caller's own tenant beside the ids", async () => {
    const { store, sent } = stub([{ rows: [] }, { rows: [] }]);
    await store.get("acme", ["a", "b"]);
    await store.delete("acme", ["a"]);

    for (const call of sent) {
      assert.match(call.text, /tenant_id = \$1 AND id = ANY\(\$2::text\[\]\)/);
      assert.equal(call.values[0], "acme");
    }
  });

  it("say nothing to the database when there is nothing to say", async () => {
    const { store, sent } = stub();
    await store.get("acme", []);
    await store.delete("acme", []);
    assert.equal(sent.length, 0);
  });
});

describe("toVectorLiteral", () => {
  it("is the bracketed form pgvector parses", () => {
    assert.equal(toVectorLiteral([1, -0.5, 2e-7]), "[1,-0.5,2e-7]");
  });
});
