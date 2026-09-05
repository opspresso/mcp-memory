/**
 * Argument handling.
 *
 * The caller is a model, so a bad argument comes back as a tool result with
 * `isError` rather than as a protocol error — the model can fix a wrong
 * argument and try again, whereas a protocol error would fail the whole run.
 * These assert that split as much as they assert the validation itself.
 */

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import type { MemoryService } from "./service.js";
import { MAX_CONTENT_BYTES, MemoryStoreError } from "./store/memoryStore.js";
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
    throw new Error("PostgreSQL is having a day");
  },
  remember: async () => "",
  list: async () => "",
  forget: async () => "",
  stats: async () => "",
};

/** A store refusing input the model sent, not a dependency failing. */
const overBudget: MemoryService = {
  recall: async () => "",
  remember: async () => {
    throw new MemoryStoreError(
      "content is too large. Store a shorter fact.",
    );
  },
  list: async () => "",
  forget: async () => "",
  stats: async () => "",
};

function call(name: string, args: Record<string, unknown>, conversation?: string) {
  seen.length = 0;
  return callTool(service, { tenant: "demo", ...(conversation ? { conversation } : {}) }, name, args);
}

describe("tool definitions", () => {
  it("declares the five memory tools the README documents", () => {
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
    assert.deepEqual(seen[0], { query: "x", limit: undefined, mode: undefined, conversation: undefined });
  });

  it("passes a valid mode and limit through", async () => {
    await call("recall", { query: "x", mode: "precision", limit: 3 });
    assert.deepEqual(seen[0], { query: "x", limit: 3, mode: "precision", conversation: undefined });
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
      scope: "project",
      conversation: undefined,
    });
  });

  it("scopes a memory to the request's conversation, and only when there is one", async () => {
    await call("remember", { content: "keep answers short here", scope: "conversation" }, "slack:C1:1.0");
    assert.deepEqual(seen[0], {
      content: "keep answers short here",
      memoryType: "project",
      category: undefined,
      tags: [],
      scope: "conversation",
      conversation: "slack:C1:1.0",
    });

    // A project memory written from a conversation still records which one.
    await call("remember", { content: "deploys go through ArgoCD" }, "slack:C1:1.0");
    assert.equal((seen[0] as { scope: string; conversation?: string }).scope, "project");
    assert.equal((seen[0] as { conversation?: string }).conversation, "slack:C1:1.0");

    // Asked for a thread-local memory on a request in no thread: refused by
    // name, never silently promoted to the project.
    const refused = await call("remember", { content: "x", scope: "conversation" });
    assert.equal(refused.isError, true);
    assert.match(refused.content[0]!.text, /X-Conversation-Id/);
    assert.equal(seen.length, 0);

    const bad = await call("remember", { content: "x", scope: "thread" });
    assert.equal(bad.isError, true);
    assert.match(bad.content[0]!.text, /`scope` must be one of/);
  });

  it("hands recall and list the request's conversation", async () => {
    await call("recall", { query: "x" }, "chat:c1");
    assert.equal((seen[0] as { conversation?: string }).conversation, "chat:c1");
    await call("list_memories", {}, "chat:c1");
    assert.equal((seen[0] as { conversation?: string }).conversation, "chat:c1");
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

  it("measures the body limit in bytes", async () => {
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

  it("refuses oversized labels", async () => {
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
    assert.deepEqual(seen[0], { memoryType: undefined, limit: 20, conversation: undefined });
  });

  it("passes a type filter through", async () => {
    await call("list_memories", { type: "pattern", limit: 5 });
    assert.deepEqual(seen[0], { memoryType: "pattern", limit: 5, conversation: undefined });
  });

  it("requires an id to forget", async () => {
    assert.equal((await call("forget", {})).isError, true);
    await call("forget", { id: "01ABC" });
    assert.equal(seen[0], "01ABC");
  });
});

describe("failures", () => {
  it("reports a storage failure as a tool error, not a protocol one", async () => {
    const result = await callTool(failing, { tenant: "demo" }, "recall", { query: "x" });
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /could not complete this request/);
    assert.match(result.content[0]!.text, /PostgreSQL is having a day/);
  });

  it("rejects a tool it does not have", async () => {
    assert.equal((await call("drop_everything", {})).isError, true);
  });

  it("hands a budget refusal back as the model's mistake, not a dependency failing", async () => {
    // The store is the only place that can see the *sum* — twenty tags beside
    // a 32 KB body — so the refusal arrives from it. It is still something
    // only the model can act on: reported as a storage failure it woke
    // somebody, and buried the actionable sentence behind one that was wrong.
    const wrote = mock.method(console, "error", () => {});
    try {
      const result = await callTool(overBudget, { tenant: "demo" }, "remember", { content: "x" });
      assert.equal(result.isError, true);
      assert.match(result.content[0]!.text, /Store a shorter fact/);
      assert.doesNotMatch(result.content[0]!.text, /could not complete this request/);
      assert.equal(wrote.mock.callCount(), 0, "nothing for an operator to act on");
    } finally {
      wrote.mock.restore();
    }
  });
});

describe("the log", () => {
  /** The `tool_call` lines written while `run` executes, parsed. */
  async function linesDuring(run: () => Promise<unknown>): Promise<Record<string, unknown>[]> {
    const write = mock.method(console, "log", () => {});
    try {
      await run();
      return write.mock.calls
        .map((call) => JSON.parse(String(call.arguments[0])) as Record<string, unknown>)
        .filter((line) => line.event === "tool_call");
    } finally {
      write.mock.restore();
    }
  }

  it("writes one line per call, naming the tool and the tenant", async () => {
    const lines = await linesDuring(() => call("recall", { query: "how do we deploy" }));
    assert.equal(lines.length, 1);
    const [line] = lines;
    assert.equal(line?.level, "info");
    assert.equal(line?.tool, "recall");
    assert.equal(line?.tenant, "demo");
    assert.equal(line?.ok, true);
    assert.equal(typeof line?.ms, "number");
  });

  it("never carries what was asked or remembered", async () => {
    const lines = await linesDuring(async () => {
      await call("recall", { query: "the secret query" });
      await call("remember", { content: "the secret fact", tags: ["secret-tag"] });
    });
    assert.equal(lines.length, 2);
    const written = JSON.stringify(lines);
    assert.doesNotMatch(written, /secret/);
  });

  it("marks a refusal and a failure alike as not ok", async () => {
    const [refused] = await linesDuring(() => call("recall", { limit: 3 }));
    assert.equal(refused?.ok, false);
    const [failed] = await linesDuring(() =>
      callTool(failing, { tenant: "demo" }, "recall", { query: "x" }),
    );
    assert.equal(failed?.ok, false);
  });
});
