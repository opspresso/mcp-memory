/**
 * What makes one memory rank above another.
 *
 * Similarity alone is a poor order. The nearest vector to a query is often a
 * fact that was true a year ago, or one nobody has looked at since it was
 * written, and either will outrank the current answer if distance is the only
 * input. So four signals are combined: how well it matches, how recently it was
 * touched, how often, and how much the passage of time should have eroded
 * confidence in a fact of that kind.
 *
 * Pure by construction, `now` included. Decay is a function of elapsed time, so
 * a hidden clock would make every test either flaky or frozen.
 *
 * Two signals this deliberately does not carry. **Helpfulness** — whether a
 * recalled memory actually got used — would need the client to call back and
 * say so, and Agent Studio has no way to. **Keyword matching**, to catch a
 * query naming something the embedding does not associate, is deliberately
 * outside this memory-only semantic search surface.
 */

import type { MemoryType, RecallMode } from "./types.js";

const DAY_MS = 86_400_000;

/**
 * Per mode: how close to the best match a result has to be to come back at all,
 * how many to return, and how the four signals are weighted against each other.
 *
 * `keepRatio` is a *fraction of the top result's similarity*, not an absolute
 * cosine. That is deliberate and was learned the hard way: absolute thresholds
 * do not transfer between embedding models. Measured on Titan v2 (normalised,
 * 1024d), a correct answer scores 0.15–0.41 and an unrelated one scores under
 * 0.05 — so a threshold tuned for a model whose correct answers sit at 0.8
 * silently returns nothing at all. Ratios survive the swap; absolute numbers do
 * not, and the one absolute number left *in ranking* is isolated in
 * `RECALL_MIN_SIMILARITY`. Dedup keeps one of its own — see `service.ts`.
 */
interface ModeConfig {
  keepRatio: number;
  limit: number;
  similarityWeight: number;
  recencyWeight: number;
  accessWeight: number;
}

const MODES: Record<RecallMode, ModeConfig> = {
  precision: {
    keepRatio: 0.8,
    limit: 3,
    similarityWeight: 0.85,
    recencyWeight: 0.1,
    accessWeight: 0.05,
  },
  balanced: {
    keepRatio: 0.6,
    limit: 5,
    similarityWeight: 0.7,
    recencyWeight: 0.2,
    accessWeight: 0.1,
  },
  exploratory: {
    keepRatio: 0.35,
    limit: 10,
    similarityWeight: 0.5,
    recencyWeight: 0.3,
    accessWeight: 0.2,
  },
};

/** Added on top of the mode's three — the weights need not sum to 1. */
const TRUST_WEIGHT = 0.1;
/** Recency half-life for ranking. Separate from trust's, which varies by type. */
const RECENCY_HALFLIFE_DAYS = 30;
/** A top match this many times the floor is called high confidence. */
const HIGH_CONFIDENCE_MULTIPLE = 3;

/**
 * Trust half-lives, in days, by what kind of thing the memory is.
 *
 * The spread is the point: an architectural decision is still true a season
 * later, a code pattern rots as the code moves under it, and something the user
 * said in one conversation was often only true of that conversation.
 */
const TRUST_HALFLIFE_DAYS: Record<MemoryType, number> = {
  project: 180,
  reference: 120,
  pattern: 60,
  conversation: 30,
};

export function modeConfig(mode: RecallMode = "balanced"): ModeConfig {
  return MODES[mode];
}

/** Trust a memory starts with, by how it was come by. Manual entry is trusted; nothing else is yet. */
export const TRUST_MANUAL = 1.0;

/**
 * Elapsed days — never negative, and never NaN.
 *
 * The NaN case costs more than it looks. A timestamp that will not parse
 * reaches `sort`'s comparator as a NaN score, and a comparator that returns NaN
 * does not merely misplace the one entry: the sort abandons its ordering and
 * the *whole* result set comes back arbitrary. So an unreadable timestamp is
 * treated as infinitely old, which sinks that record and leaves the rest alone.
 */
function daysBetween(now: number, then: number): number {
  const elapsed = now - then;
  if (!Number.isFinite(elapsed)) {
    return Number.MAX_SAFE_INTEGER;
  }
  return Math.max(0, elapsed / DAY_MS);
}

/** 1.0 for something just touched, 0.5 at the half-life, decaying from there. */
export function recencyScore(now: number, lastActivity: number): number {
  return 2 ** (-daysBetween(now, lastActivity) / RECENCY_HALFLIFE_DAYS);
}

/**
 * Trust after decay.
 *
 * Decay runs from the last time the memory was *touched*, not from when it was
 * written — a fact that keeps being retrieved is a fact that keeps being
 * relevant. On top of that, frequent use slows the decay itself (up to 1.5x),
 * so a heavily-used memory sinks more slowly than an untouched neighbour of the
 * same age. The result is capped at the base: use cannot make a memory more
 * trustworthy than it was when written.
 */
