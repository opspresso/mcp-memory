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

export const EMPTY_STATS: MemoryStats = { accessCount: 0, lastAccessedAt: "" };

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
