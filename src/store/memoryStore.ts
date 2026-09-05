/**
 * The persistence interface for memories and their pgvector embeddings.
 *
 * PostgreSQL is the only production adapter. The interface remains useful as
 * the test seam: application tests exercise the same operations through an
 * in-memory adapter without knowing SQL or opening a database.
 */

import type { MemoryStats, MemoryType, StoredMemory } from "../types.js";

/** A memory body is a fact, not a document. Measured in bytes for UTF-8 input. */
export const MAX_CONTENT_BYTES = 32_000;

export class MemoryStoreError extends Error {}

export interface MemoryHit {
  memory: StoredMemory;
  /** Cosine similarity in -1..1, converted from pgvector's cosine distance. */
  similarity: number;
  stats: MemoryStats;
}

export interface ListMemoriesOptions {
  memoryType?: MemoryType;
  conversation?: string;
  limit: number;
}

export type MemoryCounts = Partial<Record<MemoryType, number>>;

export interface MemoryStore {
  put(memory: StoredMemory, embedding: number[]): Promise<void>;
  /** Nearest visible neighbours within one tenant. No result ordering is promised. */
  query(
    tenantId: string,
    embedding: number[],
    topK: number,
    conversation?: string,
  ): Promise<MemoryHit[]>;
  /** Fetch by id. Missing ids are dropped rather than erroring. */
  get(tenantId: string, ids: string[]): Promise<StoredMemory[]>;
  /** List visible memories newest first. */
  list(tenantId: string, options: ListMemoriesOptions): Promise<StoredMemory[]>;
  delete(tenantId: string, ids: string[]): Promise<void>;
  /** Atomically record one access for every id that still belongs to the tenant. */
  touch(tenantId: string, ids: string[], accessedAt: string): Promise<void>;
  /** Exact counts for the same visible set recall and list expose. */
  count(tenantId: string, conversation?: string): Promise<MemoryCounts>;
}

export function assertWithinContentBudget(memory: StoredMemory): void {
  const contentBytes = Buffer.byteLength(memory.content, "utf8");
  if (contentBytes > MAX_CONTENT_BYTES) {
    throw new MemoryStoreError(
      `content is ${contentBytes} bytes; the maximum a single memory may hold is ` +
        `${MAX_CONTENT_BYTES}. Store the essential fact rather than the whole document.`,
    );
  }
}
