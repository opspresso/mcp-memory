/**
 * The domain, such as it is: a memory, and the things that rank one above
 * another.
 *
 * Split deliberately into what S3 Vectors holds and what ordinary S3 holds.
 * A `StoredMemory` is immutable — it is written once and never updated, because
 * updating it means rewriting a vector. Everything that changes as a memory is
 * used lives in `MemoryStats`, which is accumulated per pod and merged on read.
 * Keeping the two apart is what lets this run on S3 with no locking at all.
 */

export const MEMORY_TYPES = ["project", "pattern", "reference", "conversation"] as const;
export type MemoryType = (typeof MEMORY_TYPES)[number];

export function isMemoryType(value: unknown): value is MemoryType {
  return typeof value === "string" && (MEMORY_TYPES as readonly string[]).includes(value);
}

/**
 * Who a memory is for. `project` (the default, and what every memory written
 * before scopes existed is) is shared by every conversation of the tenant;
 * `conversation` is visible only where the same `X-Conversation-Id` asks —
 * a thread's working notes, a preference stated in one chat.
 *
 * Distinct from `MemoryType`, which says what *kind* of fact a memory is. The
 * `conversation` type predates this and means "something the user said, kept
 * for the project" — a type, not a visibility. The two are orthogonal on
 * purpose: a `pattern` may be thread-local, a `conversation`-typed fact may be
 * project-wide.
 */
export const MEMORY_SCOPES = ["project", "conversation"] as const;
export type MemoryScope = (typeof MEMORY_SCOPES)[number];

export function isMemoryScope(value: unknown): value is MemoryScope {
  return typeof value === "string" && (MEMORY_SCOPES as readonly string[]).includes(value);
}

/** The immutable half: what `PutVectors` wrote, and what `QueryVectors` gives back. */
export interface StoredMemory {
  id: string;
  tenantId: string;
  content: string;
  memoryType: MemoryType;
  category?: string;
  tags: string[];
  createdAt: string;
  /**
   * Who may see it. Absent means `project` — the value every memory had before
   * scopes existed, so nothing stored earlier changes meaning.
   */
  scope?: MemoryScope;
  /**
   * The conversation the request that wrote it was in, when it declared one.
   * Provenance on a project memory; the visibility key on a conversation one.
   */
  conversation?: string;
  /**
   * Trust before decay. Fixed at write time by how the memory was come by, and
   * never rewritten — the decay that makes it fall in the ranking is computed
   * at read time from `createdAt` and the stats.
   */
  trustBase: number;
}

/** The mutable half: counters, merged from per-pod shards at read time. */
export interface MemoryStats {
  accessCount: number;
  /** ISO 8601. Merged as a max, so the newest observation across pods wins. */
  lastAccessedAt: string;
}

/**
 * Shared, and frozen for that reason. `StatsTracker.statsFor` hands this same
 * object back for every memory nobody has touched, so one caller mutating it
 * would rewrite what all the others read.
 */
export const EMPTY_STATS: MemoryStats = Object.freeze({ accessCount: 0, lastAccessedAt: "" });

/** A memory as `recall` ranks and returns it. */
export interface RankedMemory extends StoredMemory {
  similarity: number;
  stats: MemoryStats;
  score: number;
  /** Trust after time decay — what actually fed the score. */
  trust: number;
}

export type RecallMode = "precision" | "balanced" | "exploratory";

export function isRecallMode(value: unknown): value is RecallMode {
  return value === "precision" || value === "balanced" || value === "exploratory";
}
