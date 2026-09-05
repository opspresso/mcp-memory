/**
 * What the five memory tools actually do.
 *
 * Memories are immutable except for access statistics, which PostgreSQL
 * increments atomically. `remember` writes a new one or declines to and
 * `forget` removes one.
 *
 * Results are returned as text rather than JSON. The consumer is a model, the
 * text is what lands in its context, and prose costs fewer tokens than the same
 * facts wrapped in braces and quotes.
 */

import type { Embedder } from "./embeddings.js";
import { ulid } from "./id.js";
import {
  accessScore,
  compositeScore,
  confidenceOf,
  decayedTrust,
  guidanceFor,
  modeConfig,
  recencyScore,
  relativeSimilarity,
  relativeStanding,
  TRUST_MANUAL,
} from "./ranking.js";
import type { MemoryHit, MemoryStore } from "./store/memoryStore.js";
import type { MemoryScope, MemoryType, RankedMemory, RecallMode, StoredMemory } from "./types.js";
import { MEMORY_TYPES, visibleTo } from "./types.js";

/**
 * Above this cosine, two memories are *candidates* for being the same fact.
 *
 * Not the whole test — see `wordOverlap`. Calibrated on Titan v2, where it sits
 * between the same fact reworded (0.72) and the same fact with a typo (0.99),
 * so only near-verbatim repetition merges.
 */
const DEDUP_THRESHOLD = 0.92;
/**
 * How much of the two texts' wording has to coincide before a high cosine is
 * believed.
 *
 * Deliberately low. Distinct facts overlap near zero and a near-identical pair
 * well above this, so the number only has to land in a wide gap — and landing
 * low costs a duplicate, which is the cheap direction.
 */
const DEDUP_MIN_WORD_OVERLAP = 0.5;
/** Candidates pulled per recall before application ranking. */
const CANDIDATE_CAP = 100;

export interface RecallRequest {
  query: string;
  limit?: number;
  mode?: RecallMode;
  /** The request's conversation, when it declared one — decides which scoped memories it may see. */
  conversation?: string;
}

export interface RememberRequest {
  content: string;
  memoryType: MemoryType;
  category?: string;
  tags: string[];
  /** Defaults to `project`. `conversation` requires {@link RememberRequest.conversation}. */
  scope?: MemoryScope;
  /** Provenance on a project memory; the visibility key on a conversation one. */
  conversation?: string;
}

export interface ListRequest {
  memoryType?: MemoryType;
  limit: number;
  /** See {@link RecallRequest.conversation}. */
  conversation?: string;
}

export interface StatsRequest {
  /** See {@link RecallRequest.conversation}. Counted the same way it is recalled and listed. */
  conversation?: string;
}

export interface MemoryService {
  recall(tenant: string, request: RecallRequest): Promise<string>;
  remember(tenant: string, request: RememberRequest): Promise<string>;
  list(tenant: string, request: ListRequest): Promise<string>;
  forget(tenant: string, id: string): Promise<string>;
  stats(tenant: string, request: StatsRequest): Promise<string>;
}

function percent(value: number): string {
  return `${Math.round(value * 100)}%`;
}

/**
 * Jaccard overlap of two texts' words, 0..1 — a second opinion on the cosine.
 *
 * It exists because the cosine is the *embedding model's* opinion, and
 * `DEDUP_THRESHOLD` is calibrated for one model. On Titan a different fact from
 * the same project scores 0.04–0.19 and cannot reach it; under a model whose
 * similarities are compressed into a narrow band, two unrelated facts can. And
 * declining is silent — the caller is told the fact is already known and it is
 * never written — so that failure must not turn on a number belonging to a
 * component the deployment is free to swap.
 *
 * Word overlap belongs to the texts instead. It cannot make dedup fire where
 * the cosine did not; it can only stop it firing where the words disagree.
 */
function wordOverlap(a: string, b: string): number {
  // Unicode classes rather than an ASCII range: this deployment mostly holds
  // Korean, and a split that dropped it would score every pair at zero.
  const wordsOf = (text: string) =>
    new Set(
      text
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter(Boolean),
    );
  const left = wordsOf(a);
  const right = wordsOf(b);
  if (left.size === 0 || right.size === 0) {
    return 0;
  }
  let shared = 0;
  for (const word of left) {
    if (right.has(word)) {
      shared += 1;
    }
  }
  return shared / (left.size + right.size - shared);
}

function day(iso: string): string {
  return iso.slice(0, 10);
}

/**
 * The closest of a set of hits, or `undefined` when there are none.
 *
 * `MemoryStore.query` returns the nearest neighbours in no promised order, so
 * every caller that needs the best one has to find it. `recall` does the same
 * thing with `Math.max` over the similarities; this is the version that has to
 * carry the hit itself.
 */
function nearestOf(hits: readonly MemoryHit[]): MemoryHit | undefined {
  let best: MemoryHit | undefined;
  for (const hit of hits) {
    if (!best || hit.similarity > best.similarity) {
      best = hit;
    }
  }
  return best;
}

