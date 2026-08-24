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
import type { DocsRetriever } from "./docs.js";
import type { MemoryService } from "./service.js";
import { MAX_CONTENT_BYTES, VectorStoreError } from "./store/vectors.js";
import { callTool, MAX_QUERY_CHARS, MAX_TAGS, SEARCH_DOCS_TOOL, TOOLS, toolCatalogue } from "./tools.js";

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

/** A store refusing the metadata budget — what the model sent, not a dependency failing. */
const overBudget: MemoryService = {
  recall: async () => "",
  remember: async () => {
    throw new VectorStoreError(
      "the memory and its labels are 41000 bytes against a 40000 byte limit. " +
        "Shorten the tags, or store a shorter fact.",
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

  it("offers search_docs only when a knowledge base is configured", () => {
    // The memories-only guarantee hangs on this split: `TOOLS` stays the five,
    // and `toolCatalogue` is the one place the docs tool joins them.
    assert.ok(!TOOLS.includes(SEARCH_DOCS_TOOL));
    assert.equal(toolCatalogue(false), TOOLS);
    assert.deepEqual(
      toolCatalogue(true).map((tool) => tool.name),
      [...TOOLS.map((tool) => tool.name), "search_docs"],
    );
  });

  it("does not offer a tenant argument on any tool", () => {
    // The isolation boundary is the header. A tenant argument would let the
    // model name its own — including a model talked into it by text it just read.
    for (const tool of toolCatalogue(true)) {
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

describe("search_docs", () => {
  const docsSeen: unknown[] = [];
  const retriever: DocsRetriever = {
    retrieve: async (query, limit) => {
      docsSeen.push({ query, limit });
      return [{ excerpt: "an excerpt", source: "s3://docs/a.md", score: 0.5 }];
    },
  };

  function search(args: Record<string, unknown>, docs: DocsRetriever = retriever) {
    docsSeen.length = 0;
    return callTool(service, { tenant: "demo" }, "search_docs", args, docs);
  }

  it("searches with the knowledge base's default limit", async () => {
    const result = await search({ query: "how do we deploy" });
    assert.match(result.content[0]!.text, /^\[DOCS\]/);
    assert.deepEqual(docsSeen[0], { query: "how do we deploy", limit: 5 });
  });

  it("passes a valid limit through and refuses one outside the range", async () => {
    await search({ query: "x", limit: 3 });
    assert.deepEqual(docsSeen[0], { query: "x", limit: 3 });

    for (const limit of [0, 51, 1.5, "3"]) {
      const result = await search({ query: "x", limit });
      assert.equal(result.isError, true, `should reject limit ${JSON.stringify(limit)}`);
    }
  });

  it("refuses an empty query and an oversized one, in characters", async () => {
    assert.equal((await search({ query: "" })).isError, true);

    // Characters, not bytes: the Retrieve API's ceiling is measured that way,
    // unlike the byte budgets on remember.
    const result = await search({ query: "가".repeat(MAX_QUERY_CHARS + 1) });
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /characters/);
  });

  it("does not exist without a knowledge base, even at the dispatch layer", async () => {
    // The server already rejects the name when the catalogue omits it; this is
    // the dispatch refusing to depend on that.
    const result = await callTool(service, { tenant: "demo" }, "search_docs", { query: "x" });
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /unknown tool "search_docs"/);
  });

  it("blames the documentation index, not the memory store, when the KB fails", async () => {
    const result = await search({ query: "x" }, {
      retrieve: async () => {
        throw new Error("KB is having a day");
      },
    });
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /documentation index could not be searched/);
    assert.match(result.content[0]!.text, /KB is having a day/);
    assert.ok(!/memory store/.test(result.content[0]!.text));
  });
});

describe("failures", () => {
  it("reports a storage failure as a tool error, not a protocol one", async () => {
    const result = await callTool(failing, { tenant: "demo" }, "recall", { query: "x" });
    assert.equal(result.isError, true);
    assert.match(result.content[0]!.text, /could not complete this request/);
    assert.match(result.content[0]!.text, /S3 is having a day/);
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
      assert.match(result.content[0]!.text, /Shorten the tags/);
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
