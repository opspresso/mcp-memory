import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { StoredMemory } from "../types.js";
import { assertWithinContentBudget, MemoryStoreError } from "./memoryStore.js";

function memory(content: string): StoredMemory {
  return {
    id: "01JAAAAAAAAAAAAAAAAAAAAAAA",
    tenantId: "acme",
    content,
    memoryType: "project",
    tags: [],
    createdAt: "2026-07-01T00:00:00.000Z",
    trustBase: 1,
  };
}

describe("assertWithinContentBudget", () => {
  it("accepts the limit and refuses one byte beyond it", () => {
    assert.doesNotThrow(() => assertWithinContentBudget(memory("a".repeat(32_000))));
    assert.throws(
      () => assertWithinContentBudget(memory("a".repeat(32_001))),
      MemoryStoreError,
    );
  });

  it("measures UTF-8 bytes rather than characters", () => {
    assert.throws(
      () => assertWithinContentBudget(memory("가".repeat(32_000 / 3 + 1))),
      /bytes/,
    );
  });
});
