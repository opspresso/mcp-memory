/**
 * The domain, such as it is: a memory, and the things that rank one above
 * another.
 *
 * A `StoredMemory` is immutable after insertion. PostgreSQL updates only its
 * access statistics as a memory is recalled.
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

/** The visibility rule shared by recall, dedup, listing and statistics. */
export function visibleTo(
  memory: Pick<StoredMemory, "scope" | "conversation">,
  conversation: string | undefined,
): boolean {
  return memory.scope !== "conversation" || (!!conversation && memory.conversation === conversation);
}

/** The immutable fields stored beside the pgvector embedding. */
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

/** The mutable access fields PostgreSQL increments atomically. */
export interface MemoryStats {
  accessCount: number;
  /** ISO 8601 timestamp of the newest observation. */
  lastAccessedAt: string;
}

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