export function decayedTrust(
  now: number,
  base: number,
  lastActivity: number,
  memoryType: MemoryType,
  accessCount: number,
): number {
  const halflife = TRUST_HALFLIFE_DAYS[memoryType];
  const decay = 2 ** (-daysBetween(now, lastActivity) / halflife);
  const usageFactor = Math.min(1.5, 1 + 0.1 * Math.log(Math.max(1, accessCount + 1)));
  // Only applied where there is decay to slow; otherwise a fresh memory would
  // be inflated above its own base before anything had happened to it.
  const adjusted = decay < 1 ? decay * usageFactor : decay;
  return base * Math.min(1, adjusted);
}

/** Access count normalised against the busiest memory in this result set. */
export function accessScore(accessCount: number, maxAccess: number): number {
  return maxAccess <= 0 ? 0 : Math.min(1, accessCount / maxAccess);
}

/**
 * Similarity as a fraction of the best match in this result set.
 *
 * The composite has to weigh similarity against recency and access, and those
 * two already run 0..1. Feeding a raw cosine in makes the balance depend on the
 * embedding model: Titan's correct answers cluster in 0.15–0.41, so raw
 * similarity would vary by 0.26 while recency varied by a full 1.0 — and a
 * fresh, weakly-matching memory would outrank an older, better one. Scaling
 * against the top match puts all four on the same footing whatever the model.
 */
export function relativeSimilarity(similarity: number, topSimilarity: number): number {
  return topSimilarity <= 0 ? 0 : Math.min(1, similarity / topSimilarity);
}

/**
 * A result's standing against the best in its own set, 0..1.
 *
 * What `recall` shows the model in place of a cosine. A raw similarity is the
 * one thing in a result that does not survive a model swap — Titan's correct
 * answers sit at 0.15–0.41, so "30% match" printed beside "HIGH CONFIDENCE"
 * reads as a contradiction to the model, and means something else entirely
 * under a model whose correct answers sit at 0.8.
 *
 * Against the *score* rather than the similarity, because ranking is by score:
 * this is the only ratio that cannot contradict the order the model is looking
 * at. A similarity-derived one can, since recency and use are free to reorder
 * two memories whose distances run the other way.
 */
export function relativeStanding(score: number, topScore: number): number {
  return topScore <= 0 ? 0 : Math.min(1, score / topScore);
}

export function compositeScore(
  mode: RecallMode,
  parts: { similarity: number; recency: number; access: number; trust: number },
): number {
  const weights = MODES[mode];
  return (
    parts.similarity * weights.similarityWeight +
    parts.recency * weights.recencyWeight +
    parts.access * weights.accessWeight +
    parts.trust * TRUST_WEIGHT
  );
}

export type Confidence = "high" | "medium" | "low";

/**
 * How much to trust the top match, expressed against the floor rather than
 * against a fixed cosine — so it moves with the model the way the gate does.
 */
export function confidenceOf(topSimilarity: number | undefined, floor: number): Confidence {
  if (topSimilarity === undefined) {
    return "low";
  }
  return topSimilarity >= floor * HIGH_CONFIDENCE_MULTIPLE ? "high" : "medium";
}

/**
 * What the model should do with what it just got.
 *
 * Carried in the response rather than left to the model's judgement because the
 * failure this prevents is specific: a search that returns nothing reads, to a
 * model mid-task, like permission to fill the gap from its own priors. Saying
 * so at the point of the empty result is the only place the instruction lands
 * while it is still relevant.
 */
export function guidanceFor(
  confidence: Confidence,
  resultCount: number,
  gatedCount: number,
  mode: RecallMode,
): string {
  if (resultCount > 0) {
    if (confidence === "high") {
      return "HIGH CONFIDENCE: use these directly — the top result closely matches the query.";
    }
    // `low` cannot arrive here from `recall`: confidence is `low` only when
    // there was no top similarity to judge, and that is the same condition as
    // having no results. If some other caller ever manages it, medium is the
    // right answer anyway — there are results, and hedging is what a caller
    // that cannot vouch for them should be told to do.
    return (
      "MEDIUM CONFIDENCE: these are relevant but check they apply to the current context " +
      "before relying on them."
    );
  }
  if (gatedCount > 0) {
    return (
      `NO CONFIDENT MATCH: ${gatedCount} ${gatedCount === 1 ? "memory was" : "memories were"} ` +
      "found but fell below the similarity threshold. Rephrase the query, or reason from " +
      "first principles and say that you are doing so. Do not present a guess as a " +
      "remembered fact."
    );
  }
  const suggestions = [
    ...(mode === "precision" ? ["try mode 'exploratory' for a looser search"] : []),
    "try rephrasing the query",
    "store the answer with remember once you have it",
  ];
  return (
    "NO MATCH FOUND: nothing is stored on this subject. " +
    `Suggestions: ${suggestions.join("; ")}. ` +
    "Nothing being stored is not evidence about the subject itself — do not infer an answer from it."
  );
}
