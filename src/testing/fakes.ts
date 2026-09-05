/**
 * In-memory adapters for deterministic application tests.
 */

import { createHash } from "node:crypto";
import type { Embedder } from "../embeddings.js";
import {
  assertWithinContentBudget,
  type ListMemoriesOptions,
  type MemoryCounts,
  type MemoryHit,
  type MemoryStore,
} from "../store/memoryStore.js";
import { isMemoryType, visibleTo, type MemoryStats, type StoredMemory } from "../types.js";

function dot(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i]! * b[i]!;
  }
  return sum;
}

export class InMemoryMemoryStore implements MemoryStore {
  private readonly records = new Map<
    string,
    { memory: StoredMemory; embedding: number[]; stats: MemoryStats }
  >();

  async put(memory: StoredMemory, embedding: number[]): Promise<void> {
    assertWithinContentBudget(memory);
    const createdAt = Number.isFinite(Date.parse(memory.createdAt))
      ? memory.createdAt
      : new Date(0).toISOString();
    this.records.set(`${memory.tenantId}#${memory.id}`, {
      memory: { ...memory, createdAt, tags: [...memory.tags] },
      embedding: [...embedding],
      stats: { accessCount: 0, lastAccessedAt: "" },
    });
  }

  async query(
    tenantId: string,
    embedding: number[],
    topK: number,
    conversation?: string,
  ): Promise<MemoryHit[]> {
    const hits: MemoryHit[] = [];
    for (const record of this.records.values()) {
      if (record.memory.tenantId !== tenantId || !visibleTo(record.memory, conversation)) {
        continue;
      }
      // Embeddings from the fake embedder are unit vectors, so the dot product
      // is the cosine similarity — the same number the real store derives from
      // the distance it returns.
      hits.push({
        memory: { ...record.memory, tags: [...record.memory.tags] },
        similarity: dot(embedding, record.embedding),
        stats: { ...record.stats },
      });
    }
    // Sorted to pick the nearest `topK`, then handed back worst-first. The port
    // promises the nearest neighbours and no order at all, and a fake that
    // quietly returned them best-first let a caller take `[0]` and be right by
    // accident — on a store that does not sort, it would not be.
    return hits
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topK)
      .reverse();
  }

  async get(tenantId: string, ids: string[]): Promise<StoredMemory[]> {
    const found: StoredMemory[] = [];
    for (const id of ids) {
      const record = this.records.get(`${tenantId}#${id}`);
      if (record?.memory.tenantId === tenantId) {
        found.push({ ...record.memory, tags: [...record.memory.tags] });
      }
    }
    return found;
  }

  async list(tenantId: string, options: ListMemoriesOptions): Promise<StoredMemory[]> {
    return [...this.records.values()]
      .map((record) => record.memory)
      .filter(
        (memory) =>
          memory.tenantId === tenantId &&
          visibleTo(memory, options.conversation) &&
          (!options.memoryType || memory.memoryType === options.memoryType),
      )
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      .slice(0, options.limit)
      .map((memory) => ({ ...memory, tags: [...memory.tags] }));
  }

  async delete(tenantId: string, ids: string[]): Promise<void> {
    for (const id of ids) {
      this.records.delete(`${tenantId}#${id}`);
    }
  }

  async touch(tenantId: string, ids: string[], accessedAt: string): Promise<void> {
    for (const id of ids) {
      const record = this.records.get(`${tenantId}#${id}`);
      if (record) {
        record.stats = {
          accessCount: record.stats.accessCount + 1,
          lastAccessedAt:
            record.stats.lastAccessedAt > accessedAt ? record.stats.lastAccessedAt : accessedAt,
        };
      }
    }
  }

  async count(tenantId: string, conversation?: string): Promise<MemoryCounts> {
    const counts: MemoryCounts = {};
    for (const { memory } of this.records.values()) {
      if (memory.tenantId === tenantId && visibleTo(memory, conversation) && isMemoryType(memory.memoryType)) {
        counts[memory.memoryType] = (counts[memory.memoryType] ?? 0) + 1;
      }
    }
    return counts;
  }

  statsFor(tenantId: string, id: string): MemoryStats | undefined {
    const stats = this.records.get(`${tenantId}#${id}`)?.stats;
    return stats ? { ...stats } : undefined;
  }

  get size(): number {
    return this.records.size;
  }
}

/**
 * A deterministic embedder whose similarity tracks shared words.
 *
 * Each word gets a fixed pseudo-random vector and a text is the normalised sum
 * of its words'. That is enough for the properties the tests care about —
 * "same sentence is near 1.0", "unrelated sentences are not" — without a
 * network call or a model download, and it gives the same answer on every run.
 *
 * **Its scale is not a real model's, and fixtures have to be written for it.**
 * Similarity here is essentially the fraction of words two texts share, which
 * is far harsher than an embedding model that understands paraphrase. Measured:
 *
 *   9 words of 10 shared → 0.93   (above the 0.92 dedup threshold)
 *   7 words of 10 shared → 0.86
 *   4 words of 10 shared → 0.68
 *   nothing shared, same topic → 0.29
 *   nothing shared at all → ~0
 *
 * So a test that means "these are the same fact" must repeat nearly every word,
 * and a test that means "these are different facts" must not reuse boilerplate
 * across them — five sentences differing only in a number are one memory to
 * this embedder, and correctly so.
 */
export class FakeEmbedder implements Embedder {
  private readonly words = new Map<string, number[]>();

  constructor(private readonly dimension = 64) {}

  private wordVector(word: string): number[] {
    const cached = this.words.get(word);
    if (cached) {
      return cached;
    }
    const vector: number[] = [];
    // Stretch the digest to whatever the dimension is by hashing with a counter.
    for (let block = 0; vector.length < this.dimension; block++) {
      const digest = createHash("sha256").update(`${word}:${block}`).digest();
      for (const byte of digest) {
        if (vector.length >= this.dimension) {
          break;
        }
        vector.push(byte / 255 - 0.5);
      }
    }
    this.words.set(word, vector);
    return vector;
  }

  async embed(text: string): Promise<number[]> {
    const words = text
      .toLowerCase()
      .split(/[^a-z0-9가-힣]+/)
      .filter((word) => word.length >= 2);
    const sum = new Array<number>(this.dimension).fill(0);
    for (const word of words.length > 0 ? words : [" empty"]) {
      const vector = this.wordVector(word);
      for (let i = 0; i < this.dimension; i++) {
        sum[i] = sum[i]! + vector[i]!;
      }
    }
    const norm = Math.sqrt(dot(sum, sum)) || 1;
    return sum.map((value) => value / norm);
  }
}
