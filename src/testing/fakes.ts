/**
 * In-memory stand-ins for the three things this server cannot run locally.
 *
 * S3 Vectors has no emulator and no local mode, and neither does S3's
 * conditional-write behaviour in any form worth trusting. Without these the
 * layers above the stores would go untested entirely, so the fakes are held to
 * the parts of the contract the code actually leans on — conditional writes
 * that fail the way S3 fails them, listings that come back ascending, and a
 * similarity that responds to what the text says.
 */

import { createHash } from "node:crypto";
import type { Embedder } from "../embeddings.js";
import {
  PreconditionFailed,
  type ObjectStore,
  type PutOptions,
  type StoredObject,
} from "../store/objects.js";
import {
  fromMetadata,
  toMetadata,
  vectorKey,
  VectorStoreError,
  type VectorHit,
  type VectorStore,
} from "../store/vectors.js";
import type { StoredMemory } from "../types.js";

export class InMemoryObjectStore implements ObjectStore {
  private readonly objects = new Map<string, StoredObject>();
  private version = 0;
  /** Every key ever written, in order — lets a test assert what was called. */
  readonly writes: string[] = [];

  async get(key: string): Promise<StoredObject | undefined> {
    return this.objects.get(key);
  }

  async put(key: string, body: string, options: PutOptions = {}): Promise<void> {
    const existing = this.objects.get(key);
    if (options.ifNoneMatch && existing) {
      throw new PreconditionFailed(`object already exists at ${key}`);
    }
    if (options.ifMatch !== undefined && existing?.etag !== options.ifMatch) {
      throw new PreconditionFailed(`etag mismatch at ${key}`);
    }
    this.objects.set(key, { body, etag: `"v${++this.version}"` });
    this.writes.push(key);
  }

  async list(prefix: string, limit = 1000, startAfter?: string): Promise<string[]> {
    return [...this.objects.keys()]
      .filter((key) => key.startsWith(prefix) && (!startAfter || key > startAfter))
      .sort()
      .slice(0, limit);
  }

  async delete(keys: string[]): Promise<void> {
    for (const key of keys) {
      this.objects.delete(key);
    }
  }

  get size(): number {
    return this.objects.size;
  }
}

function dot(a: number[], b: number[]): number {
  let sum = 0;
  for (let i = 0; i < a.length; i++) {
    sum += a[i]! * b[i]!;
  }
  return sum;
}

export class InMemoryVectorStore implements VectorStore {
  private readonly records = new Map<string, { metadata: Record<string, unknown>; embedding: number[] }>();

  async put(memory: StoredMemory, embedding: number[]): Promise<void> {
    const metadata = toMetadata(memory);
    // The service refuses these, and refuses the whole write rather than the
    // one field. Enforced here too because the first version of this fake did
    // not, and a memory saved without tags failed only once it reached AWS.
    for (const [key, value] of Object.entries(metadata)) {
      if (Array.isArray(value) && value.length === 0) {
        throw new VectorStoreError(`empty arrays are not allowed in metadata (key "${key}")`);
      }
    }
    this.records.set(vectorKey(memory.tenantId, memory.id), { metadata, embedding });
  }

  async query(tenantId: string, embedding: number[], topK: number): Promise<VectorHit[]> {
    const hits: VectorHit[] = [];
    for (const [key, record] of this.records) {
      const memory = fromMetadata(key, record.metadata);
      if (!memory || memory.tenantId !== tenantId) {
        continue;
      }
      // Embeddings from the fake embedder are unit vectors, so the dot product
      // is the cosine similarity — the same number the real store derives from
      // the distance it returns.
      hits.push({ memory, similarity: dot(embedding, record.embedding) });
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
      const key = vectorKey(tenantId, id);
      const record = this.records.get(key);
      const memory = record ? fromMetadata(key, record.metadata) : undefined;
      if (memory && memory.tenantId === tenantId) {
        found.push(memory);
      }
    }
    return found;
  }

  async delete(tenantId: string, ids: string[]): Promise<void> {
    for (const id of ids) {
      this.records.delete(vectorKey(tenantId, id));
    }
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
