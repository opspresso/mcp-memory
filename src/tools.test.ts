/**
 * Argument handling.
 *
 * The caller is a model, so a bad argument comes back as a tool result with
 * `isError` rather than as a protocol error — the model can fix a wrong
 * argument and try again, whereas a protocol error would fail the whole run.
 * These assert that split as much as they assert the validation itself.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { MemoryService } from "./service.js";
import { MAX_CONTENT_BYTES } from "./store/vectors.js";
import { callTool, MAX_TAGS, TOOLS } from "./tools.js";

const seen: unknown[] = [];

const service: MemoryService = {
  recall: async (_t, r) => {
    seen.push(r);
    return "recalled";
  },
  remember: async (_t, r) => {
    seen.push(r);
    return "remembered";
  },
  list: async (_t, r) => {
    seen.push(r);
    return "listed";
  },
  forget: async (_t, id) => {
    seen.push(id);
    return "forgotten";
  },
  stats: async () => "stats",
};

const failing: MemoryService = {
  recall: async () => {
    throw new Error("S3 is having a day");
  },
  remember: async () => "",
  list: async () => "",
  forget: async () => "",
  stats: async () => "",
};

function call(name: string, args: Record<string, unknown>) {
  seen.length = 0;
  return callTool(service, "demo", name, args);
}

describe("tool definitions", () => {
  it("declares the five tools the README documents", () => {
    assert.deepEqual(
      TOOLS.map((tool) => tool.name).sort(),
      ["forget", "list_memories", "memory_stats", "recall", "remember"],
    );
  });

  it("does not offer a tenant argument on any tool", () => {
    // The isolation boundary is the header. A tenant argument would let the
    // model name its own — including a model talked into it by text it just read.
    for (const tool of TOOLS) {
      const properties = (tool.inputSchema as { properties?: Record<string, unknown> }).properties;
      assert.ok(!properties || !("tenant" in properties), `${tool.name} exposes a tenant argument`);
    }
  });

  it("tells the model when to call recall, not just what it does", () => {
    // The only channel available for this: Agent Studio reads no MCP resources,
    // so nothing can push remembered context into a run before it starts.
    const recall = TOOLS.find((tool) => tool.name === "recall")!;
    assert.match(recall.description, /at the start of a task/);
  });
});

describe("recall", () => {
  it("applies the defaults the mode implies", async () => {
    assert.equal((await call("recall", { query: "x" })).content[0]?.text, "recalled");
    assert.deepEqual(seen[0], { query: "x", limit: undefined, mode: undefined });
  });

  it("passes a valid mode and limit through", async () => {
    await call("recall", { query: "x", mode: "precision", limit: 3 });
    assert.deepEqual(seen[0], { query: "x", limit: 3, mode: "precision" });
  });

  it("refuses an unknown mode", async () => {
    const result = await call("recall", { query: "x", mode: "aggressive" });
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /precision, balanced or exploratory/);
  });

  it("refuses a limit outside the range", async () => {
    for (const limit of [0, -1, 51, 1.5, "3"]) {
      const result = await call("recall", { query: "x", limit });
      assert.equal(result.isError, true, `should reject limit ${JSON.stringify(limit)}`);
    }
  });

  it("refuses an empty query", async () => {
    for (const query of ["", "   ", undefined, 42]) {
      assert.equal((await call("recall", { query })).isError, true);
    }
  });
});

describe("remember", () => {
  it("defaults the type to project", async () => {
    await call("remember", { content: "a fact" });
    assert.deepEqual(seen[0], {
      content: "a fact",
      memoryType: "project",
      category: undefined,
      tags: [],
    });
  });

  it("normalises tags and drops the empty ones", async () => {
    await call("remember", { content: "a fact", tags: [" one ", "", "two"] });
    assert.deepEqual((seen[0] as { tags: string[] }).tags, ["one", "two"]);
  });

  it("refuses too many tags", async () => {
    const result = await call("remember", {
      content: "a fact",
      tags: Array.from({ length: MAX_TAGS + 1 }, (_, i) => `t${i}`),
    });
    assert.equal(result.isError, true);
  });

  it("measures the body in bytes, because the metadata budget is bytes", async () => {
    // Korean is three bytes a character, so a character-based check would pass
    // content the service then rejects.
    const korean = "가".repeat(MAX_CONTENT_BYTES / 3 + 1);
    assert.ok(korean.length < MAX_CONTENT_BYTES, "the fixture is under the limit by characters");

    const result = await call("remember", { content: korean });
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /bytes/);
  });

  it("accepts a body right up to the limit", async () => {
    const result = await call("remember", { content: "a".repeat(MAX_CONTENT_BYTES) });
    assert.notEqual(result.isError, true);
  });

  it("refuses labels that would overflow the metadata budget", async () => {
    // Content is not the only thing a model chooses. The category shares a 2 KB
    // filterable budget it can exhaust alone, and twenty tags share a 40 KB one
    // with a body that may be 32 KB — both used to reach AWS and come back as a
    // size the model could not attribute to anything it sent.
    const longCategory = await call("remember", { content: "a fact", category: "d".repeat(3000) });
    assert.equal(longCategory.isError, true);
    assert.match(longCategory.content[0]!.text, /`category` may be at most/);

    const longTag = await call("remember", { content: "a fact", tags: ["t".repeat(500)] });
    assert.equal(longTag.isError, true);
    assert.match(longTag.content[0]!.text, /each tag may be at most/);
  });

  it("still accepts labels of the size they are meant to be", async () => {
    const ok = await call("remember", {
      content: "a fact",
      category: "decision",
      tags: ["deploy", "ecr", "배포"],
    });
    assert.notEqual(ok.isError, true);
  });

  it("refuses an unknown type", async () => {
    assert.equal((await call("remember", { content: "x", type: "episodic" })).isError, true);
  });
});

describe("list_memories and forget", () => {
  it("defaults the list limit to 20", async () => {
    await call("list_memories", {});
    assert.deepEqual(seen[0], { memoryType: undefined, limit: 20 });
  });

  it("passes a type filter through", async () => {
    await call("list_memories", { type: "pattern", limit: 5 });
    assert.deepEqual(seen[0], { memoryType: "pattern", limit: 5 });
  });

  it("requires an id to forget", async () => {
    assert.equal((await call("forget", {})).isError, true);
    await call("forget", { id: "01ABC" });
    assert.equal(seen[0], "01ABC");
  });
});

describe("failures", () => {
  it("reports a storage failure as a tool error, not a protocol one", async () => {
    const result = await callTool(failing, "demo", "recall", { query: "x" });
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /could not complete this request/);
    assert.match(result.content[0]!.text, /S3 is having a day/);
  });

  it("rejects a tool it does not have", async () => {
    assert.equal((await call("drop_everything", {})).isError, true);
  });
});
