/**
 * What the five memory tools actually do, and the only place the stores are combined.
 *
 * The shape of every operation follows from one decision: memories are
 * immutable. Nothing here updates a stored memory. `remember` writes a new one
 * or declines to; `forget` removes one; everything that changes with use is a
 * counter in `stats.ts`. That is what lets several pods serve the same tenant
 * with no coordination between them.
 *
 * Results are returned as text rather than JSON. The consumer is a model, the
 * text is what lands in its context, and prose costs fewer tokens than the same
 * facts wrapped in braces and quotes.
 */

import type { Embedder } from "./embeddings.js";
import { invertedTime, ulid, ulidTime } from "./id.js";
import { logError } from "./log.js";
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
import type { ObjectStore } from "./store/objects.js";
import { StatsTracker } from "./store/stats.js";
import type { VectorStore } from "./store/vectors.js";
import type { MemoryType, RankedMemory, RecallMode, StoredMemory } from "./types.js";
import { MEMORY_TYPES } from "./types.js";

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
/** Candidates pulled per recall before re-ranking. One QueryVectors page. */
const CANDIDATE_CAP = 100;
/** Index keys fetched per listing round trip. S3's own maximum. */
const PAGE_SIZE = 1000;
/**
 * Index keys `memory_stats` will scan before it stops.
 *
 * Counting by type means listing every key, so there has to be a stopping
 * point. Past it the totals are a floor rather than a count, and the answer
 * says so — a truncated number presented as exact is a wrong answer the caller
 * has no way to notice.
 */
export const STATS_SCAN_CAP = 10_000;

export interface RecallRequest {
  query: string;
  limit?: number;
  mode?: RecallMode;
}

export interface RememberRequest {
  content: string;
  memoryType: MemoryType;
  category?: string;
  tags: string[];
}

export interface ListRequest {
  memoryType?: MemoryType;
  limit: number;
}

export interface MemoryService {
  recall(tenant: string, request: RecallRequest): Promise<string>;
  remember(tenant: string, request: RememberRequest): Promise<string>;
  list(tenant: string, request: ListRequest): Promise<string>;
  forget(tenant: string, id: string): Promise<string>;
  stats(tenant: string): Promise<string>;
}

/**
 * The recency index: one empty object per memory, keyed so that S3's ascending
 * listing reads newest-first.
 *
 * It exists because S3 Vectors answers "what is nearest to this vector" and
 * nothing else — there is no way to ask it for the most recent memories, or to
 * count them by type. The key carries everything those two questions need, so
 * both are answered by listing keys without fetching a single body.
 */
function indexKey(tenant: string, memory: Pick<StoredMemory, "id" | "memoryType">): string {
  return `index/${tenant}/${invertedTime(ulidTime(memory.id))}#${memory.id}#${memory.memoryType}`;
}

function parseIndexKey(key: string): { id: string; memoryType: string } | undefined {
  const parts = key.slice(key.lastIndexOf("/") + 1).split("#");
  if (parts.length !== 3 || !parts[1] || !parts[2]) {
    return undefined;
  }
  return { id: parts[1], memoryType: parts[2] };
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
    ...(standing === undefined ? [] : [`${percent(standing)} of the top result`]),
    `stored ${day(memory.createdAt)}`,
  ];
  const tags = memory.tags.length > 0 ? `\n   tags: ${memory.tags.join(", ")}` : "";
  return `${position}. [id:${memory.id}] (${facets.join(", ")})\n   ${memory.content}${tags}`;
}