/**
 * One memory as the model sees it.
 *
 * `standing` is a fraction of the top result's score, never a cosine. What a
 * raw similarity means is a property of the embedding model rather than of the
 * memory, so printing one hands the model a number it cannot calibrate — and
 * one that contradicts the confidence line beside it, since on Titan a correct
 * answer scores 0.15–0.41. How far a result sits below the best in its own set
 * is the part that is true whatever the model.
 */
function render(memory: StoredMemory, position: number, standing?: number): string {
  const facets = [
    memory.category ? `${memory.memoryType}/${memory.category}` : memory.memoryType,
    // Said, so the model knows a note is this thread's rather than the
    // project's — it will only ever see its own thread's, but not why.
    ...(memory.scope === "conversation" ? ["this conversation only"] : []),
    ...(standing === undefined ? [] : [`${percent(standing)} of the top result`]),
    `stored ${day(memory.createdAt)}`,
  ];
  const tags = memory.tags.length > 0 ? `\n   tags: ${memory.tags.join(", ")}` : "";
  return `${position}. [id:${memory.id}] (${facets.join(", ")})\n   ${memory.content}${tags}`;
}

export class MemoryManager implements MemoryService {
  constructor(
    private readonly store: MemoryStore,
    private readonly embedder: Embedder,
    /** The absolute relevance floor. Model-specific — see `RECALL_MIN_SIMILARITY`. */
    private readonly minSimilarity: number,
    private readonly now: () => number = Date.now,
  ) {}

  async recall(tenant: string, request: RecallRequest): Promise<string> {
    const mode = request.mode ?? "balanced";
    const config = modeConfig(mode);
    const limit = request.limit ?? config.limit;

    const embedding = await this.embedder.embed(request.query);
    // PostgreSQL applies visibility before LIMIT. This second check keeps the
    // application seam fail-closed if an adapter ever violates that contract.
    const hits = (
      await this.store.query(
        tenant,
        embedding,
        Math.min(CANDIDATE_CAP, Math.max(30, limit * 3)),
        request.conversation,
      )
    ).filter((hit) => visibleTo(hit.memory, request.conversation));

    if (hits.length === 0) {
      return [
        `[MEMORY] No memories stored for this project matched "${request.query}".`,
        guidanceFor("low", 0, 0, mode),
      ].join("\n");
    }

    // Two gates, answering two different questions.
    //
    // The floor is absolute and asks "is anything here relevant at all". It is
    // the one model-specific number in the system, which is why it is
    // configurable and why nothing else is.
    //
    // The ratio is relative to the best match and asks "how many of the
    // relevant ones to show". A query with one clear answer and four vague
    // neighbours should return one result, and that is not something an
    // absolute number can express — the same cosine means different things
    // depending on what else the query turned up.
    const relevant = hits.filter((hit) => hit.similarity >= this.minSimilarity);
    // Math.max rather than `relevant[0]`: the store's contract is that these
    // are the nearest neighbours, not that they arrive sorted. Understating the
    // top does not tighten anything — it loosens everything. The ratio gate
    // below becomes a fraction of a smaller number, so weak neighbours stop
    // being gated out, and `relativeSimilarity` saturates at 1 for every hit at
    // or above it, flattening the signal it exists to carry.
    const topSimilarity = Math.max(...relevant.map((hit) => hit.similarity), 0);
    const keeping = relevant.filter(
      (hit) => hit.similarity >= topSimilarity * config.keepRatio,
    );
    const gated = hits.length - keeping.length;

    const at = this.now();
    const maxAccess = Math.max(...keeping.map((hit) => hit.stats.accessCount), 0);

    const ranked: RankedMemory[] = [];
    for (const hit of keeping) {
      const stats = hit.stats;
      // Decay runs from the last time the memory was touched, falling back to
      // when it was written — a memory nobody has used since is as old as it looks.
      const lastActivity = stats.lastAccessedAt
        ? Date.parse(stats.lastAccessedAt)
        : Date.parse(hit.memory.createdAt);
      const trust = decayedTrust(
        at,
        hit.memory.trustBase,
        lastActivity,
        hit.memory.memoryType,
        stats.accessCount,
      );
      ranked.push({
        ...hit.memory,
        similarity: hit.similarity,
        stats,
        trust,
        score: compositeScore(mode, {
          // Relative, so the weighting against recency and access does not
          // shift when the embedding model does.
          similarity: relativeSimilarity(hit.similarity, topSimilarity),
          recency: recencyScore(at, lastActivity),
          access: accessScore(stats.accessCount, maxAccess),
          trust,
        }),
      });
    }

    ranked.sort((a, b) => b.score - a.score);
    const results = ranked.slice(0, limit);
    const confidence = confidenceOf(results[0]?.similarity, this.minSimilarity);

    await this.store.touch(
      tenant,
      results.map((memory) => memory.id),
      new Date(at).toISOString(),
    );

    if (results.length === 0) {
      return [
        `[MEMORY] Nothing matched "${request.query}" closely enough.`,
        guidanceFor(confidence, 0, gated, mode),
      ].join("\n");
    }

    // No denominator on purpose. `hits.length` is the candidate neighbourhood
    // this query pulled — 30 to 100 — and not how many memories the project
    // has, but "5 of 30 memories" reads as the latter to the model that gets
    // this line in its context, and it has nothing to check it against.
    return [
      `[MEMORY] ${results.length} ${results.length === 1 ? "memory" : "memories"} matched ` +
        `"${request.query}" (mode: ${mode}).`,
      guidanceFor(confidence, results.length, gated, mode),
      "",
      ...results.map((memory, i) =>
        render(memory, i + 1, relativeStanding(memory.score, results[0]!.score)),
      ),
    ].join("\n");
  }

