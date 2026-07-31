/**
 * What this store actually sends to S3 Vectors.
 *
 * The fake in `src/testing/` stands in for the service everywhere above this
 * layer, which means the real client was the one piece nothing exercised — and
 * it is the piece holding the tenant filter. These assert the command inputs:
 * the shape of that filter, the per-call key limits the service imposes, and
 * the clamp that keeps a large `topK` from being answered with a silent prefix.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { S3VectorsClient } from "@aws-sdk/client-s3vectors";
import {
  assertWithinMetadataBudget,
  S3VectorsStore,
  toMetadata,
  VectorStoreError,
} from "./vectors.js";
import type { StoredMemory } from "../types.js";

interface Sent {
  name: string;
  input: Record<string, any>;
}

/** Captures command inputs and hands back canned responses in order. */
function stub(responses: unknown[] = []) {
  const sent: Sent[] = [];
  let next = 0;
  const client = {
    send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      sent.push({ name: command.constructor.name, input: command.input });
      return responses[next++] ?? {};
    },
  };
  return { store: new S3VectorsStore(client as unknown as S3VectorsClient, "bkt", "idx"), sent };
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

describe("query", () => {
  it("filters by tenant with a bare value, which the service reads as equality", async () => {
    // The isolation boundary as it goes over the wire. A filter that named the
    // wrong key, or wrapped the value in an operator the service does not
    // apply, would widen every read to the whole index.
    const { store, sent } = stub([{ vectors: [] }]);
    await store.query("acme", [0.1, 0.2], 30);

    assert.deepEqual(sent[0]!.input.filter, { tenantId: "acme" });
    assert.equal(sent[0]!.input.vectorBucketName, "bkt");
    assert.equal(sent[0]!.input.indexName, "idx");
    assert.equal(sent[0]!.input.returnMetadata, true);
    assert.equal(sent[0]!.input.returnDistance, true);
  });

  it("clamps topK to what one response can carry", async () => {
    // Above this the remainder sits behind a nextToken this store does not
    // follow, so an unclamped topK is answered with a prefix and no error.
    const { store, sent } = stub([{ vectors: [] }]);
    await store.query("acme", [0.1], 5_000);

    assert.equal(sent[0]!.input.topK, 100);
  });

  it("converts distance to similarity", async () => {
    const { store } = stub([
      { vectors: [{ key: "acme#01JAAAAAAAAAAAAAAAAAAAAAAA", metadata: toMetadata(memory()), distance: 0.25 }] },
    ]);
    const [hit] = await store.query("acme", [0.1], 30);

    assert.equal(hit?.similarity, 0.75);
    assert.equal(hit?.memory.id, "01JAAAAAAAAAAAAAAAAAAAAAAA");
  });

  it("drops a record whose metadata names another tenant", async () => {
    // Unreachable if the filter works. Asserted because the one bug whose blast
    // radius is another project's data must not depend on a single mechanism.
    const { store } = stub([
      {
        vectors: [
          { key: "other#01JBBBBBBBBBBBBBBBBBBBBBBB", metadata: toMetadata(memory({ tenantId: "other" })), distance: 0 },
          { key: "acme#01JAAAAAAAAAAAAAAAAAAAAAAA", metadata: toMetadata(memory()), distance: 0.1 },
        ],
      },
    ]);
    const hits = await store.query("acme", [0.1], 30);

    assert.equal(hits.length, 1);
    assert.equal(hits[0]?.memory.tenantId, "acme");
  });
});

describe("per-call key limits", () => {
  it("splits a get at the 100 keys one call accepts", async () => {
    const { store, sent } = stub([{ vectors: [] }, { vectors: [] }, { vectors: [] }]);
    await store.get("acme", Array.from({ length: 250 }, (_, i) => `id-${i}`));

    assert.deepEqual(
      sent.map((call) => call.input.keys.length),
      [100, 100, 50],
    );
    assert.ok(
      sent.every((call) => call.input.keys.every((key: string) => key.startsWith("acme#"))),
      "every key must carry the caller's own tenant",
    );
  });

  it("splits a delete at the 500 keys one call accepts", async () => {
    const { store, sent } = stub();
    await store.delete("acme", Array.from({ length: 600 }, (_, i) => `id-${i}`));

    assert.deepEqual(
      sent.map((call) => call.input.keys.length),
      [500, 100],
    );
  });

  it("says nothing to the service when there is nothing to say", async () => {
    const { store, sent } = stub();
    await store.get("acme", []);
    await store.delete("acme", []);

    assert.equal(sent.length, 0);
  });
});

describe("assertWithinMetadataBudget", () => {
  it("accepts a memory of the shape this server writes", () => {
    assert.doesNotThrow(() =>
      assertWithinMetadataBudget(memory({ category: "decision", tags: ["deploy", "ecr"] })),
    );
  });

  it("refuses a body past the content ceiling", () => {
    assert.throws(
      () => assertWithinMetadataBudget(memory({ content: "c".repeat(32_001) })),
      /Store the essential fact/,
    );
  });

  it("refuses a category that would exhaust the filterable half", () => {
    // It is the filterable budget that this overflows, not the total — the
    // message has to send the caller at the right field.
    assert.throws(
      () => assertWithinMetadataBudget(memory({ category: "d".repeat(3_000) })),
      /filterable metadata is \d+ bytes/,
    );
  });

  it("refuses tags that carry a legal body past the total", () => {
    assert.throws(
      () =>
        assertWithinMetadataBudget(
          memory({ content: "c".repeat(32_000), tags: Array<string>(20).fill("t".repeat(500)) }),
        ),
      /Shorten the tags/,
    );
  });

  it("is what put checks before spending a round trip", async () => {
    const { store, sent } = stub();
    await assert.rejects(
      () => store.put(memory({ content: "c".repeat(32_001) }), [0.1]),
      VectorStoreError,
    );
    assert.equal(sent.length, 0, "a memory the service would refuse must not be sent");
  });
});
