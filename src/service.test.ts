/**
 * The five operations end to end, over the in-memory stores.
 *
 * These are the tests that would catch a tenant leak, so isolation is asserted
 * on every path that can read — not once as a representative case.
 */

import assert from "node:assert/strict";
import { beforeEach, describe, it } from "node:test";
import type { Embedder } from "./embeddings.js";
import { ulid } from "./id.js";
import { MemoryManager } from "./service.js";
import { FakeEmbedder, InMemoryMemoryStore } from "./testing/fakes.js";
import type { MemoryStore } from "./store/memoryStore.js";
import type { StoredMemory } from "./types.js";

const START = Date.parse("2026-07-01T00:00:00.000Z");

let clock: number;
let vectors: InMemoryMemoryStore;
let service: MemoryManager;

beforeEach(() => {
  clock = START;
  vectors = new InMemoryMemoryStore();
  // The fake embedder's scale is not Titan's, so the floor is set for it: its
  // unrelated pairs land near 0 and its related ones well above 0.3.
  service = new MemoryManager(vectors, new FakeEmbedder(), 0.3, () => clock);
});

function remember(
  content: string,
  extra: Partial<{
    memoryType: "project" | "pattern" | "reference" | "conversation";
    category: string;
    tags: string[];
    scope: "project" | "conversation";
    conversation: string;
  }> = {},
) {
  return service.remember("alpha", {
    content,
    memoryType: extra.memoryType ?? "project",
    category: extra.category,
    tags: extra.tags ?? [],
    ...(extra.scope ? { scope: extra.scope } : {}),
    ...(extra.conversation ? { conversation: extra.conversation } : {}),
  });
}