export class S3MemoryService implements MemoryService {
  constructor(
    private readonly vectors: VectorStore,
    private readonly objects: ObjectStore,
    private readonly stats_: StatsTracker,
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
    const hits = await this.vectors.query(
      tenant,
      embedding,
      Math.min(CANDIDATE_CAP, Math.max(30, limit * 3)),
    );

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

    const counters = await this.stats_.load(tenant);
    const at = this.now();
    const maxAccess = Math.max(
      ...keeping.map((hit) => StatsTracker.statsFor(counters, hit.memory.id).accessCount),
      0,
    );

    const ranked: RankedMemory[] = [];
    for (const hit of keeping) {
      const stats = StatsTracker.statsFor(counters, hit.memory.id);
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

    // In memory only — the counter layer flushes on its own schedule, so
    // nothing here writes to S3 on the read path.
    for (const memory of results) {
      this.stats_.record(tenant, memory.id, at);
    }

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
    const [nearest] = await this.vectors.query(tenant, embedding, 1);
    if (
      nearest &&
      nearest.similarity >= DEDUP_THRESHOLD &&
      wordOverlap(request.content, nearest.memory.content) >= DEDUP_MIN_WORD_OVERLAP
    ) {
      this.stats_.record(tenant, nearest.memory.id, this.now());
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
      trustBase: TRUST_MANUAL,
    };

    await this.vectors.put(memory, embedding);
    // After the vector, never before: an index entry with no memory behind it
    // would show up in listings as a memory that cannot be read. The reverse —
    // a memory missing from the index — still answers every recall, and only
    // costs it a place in `list_memories`.
    await this.objects.put(indexKey(tenant, memory), "");

    return `[MEMORY] Stored as ${memory.id}.\n\n${render(memory, 1)}`;
  }

  async list(tenant: string, request: ListRequest): Promise<string> {
    const entries = await this.recentEntries(tenant, request);

    if (entries.length === 0) {
      const scope = request.memoryType ? ` of type "${request.memoryType}"` : "";
      return `[MEMORY] This project has no memories${scope} yet.`;
    }

    const found = await this.vectors.get(
      tenant,
      entries.map((entry) => entry.id),
    );
    // Restore the newest-first order the keys carried; `get` says nothing about order.
    const byId = new Map(found.map((memory) => [memory.id, memory]));
    const ordered = entries
      .map((entry) => byId.get(entry.id))
      .filter((memory): memory is StoredMemory => memory !== undefined);

    return [
      `[MEMORY] ${ordered.length} memories, newest first.`,
      "",
      ...ordered.map((memory, i) => render(memory, i + 1)),
    ].join("\n");
  }

  /**
   * The newest `limit` index entries, optionally of one type.
   *
   * Keys are ordered newest-first by construction, so the first page is already
   * the answer when nothing is filtered. A type filter is the awkward case: the
   * type sits at the end of the key, so it cannot narrow the prefix, and taking
   * one page and filtering it would quietly return fewer than asked for on a
   * project whose recent memories are mostly of other types. So it pages until
   * it has enough or the prefix runs out.
   */
  private async recentEntries(
    tenant: string,
    request: ListRequest,
  ): Promise<{ id: string; memoryType: string }[]> {
    const prefix = `index/${tenant}/`;
    const found: { id: string; memoryType: string }[] = [];
    let after: string | undefined;
    // Unfiltered, the first `limit` keys are already the answer, so there is no
    // reason to pull a full page and throw most of it away.
    const pageSize = request.memoryType ? PAGE_SIZE : request.limit;

    while (found.length < request.limit) {
      const page = await this.objects.list(prefix, pageSize, after);
      if (page.length === 0) {
        break;
      }
      for (const key of page) {
        const entry = parseIndexKey(key);
        if (entry && (!request.memoryType || entry.memoryType === request.memoryType)) {
          found.push(entry);
          if (found.length === request.limit) {
            break;
          }
        }
      }
      if (page.length < pageSize) {
        break;
      }
      after = page[page.length - 1];
    }
    return found;
  }

  async forget(tenant: string, id: string): Promise<string> {
    const [existing] = await this.vectors.get(tenant, [id]);
    if (!existing) {
      return `[MEMORY] No memory with id ${id} exists for this project. Nothing was deleted.`;
    }
    // The vector first, and the order is not arbitrary. Losing the vector is
    // what makes the memory unreachable, which is what was asked for; the index
    // entry is a listing artefact. Reversed, a failure would leave a memory the
    // caller was told about as deleted still answering every recall.
    await this.vectors.delete(tenant, [id]);
    // So the index entry is garbage collection, not correctness — and a failure
    // here must not be reported as a failed deletion, because the deletion
    // happened. What it leaves behind is a key that resolves to nothing:
    // `list_memories` already drops those, and `memory_stats` counts one too
    // many until someone removes it.
    await this.objects.delete([indexKey(tenant, existing)]).catch((error: unknown) => {
      logError("forget_index_cleanup_failed", error, { tenant, key: indexKey(tenant, existing) });
    });
    // Counters for the deleted id are left behind. They are a few bytes inside
    // an object nothing will ever look up again, and removing them would mean a
    // compare-and-swap on the merged counters for no behavioural gain.
    return `[MEMORY] Deleted ${id}.`;
  }

  async stats(tenant: string): Promise<string> {
    const keys = await this.objects.list(`index/${tenant}/`, STATS_SCAN_CAP);
    const counts = new Map<string, number>();
    for (const key of keys) {
      const entry = parseIndexKey(key);
      if (entry) {
        counts.set(entry.memoryType, (counts.get(entry.memoryType) ?? 0) + 1);
      }
    }
    const total = [...counts.values()].reduce((a, b) => a + b, 0);
    if (total === 0) {
      return "[MEMORY] This project has no memories yet.";
    }
    const breakdown = MEMORY_TYPES.filter((type) => counts.has(type))
      .map((type) => `${type}: ${counts.get(type)}`)
      .join(", ");
    if (keys.length >= STATS_SCAN_CAP) {
      return (
        `[MEMORY] At least ${total} memories for this project (${breakdown}). ` +
        `Counting stopped at ${STATS_SCAN_CAP} keys, so every figure here is a lower bound.`
      );
    }
    return `[MEMORY] ${total} memories for this project (${breakdown}).`;
  }
}