  async remember(tenant: string, request: RememberRequest): Promise<string> {
    const embedding = await this.embedder.embed(request.content);

    // Near-identical content merges rather than accumulating copies. Because a
    // stored memory is never rewritten, "merge" means declining to write and
    // pointing at what is already there — said plainly, so a model that meant
    // to record something new can tell that it did not.
    // Two gates, and the second is not a refinement of the first. The cosine is
    // the embedding model's judgement; the wording is the texts' own. Declining
    // to write loses a fact silently, so it takes both.
    // Nearest *visible* neighbour: a fact one thread keeps to itself must not
    // stop another thread — or the project — from writing the same fact, and
    // "already known" must never point at a memory the caller cannot see. A
    // handful of neighbours rather than one, since the closest may be someone
    // else's.
    //
    // Found rather than taken: `MemoryStore.query` promises the nearest
    // neighbours and says nothing about the order they arrive in, and this is
    // the one place a wrong pick is silent — dedup compares against whichever
    // hit came first, so under a store that does not sort, a near-verbatim
    // repeat lands beside its twin instead of merging.
    const nearest = nearestOf(
      (await this.store.query(tenant, embedding, 5, request.conversation)).filter((hit) =>
        visibleTo(hit.memory, request.conversation),
      ),
    );
    if (
      nearest &&
      nearest.similarity >= DEDUP_THRESHOLD &&
      wordOverlap(request.content, nearest.memory.content) >= DEDUP_MIN_WORD_OVERLAP
    ) {
      await this.store.touch(tenant, [nearest.memory.id], new Date(this.now()).toISOString());
      // No percentage: the number that decided this is a cosine, and what a
      // cosine means belongs to the embedding model rather than to the memory.
      // That it was close enough to count as the same fact is the whole of what
      // the model can act on.
      return (
        `[MEMORY] Already known — an existing memory already says this, so nothing new ` +
        `was written.\n\n${render(nearest.memory, 1)}`
      );
    }

    const at = this.now();
    const memory: StoredMemory = {
      id: ulid(at),
      tenantId: tenant,
      content: request.content,
      memoryType: request.memoryType,
      category: request.category,
      tags: request.tags,
      createdAt: new Date(at).toISOString(),
      ...(request.scope === "conversation" ? { scope: "conversation" as const } : {}),
      // Provenance for a project memory, the visibility key for a conversation
      // one — recorded either way when the request said which conversation.
      ...(request.conversation ? { conversation: request.conversation } : {}),
      trustBase: TRUST_MANUAL,
    };

    await this.store.put(memory, embedding);

    return `[MEMORY] Stored as ${memory.id}.\n\n${render(memory, 1)}`;
  }

  async list(tenant: string, request: ListRequest): Promise<string> {
    const memories = (
      await this.store.list(tenant, {
        memoryType: request.memoryType,
        conversation: request.conversation,
        limit: request.limit,
      })
    ).filter((memory) => visibleTo(memory, request.conversation));

    if (memories.length === 0) {
      const scope = request.memoryType ? ` of type "${request.memoryType}"` : "";
      return `[MEMORY] This project has no memories${scope} yet.`;
    }

    return [
      `[MEMORY] ${memories.length} ${memories.length === 1 ? "memory" : "memories"}, newest first.`,
      "",
      ...memories.map((memory, i) => render(memory, i + 1)),
    ].join("\n");
  }

  async forget(tenant: string, id: string): Promise<string> {
    const [existing] = await this.store.get(tenant, [id]);
    if (!existing) {
      return `[MEMORY] No memory with id ${id} exists for this project. Nothing was deleted.`;
    }
    await this.store.delete(tenant, [id]);
    return `[MEMORY] Deleted ${id}.`;
  }

  async stats(tenant: string, request: StatsRequest = {}): Promise<string> {
    const counts = await this.store.count(tenant, request.conversation);
    const total = Object.values(counts).reduce((sum, count) => sum + (count ?? 0), 0);
    if (total === 0) {
      return "[MEMORY] This project has no memories yet.";
    }
    const breakdown = MEMORY_TYPES.filter((type) => counts[type] !== undefined)
      .map((type) => `${type}: ${counts[type]}`)
      .join(", ");
    const noun = total === 1 ? "memory" : "memories";
    return `[MEMORY] ${total} ${noun} for this project (${breakdown}).`;
  }
}