describe("conversation scope", () => {
  const THREAD = "slack:C1:1723.45";
  const OTHER = "slack:C1:9999.99";

  it("keeps a conversation's own note out of every other conversation's recall", async () => {
    await remember("Keep answers short in this thread", { scope: "conversation", conversation: THREAD });
    clock += 1000;
    await remember("The deploy pipeline pushes to ECR then dispatches to ArgoCD", { conversation: THREAD });

    const own = await service.recall("alpha", { query: "keep answers short in this thread", conversation: THREAD });
    assert.match(own, /Keep answers short/);
    assert.match(own, /this conversation only/);

    const other = await service.recall("alpha", { query: "keep answers short in this thread", conversation: OTHER });
    assert.doesNotMatch(other, /Keep answers short/);
    const none = await service.recall("alpha", { query: "keep answers short in this thread" });
    assert.doesNotMatch(none, /Keep answers short/);

    // The project memory written from the thread is everyone's — provenance
    // is recorded, visibility is not narrowed.
    const shared = await service.recall("alpha", { query: "deploy pipeline pushes to ECR", conversation: OTHER });
    assert.match(shared, /deploy pipeline pushes to ECR/);
    assert.doesNotMatch(shared, /this conversation only/);
  });

  it("lists a thread its own notes and the project's, never another thread's", async () => {
    await remember("Note for thread one", { scope: "conversation", conversation: THREAD });
    clock += 1000;
    await remember("Note for thread two", { scope: "conversation", conversation: OTHER });
    clock += 1000;
    await remember("Everyone's fact", {});

    const one = await service.list("alpha", { limit: 20, conversation: THREAD });
    assert.match(one, /Note for thread one/);
    assert.match(one, /Everyone's fact/);
    assert.doesNotMatch(one, /Note for thread two/);

    const bare = await service.list("alpha", { limit: 20 });
    assert.match(bare, /Everyone's fact/);
    assert.doesNotMatch(bare, /Note for thread/);
    assert.match(bare, /1 memory, newest first/, "and counts what it actually shows");
  });

  it("counts a thread its own notes and the project's, never another thread's", async () => {
    // The same rule `recall` and `list_memories` answer by. A total that
    // included another thread's notes is a number about memories the caller
    // has no way to see, and cannot be reconciled with the listing beside it.
    await remember("Note for thread one", { scope: "conversation", conversation: THREAD });
    clock += 1000;
    await remember("Note for thread two", { scope: "conversation", conversation: OTHER });
    clock += 1000;
    await remember("Everyone's fact", {});

    assert.match(await service.stats("alpha", { conversation: THREAD }), /2 memories/);
    assert.match(await service.stats("alpha", { conversation: OTHER }), /2 memories/);
    assert.match(await service.stats("alpha", {}), /1 memory for this project/);
  });

  it("fills a listing past another thread's notes rather than returning fewer than asked", async () => {
    // Twenty-five of someone else's notes sit newest on the index; a listing of
    // ten for a third party still finds its ten project memories behind them.
    // Distinct sentences, or dedup merges them: the fake embedder scores by words.
    const facts = [
      "Deploys go through ArgoCD",
      "Readiness probes answer during drain",
      "Images push to ECR on a tag",
      "Postgres holds the ledger",
      "Grafana dashboards live in the addons repo",
      "Secrets come from SSM parameters",
      "The scheduler ticks once a minute",
      "Traces keep bounded metadata",
      "Usage rows expire after a year",
      "Slack bots are per project",
    ];
    for (const fact of facts) {
      await remember(fact, {});
      clock += 1000;
    }
    const notes = [
      "cats", "dogs", "birds", "fish", "trees", "rivers", "stones", "clouds", "winds", "hills",
      "roads", "boats", "trains", "planes", "bikes", "books", "songs", "films", "games", "maps",
      "keys", "locks", "doors", "walls", "roofs",
    ];
    for (const note of notes) {
      await remember(`This thread likes ${note}`, { scope: "conversation", conversation: OTHER });
      clock += 1000;
    }

    const listing = await service.list("alpha", { limit: 10, conversation: THREAD });
    assert.match(listing, /10 memories/);
    assert.doesNotMatch(listing, /This thread likes/);
  });

  it("does not let one thread's note stop another thread from writing the same fact", async () => {
    await remember("Prefer bullet points", { scope: "conversation", conversation: THREAD });
    clock += 1000;
    const second = await remember("Prefer bullet points", { scope: "conversation", conversation: OTHER });
    assert.match(second, /Stored as/);
    assert.equal(vectors.size, 2);

    // Within one thread the same note is still merged.
    clock += 1000;
    assert.match(await remember("Prefer bullet points", { scope: "conversation", conversation: THREAD }), /Already known/);
    // And "already known" never points at a memory the caller cannot see.
    clock += 1000;
    const stored = await remember("Prefer bullet points", {});
    assert.match(stored, /Stored as/);
  });

  it("forgets a conversation memory by id like any other", async () => {
    const result = await remember("Temporary note", { scope: "conversation", conversation: THREAD });
    const id = /Stored as ([0-9A-Z]{26})/.exec(result)![1]!;
    assert.match(await service.forget("alpha", id), /Deleted/);
    assert.equal(vectors.size, 0);
  });
});

describe("remember", () => {
  it("stores a memory and reports the id it can be forgotten by", async () => {
    const result = await remember("The deploy pipeline pushes to ECR then dispatches to ArgoCD");
    assert.match(result, /Stored as [0-9A-HJKMNP-TV-Z]{26}/);
    assert.equal(vectors.size, 1);
  });

  it("declines to write a second copy of the same fact", async () => {
    await remember("The deploy pipeline pushes to ECR then dispatches to ArgoCD");
    const second = await remember("The deploy pipeline pushes to ECR then dispatches to ArgoCD");

    assert.match(second, /Already known/);
    assert.match(second, /nothing new was written/);
    assert.equal(vectors.size, 1, "a near-duplicate must not accumulate");
    // The number that decided this is a cosine, and a cosine is the embedding
    // model's property rather than the memory's.
    assert.doesNotMatch(second, /\d+%/, "a raw cosine must not reach the model");
  });

  it("still stores a genuinely different fact", async () => {
    await remember("The deploy pipeline pushes to ECR then dispatches to ArgoCD");
    await remember("Readiness probes point at slash health on port three thousand");
    assert.equal(vectors.size, 2);
  });

  it("finds the nearest neighbour rather than taking whichever came back first", async () => {
    // `MemoryStore.query` promises the nearest neighbours and no order at all,
    // and dedup is the one caller whose wrong pick is silent: it compares
    // against a hit that is not the closest, sees nothing near enough, and
    // writes a second copy of a fact already stored. Several unrelated
    // memories first, so the duplicate is not the only thing to find.
    await remember("Readiness probes point at slash health on port three thousand");
    await remember("Nightly backups land in the archive bucket every Sunday");
    await remember("The deploy pipeline pushes to ECR then dispatches to ArgoCD");

    const again = await remember("The deploy pipeline pushes to ECR then dispatches to ArgoCD");

    assert.match(again, /Already known/);
    assert.equal(vectors.size, 3, "a near-duplicate must not accumulate");
  });

});

describe("dedup does not act on the cosine alone", () => {
  /**
   * A model with no discrimination at all: every text lands on the same vector,
   * so every pair scores 1.0. Stands in for one whose similarities are
   * compressed into a narrow band — the case a threshold calibrated on Titan
   * cannot see coming, and the one where declining to write loses a fact.
   */
  const collapsing: Embedder = {
    embed: async () => [1, ...new Array<number>(63).fill(0)],
  };

  const collapsed = () =>
    new MemoryManager(vectors, collapsing, 0.3, () => clock);

  const store = (content: string) =>
    collapsed().remember("alpha", { content, memoryType: "project", tags: [] });

  it("still writes a distinct fact when the model calls everything identical", async () => {
    await store("The deploy pipeline pushes to ECR then dispatches to ArgoCD");
    clock += 1000;
    const second = await store("Readiness probes answer 503 while a pod drains");

    assert.doesNotMatch(second, /Already known/, "a distinct fact must not be swallowed");
    assert.match(second, /Stored as/);
    assert.equal(vectors.size, 2);
  });

  it("still merges a genuine repeat under that same model", async () => {
    // The guard must narrow dedup, not switch it off.
    const content = "The deploy pipeline pushes to ECR then dispatches to ArgoCD";
    await store(content);
    clock += 1000;

    assert.match(await store(content), /Already known/);
    assert.equal(vectors.size, 1);
  });

  it("reads Korean wording rather than scoring it zero", async () => {
    // An ASCII-only split would empty every Korean text, score every pair at
    // zero overlap, and silently switch dedup off for the content this
    // deployment mostly holds. No Latin or digits in these on purpose: a
    // stray "ECR" or "503" would carry the signal through such a split and
    // leave the bug invisible.
    const content = "배포 파이프라인은 이미지를 밀어 올린 뒤 클러스터에 전달한다";
    await store(content);
    clock += 1000;
    assert.match(await store(content), /Already known/);

    clock += 1000;
    const different = await store("레디니스 프로브는 파드가 종료될 때 오류를 반환한다");
    assert.doesNotMatch(different, /Already known/);
    assert.equal(vectors.size, 2);
  });
});

describe("recall", () => {
  it("finds what was stored", async () => {
    await remember("The deploy pipeline pushes to ECR then dispatches to ArgoCD");
    const result = await service.recall("alpha", {
      query: "deploy pipeline pushes to ECR then dispatches",
    });

    assert.match(result, /deploy pipeline pushes to ECR/);
    assert.match(result, /CONFIDENCE/);
  });

  it("says nothing is stored rather than returning a weak match", async () => {
    await remember("The deploy pipeline pushes to ECR then dispatches to ArgoCD");
    const result = await service.recall("alpha", { query: "quantum chromodynamics lattice gauge" });

    assert.match(result, /NO (MATCH FOUND|CONFIDENT MATCH)/);
    assert.match(result, /do not (infer an answer|present a guess)/i);
  });

  it("answers an empty store without pretending otherwise", async () => {
    const result = await service.recall("alpha", { query: "anything at all" });
    assert.match(result, /No memories stored/);
    assert.match(result, /NO MATCH FOUND/);
  });

  it("never returns another tenant's memories", async () => {
    await service.remember("alpha", {
      content: "Alpha's private deployment secret rotation schedule",
      memoryType: "project",
      tags: [],
    });
    const result = await service.recall("beta", {
      query: "Alpha's private deployment secret rotation schedule",
    });
    assert.match(result, /No memories stored/);
  });

  it("counts a returned memory as used", async () => {
    await remember("The deploy pipeline pushes to ECR then dispatches to ArgoCD");
    await service.recall("alpha", { query: "deploy pipeline pushes to ECR then dispatches" });

    const [memory] = await vectors.list("alpha", { limit: 1 });
    assert.equal(memory ? vectors.statsFor("alpha", memory.id)?.accessCount : undefined, 1);
  });

  it("returns the one clear answer in precision and its neighbours in exploratory", async () => {
    // The gate is a fraction of the best match, so it only has an effect when
    // there is something to compare against — one relevant memory comes back in
    // every mode, and correctly so.
    // The neighbour scores 0.69 against a query that scores 1.0 on the first:
    // over exploratory's 0.35 ratio, under precision's 0.8.
    await remember("Rolling deploys drain in-flight streams before the pod exits");
    clock += 1000;
    await remember("Rolling deploys drain connections before the node exits");
    const query = "Rolling deploys drain in-flight streams before the pod exits";

    const tight = await service.recall("alpha", { query, mode: "precision" });
    const loose = await service.recall("alpha", { query, mode: "exploratory" });

    assert.match(tight, /in-flight streams/);
    assert.doesNotMatch(tight, /the node exits/);
    assert.match(loose, /the node exits/);
  });

  it("does not claim a total it did not count", async () => {
    // `hits.length` is the candidate neighbourhood the query pulled, not the
    // project's memory count. Reporting "1 of 30 memories" told the model the
    // project had 30, which it had no way to check.
    await remember("Ingress terminates TLS at the shared gateway");
    const result = await service.recall("alpha", {
      query: "Ingress terminates TLS at the shared gateway",
    });
    assert.match(result, /1 memory matched/);
    assert.doesNotMatch(result, /\d+ of \d+/);
  });

  it("survives a memory whose timestamp will not parse", async () => {
    // The record has to be close enough to come back, or the similarity floor
    // gates it out and the ranking path this guards is never reached.
    const broken: StoredMemory = {
      id: ulid(START),
      tenantId: "alpha",
      content: "Rolling deploys drain connections before the node exits",
      memoryType: "project",
      tags: [],
      createdAt: "not-a-date",
      trustBase: 1,
    };
    await vectors.put(broken, await new FakeEmbedder().embed(broken.content));

    clock += 1000;
    await remember("Rolling deploys drain in-flight streams before the pod exits");

    const result = await service.recall("alpha", {
      query: "Rolling deploys drain in-flight streams before the pod exits",
      mode: "exploratory",
    });

    assert.match(result, /the node exits/, "the broken record must be in the result set");
    // A timestamp that cannot be read is treated as infinitely old, so the
    // record sinks — rather than scoring NaN and taking the sort down with it.
    assert.ok(
      result.indexOf("in-flight streams") < result.indexOf("the node exits"),
      `the better match must lead:\n${result}`,
    );
    assert.doesNotMatch(result, /not-a-date/, "an unreadable date must not reach the model");
  });

  it("shows standing against the top result, never a raw cosine", async () => {
    // A cosine means different things under different embedding models — on
    // Titan a correct answer scores 0.15–0.41, so "30% match" beside "HIGH
    // CONFIDENCE" reads as a contradiction. Only the relative figure is true
    // whatever the model is.
    await remember("Rolling deploys drain in-flight streams before the pod exits");
    clock += 1000;
    await remember("Rolling deploys drain connections before the node exits");

    // Deliberately not the stored wording. An exact query scores 1.0 against
    // the fake embedder, so a raw cosine and a standing would render the top
    // result identically and the test would be blind to the difference. This
    // one puts the best match at 0.94 and its neighbour at 0.59.
    const result = await service.recall("alpha", {
      query: "Rolling deploys drain in-flight streams before the pod",
      mode: "exploratory",
    });

    assert.doesNotMatch(result, /% match/, "a raw cosine must not reach the model");
    const standings = [...result.matchAll(/(\d+)% of the top result/g)].map((m) => Number(m[1]));
    assert.equal(standings.length, 2, `expected a figure per result in:\n${result}`);
    assert.equal(standings[0], 100, "the top result is the reference");
    assert.deepEqual(
      [...standings].sort((a, b) => b - a),
      standings,
      `standing must fall down the displayed order:\n${result}`,
    );
  });

  it("keeps the best match even when it is a weak one", async () => {
    // The floor decides whether anything is relevant; the ratio only decides how
    // many of the relevant ones to show. The top result can never be ratioed out
    // of its own result set.
    await remember("Rolling deploys drain in-flight streams before the pod exits");
    const result = await service.recall("alpha", {
      query: "Rolling deploys drain in-flight streams before the pod exits",
      mode: "precision",
    });
    assert.match(result, /drain in-flight streams/);
  });
});

describe("recall does not assume the store sorts", () => {
  it("gates against the strongest hit, not the first one handed over", async () => {
    // `MemoryStore.query` promises the nearest neighbours, not an order. The
    // PostgreSQL adapter sorts, but the interface does not promise it, so this
    // hands results over backwards. Both hits have to clear the floor for the mistake to be
    // reachable — otherwise the floor removes the weak one first and the top is
    // right by accident.
    const backing = new InMemoryMemoryStore();
    const reversing: MemoryStore = {
      put: (memory, embedding) => backing.put(memory, embedding),
      get: (t, ids) => backing.get(t, ids),
      delete: (t, ids) => backing.delete(t, ids),
      query: async (t, embedding, topK, conversation) =>
        (await backing.query(t, embedding, topK, conversation)).reverse(),
      list: (t, options) => backing.list(t, options),
      touch: (t, ids, at) => backing.touch(t, ids, at),
      count: (t, conversation) => backing.count(t, conversation),
    };
    const shuffled = new MemoryManager(reversing, new FakeEmbedder(), 0.3, () => clock);
    const put = (content: string) =>
      shuffled.remember("alpha", { content, memoryType: "project", tags: [] });

    await put("Rolling deploys drain in-flight streams before the pod exits");
    clock += 1000;
    await put("Rolling deploys drain connections before the node exits");

    // 0.94 and 0.59 against this query. Precision keeps within 0.8 of the top,
    // so the neighbour belongs outside — but only if the top is the 0.94. Taken
    // from the reversed first element it is 0.59, the bar drops to 0.47, and
    // the neighbour comes back as though it were a close match.
    const result = await shuffled.recall("alpha", {
      query: "Rolling deploys drain in-flight streams before the pod",
      mode: "precision",
    });

    assert.match(result, /in-flight streams/);
    assert.doesNotMatch(result, /the node exits/, "a weak neighbour must stay gated out");
  });
});

describe("list", () => {
  it("returns newest first", async () => {
    await remember("First fact about the alpha environment");
    clock += 60_000;
    await remember("Second fact about the beta environment");
    clock += 60_000;
    await remember("Third fact about the gamma environment");

    const result = await service.list("alpha", { limit: 10 });
    const order = ["Third", "Second", "First"].map((word) => result.indexOf(word));
    assert.deepEqual([...order].sort((a, b) => a - b), order, `wrong order in:\n${result}`);
  });

  it("filters to a type", async () => {
    await remember("A project level decision about storage", { memoryType: "project" });
    clock += 1000;
    await remember("A reusable command for rebuilding the index", { memoryType: "pattern" });

    const patterns = await service.list("alpha", { limit: 10, memoryType: "pattern" });
    assert.match(patterns, /reusable command/);
    assert.doesNotMatch(patterns, /project level decision/);
  });

  it("honours the limit", async () => {
    // No shared boilerplate between these: to the fake embedder, five sentences
    // differing only in a number are one memory, and it would dedup them.
    const facts = [
      "Ingress terminates TLS at the shared gateway",
      "Cost dashboards aggregate spend per project daily",
      "Readiness probes answer 503 while a pod drains",
      "Skills sync from a GitHub repository on demand",
      "Subagent nesting stops at a fixed depth",
    ];
    for (const fact of facts) {
      await remember(fact);
      clock += 1000;
    }
    assert.equal(vectors.size, 5, "the fixtures must be distinct enough not to merge");
    assert.match(await service.list("alpha", { limit: 2 }), /2 memories/);
  });

  it("applies the type filter before the listing limit", async () => {
    // The one pattern is older than more rows than the requested limit. A store
    // that limits first and filters in memory would quietly return nothing.
    const seed = async (memoryType: "project" | "pattern", at: number) => {
      const memory: StoredMemory = {
        id: ulid(at),
        tenantId: "alpha",
        content: `seeded ${memoryType} ${at}`,
        memoryType,
        tags: [],
        createdAt: new Date(at).toISOString(),
        trustBase: 1,
      };
      await vectors.put(memory, []);
    };

    // The one pattern is the oldest, so it sorts after every project memory.
    await seed("pattern", START);
    for (let i = 1; i <= 1005; i++) {
      await seed("project", START + i * 1000);
    }

    const result = await service.list("alpha", { limit: 5, memoryType: "pattern" });
    assert.match(result, /seeded pattern/);
  });

  it("says so when there is nothing", async () => {
    assert.match(await service.list("alpha", { limit: 10 }), /no memories/i);
  });

  it("never lists another tenant's memories", async () => {
    await remember("Alpha's own note about its own deployment");
    assert.match(await service.list("beta", { limit: 10 }), /no memories/i);
  });
});

describe("forget", () => {
  it("removes the memory", async () => {
    const stored = await remember("A fact that will shortly turn out to be wrong");
    const id = /id:([0-9A-HJKMNP-TV-Z]{26})/.exec(stored)?.[1];
    assert.ok(id);

    assert.match(await service.forget("alpha", id), /Deleted/);
    assert.equal(vectors.size, 0);
    assert.match(await service.list("alpha", { limit: 10 }), /no memories/i);
  });

  it("reports an unknown id rather than claiming a deletion", async () => {
    const result = await service.forget("alpha", "0000000000000000000000000");
    assert.match(result, /No memory with id/);
    assert.match(result, /Nothing was deleted/);
  });

  it("cannot delete another tenant's memory even given its id", async () => {
    const stored = await remember("Alpha's fact that beta must not be able to remove");
    const id = /id:([0-9A-HJKMNP-TV-Z]{26})/.exec(stored)![1]!;

    assert.match(await service.forget("beta", id), /No memory with id/);
    assert.equal(vectors.size, 1, "alpha's memory must survive beta's attempt");
  });
});

describe("stats", () => {
  it("counts by type", async () => {
    await remember("A project decision about which datastore to use", { memoryType: "project" });
    clock += 1000;
    await remember("Another project decision about the ingress setup", { memoryType: "project" });
    clock += 1000;
    await remember("A command worth reusing when rebuilding vectors", { memoryType: "pattern" });

    const result = await service.stats("alpha");
    assert.match(result, /3 memories/);
    assert.match(result, /project: 2/);
    assert.match(result, /pattern: 1/);
  });

  it("counts only the calling tenant", async () => {
    await remember("Alpha has exactly one memory to its name");
    assert.match(await service.stats("beta"), /no memories/i);
  });

});
