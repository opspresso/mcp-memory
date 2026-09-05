/** SQL contract for the PostgreSQL memory adapter. */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { StoredMemory } from "../types.js";
import { PgMemoryStore, toVectorLiteral, type Queryable } from "./pgMemoryStore.js";
import { MemoryStoreError } from "./memoryStore.js";

interface Sent {
  text: string;
  values: unknown[];
}

function stub(answers: { rows?: Record<string, unknown>[]; rowCount?: number }[] = []) {
  const sent: Sent[] = [];
  let next = 0;
  const db: Queryable = {
    query: async (text, values = []) => {
      sent.push({ text, values });
      const answer = answers[next++] ?? {};
      return { rows: answer.rows ?? [], rowCount: answer.rowCount ?? answer.rows?.length ?? 0 };
    },
  };
  return { store: new PgMemoryStore(db), sent };
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

function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: "01JAAAAAAAAAAAAAAAAAAAAAAA",
    tenant_id: "acme",
    content: "The deploy pipeline pushes to ECR",
    memory_type: "project",
    category: null,
    tags: [],
    created_at: "2026-07-01T00:00:00.000Z",
    scope: "project",
    conversation: null,
    trust_base: 1,
    access_count: 0,
    last_accessed_at: null,
    distance: 0.25,
    ...overrides,
  };
}

describe("put", () => {
  it("writes every memory field and the vector", async () => {
    const { store, sent } = stub();
    await store.put(memory({ tags: ["deploy"] }), [0.1, 0.2]);

    assert.match(sent[0]!.text, /^INSERT INTO memories/);
    assert.deepEqual(sent[0]!.values, [
      "acme",
      "01JAAAAAAAAAAAAAAAAAAAAAAA",
      "The deploy pipeline pushes to ECR",
      "project",
      null,
      ["deploy"],
      "2026-07-01T00:00:00.000Z",
      "project",
      null,
      1,
      "[0.1,0.2]",
    ]);
  });

  it("refuses an oversized memory before spending a round trip", async () => {
    const { store, sent } = stub();
    await assert.rejects(() => store.put(memory({ content: "c".repeat(32_001) }), [0.1]), MemoryStoreError);
    assert.equal(sent.length, 0);
  });
});

describe("query", () => {
  it("filters tenant and conversation visibility in SQL", async () => {
    const { store, sent } = stub();
    await store.query("acme", [0.1, 0.2], 30, "chat:1");

    assert.match(sent[0]!.text, /tenant_id = \$1/);
    assert.match(sent[0]!.text, /scope = 'conversation'.*conversation = \$3/);
    assert.match(sent[0]!.text, /ORDER BY embedding <=> \$2::vector LIMIT \$4/);
    assert.deepEqual(sent[0]!.values, ["acme", "[0.1,0.2]", "chat:1", 30]);
  });

  it("returns memory, cosine similarity and durable stats", async () => {
    const { store } = stub([
      { rows: [row({ access_count: "3", last_accessed_at: "2026-07-02T00:00:00.000Z" })] },
    ]);
    const [hit] = await store.query("acme", [0.1], 30);

    assert.equal(hit?.similarity, 0.75);
    assert.equal(hit?.memory.content, "The deploy pipeline pushes to ECR");
    assert.deepEqual(hit?.stats, { accessCount: 3, lastAccessedAt: "2026-07-02T00:00:00.000Z" });
  });

  it("drops a row whose tenant does not match", async () => {
    const { store } = stub([{ rows: [row({ tenant_id: "other" }), row()] }]);
    assert.equal((await store.query("acme", [0.1], 30)).length, 1);
  });
});

describe("relational operations", () => {
  it("lists newest visible memories with an optional type", async () => {
    const { store, sent } = stub([{ rows: [row()] }]);
    const listed = await store.list("acme", { conversation: "chat:1", memoryType: "project", limit: 5 });

    assert.equal(listed.length, 1);
    assert.match(sent[0]!.text, /memory_type = \$3/);
    assert.match(sent[0]!.text, /ORDER BY created_at DESC, id DESC LIMIT \$4/);
    assert.deepEqual(sent[0]!.values, ["acme", "chat:1", "project", 5]);
  });

  it("updates counters atomically", async () => {
    const { store, sent } = stub();
    await store.touch("acme", ["a", "b"], "2026-07-02T00:00:00.000Z");

    assert.match(sent[0]!.text, /access_count = access_count \+ 1/);
    assert.match(sent[0]!.text, /tenant_id = \$1 AND id = ANY\(\$2::text\[\]\)/);
  });

  it("groups exact counts by memory type", async () => {
    const { store, sent } = stub([{ rows: [{ memory_type: "project", count: 2 }] }]);
    assert.deepEqual(await store.count("acme", "chat:1"), { project: 2 });
    assert.match(sent[0]!.text, /GROUP BY memory_type/);
  });

  it("carries the tenant through get and delete", async () => {
    const { store, sent } = stub([{ rows: [] }, { rows: [] }]);
    await store.get("acme", ["a"]);
    await store.delete("acme", ["a"]);
    for (const call of sent) {
      assert.match(call.text, /tenant_id = \$1 AND id = ANY\(\$2::text\[\]\)/);
    }
  });
});

describe("toVectorLiteral", () => {
  it("is the bracketed form pgvector parses", () => {
    assert.equal(toVectorLiteral([1, -0.5, 2e-7]), "[1,-0.5,2e-7]");
  });
});
