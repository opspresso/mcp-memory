/**
 * The memories themselves, in S3 Vectors.
 *
 * A memory is written once and never updated. That is not a simplification —
 * it is what makes the whole design work without a lock: updating a stored
 * memory would mean rewriting its vector, and two pods rewriting the same
 * vector is a lost update with no way to detect it. Everything that changes as
 * a memory gets used lives in `stats.ts` instead.
 *
 * The body rides in the vector's own metadata, which is why `recall` needs no
 * second lookup: `QueryVectors` returns the text alongside the distance. The
 * budget for that is fixed and small — see `assertWithinMetadataBudget`.
 *
 * A port with two implementations. S3 Vectors has no local emulator, so the
 * fake is the only way the layers above it get tested at all; it is in
 * `src/testing/` rather than beside a test file because the service tests need
 * it too.
 */

import {
  DeleteVectorsCommand,
  GetVectorsCommand,
  PutVectorsCommand,
  QueryVectorsCommand,
  S3VectorsClient,
} from "@aws-sdk/client-s3vectors";
import type { MemoryType, StoredMemory } from "../types.js";
import { isMemoryType } from "../types.js";

/**
 * Total metadata per vector is capped at 40 KB by the service. This is the
 * ceiling for the body alone, leaving room for the other keys and for the JSON
 * framing around all of them.
 *
 * Bytes, not characters, because the limit is bytes and the difference is a
 * factor of three for the Korean this deployment will mostly hold — a
 * character-based check would pass content the service then rejects.
 */
export const MAX_CONTENT_BYTES = 32_000;

/** Keys declared non-filterable when the index was created. Fixed for the index's life. */
export const NON_FILTERABLE_KEYS = ["content", "createdAt", "tags", "trustBase"] as const;

export class VectorStoreError extends Error {}

export interface VectorHit {
  memory: StoredMemory;
  /** Cosine similarity in 0..1, converted from the distance the service returns. */
  similarity: number;
}

export interface VectorStore {
  put(memory: StoredMemory, embedding: number[]): Promise<void>;
  /** Nearest neighbours within one tenant, already converted to similarity. */
  query(
    tenantId: string,
    embedding: number[],
    topK: number,
    memoryType?: MemoryType,
  ): Promise<VectorHit[]>;
  /** Fetch by id, for listing. Missing ids are dropped rather than erroring. */
  get(tenantId: string, ids: string[]): Promise<StoredMemory[]>;
  delete(tenantId: string, ids: string[]): Promise<void>;
}

/**
 * The vector key. Prefixing with the tenant is belt and braces alongside the
 * metadata filter: an id that leaked from one project cannot address another
 * project's memory, because the caller's own tenant is what builds the key.
 */
export function vectorKey(tenantId: string, id: string): string {
  return `${tenantId}#${id}`;
}

export function assertWithinMetadataBudget(content: string): void {
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_CONTENT_BYTES) {
    throw new VectorStoreError(
      `content is ${bytes} bytes; the maximum a single memory may hold is ${MAX_CONTENT_BYTES}. ` +
        "Store the essential fact rather than the whole document.",
    );
  }
}

/**
 * The JSON the service accepts as metadata. Mirrors the SDK's `DocumentType`
 * rather than using `Record<string, unknown>`, which is wider than what a
 * document may hold and does not typecheck against the command input.
 */
type MetadataValue = null | boolean | number | string | MetadataValue[] | { [key: string]: MetadataValue };

/**
 * What goes into the vector's metadata. Split by whether the index can filter on it.
 *
 * Absent keys rather than empty ones: S3 Vectors rejects an empty array outright
 * (`Empty arrays are not allowed in metadata`), and it rejects the *whole write*,
 * not just the field — so a memory saved without tags would fail to store at all.
 * `fromMetadata` fills the gap back in on the way out.
 */
export function toMetadata(memory: StoredMemory): Record<string, MetadataValue> {
  return {
    // Filterable — kept short, because that half has a 2 KB ceiling of its own.
    tenantId: memory.tenantId,
    memoryType: memory.memoryType,
    ...(memory.category ? { category: memory.category } : {}),
    // Non-filterable, declared at index creation.
    content: memory.content,
    createdAt: memory.createdAt,
    ...(memory.tags.length > 0 ? { tags: memory.tags } : {}),
    trustBase: memory.trustBase,
  };
}

/**
 * Rebuild a memory from what came back.
 *
 * Tolerant on purpose: metadata is data this process wrote on an earlier
 * deploy, and a record missing a field it did not used to have should sink in
 * the ranking, not fail the whole query.
 */
/**
 * A timestamp only if it is one.
 *
 * A string that will not parse is no more usable than a missing field, and is
 * worse than one: it survives a type check and becomes NaN in the ranking. See
 * `daysBetween` in `ranking.ts` for what that does to a result set.
 */
function readTimestamp(value: unknown): string | undefined {
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : undefined;
}

export function fromMetadata(key: string, metadata: unknown): StoredMemory | undefined {
  if (!metadata || typeof metadata !== "object") {
    return undefined;
  }
  const raw = metadata as Record<string, unknown>;
  const separator = key.indexOf("#");
  const id = separator < 0 ? key : key.slice(separator + 1);
  const content = raw.content;
  const tenantId = raw.tenantId;
  if (typeof content !== "string" || typeof tenantId !== "string" || !id) {
    return undefined;
  }
  return {
    id,
    tenantId,
    content,
    memoryType: isMemoryType(raw.memoryType) ? raw.memoryType : "project",
    category: typeof raw.category === "string" ? raw.category : undefined,
    tags: Array.isArray(raw.tags) ? raw.tags.filter((t): t is string => typeof t === "string") : [],
    createdAt: readTimestamp(raw.createdAt) ?? new Date(0).toISOString(),
    trustBase: typeof raw.trustBase === "number" ? raw.trustBase : 1,
  };
}

export class S3VectorsStore implements VectorStore {
  constructor(
    private readonly client: S3VectorsClient,
    private readonly bucket: string,
    private readonly index: string,
  ) {}

  async put(memory: StoredMemory, embedding: number[]): Promise<void> {
    assertWithinMetadataBudget(memory.content);
    await this.client.send(
      new PutVectorsCommand({
        vectorBucketName: this.bucket,
        indexName: this.index,
        vectors: [
          {
            key: vectorKey(memory.tenantId, memory.id),
            data: { float32: embedding },
            metadata: toMetadata(memory),
          },
        ],
      }),
    );
  }

  async query(
    tenantId: string,
    embedding: number[],
    topK: number,
    memoryType?: MemoryType,
  ): Promise<VectorHit[]> {
    const response = await this.client.send(
      new QueryVectorsCommand({
        vectorBucketName: this.bucket,
        indexName: this.index,
        topK,
        queryVector: { float32: embedding },
        // The isolation boundary. Every read is filtered by the tenant the
        // request's header named, and nothing else can widen it.
        filter: memoryType ? { tenantId, memoryType } : { tenantId },
        returnMetadata: true,
        returnDistance: true,
      }),
    );
    const hits: VectorHit[] = [];
    for (const vector of response.vectors ?? []) {
      const memory = vector.key ? fromMetadata(vector.key, vector.metadata) : undefined;
      // A record whose tenant does not match the filter should be impossible.
      // Checked anyway: this is the boundary, and a silent mismatch here is the
      // one bug whose blast radius is another project's data.
      if (!memory || memory.tenantId !== tenantId) {
        continue;
      }
      hits.push({ memory, similarity: 1 - (vector.distance ?? 1) });
    }
    return hits;
  }

  async get(tenantId: string, ids: string[]): Promise<StoredMemory[]> {
    if (ids.length === 0) {
      return [];
    }
    const found: StoredMemory[] = [];
    // GetVectors takes at most 100 keys per call.
    for (let i = 0; i < ids.length; i += 100) {
      const response = await this.client.send(
        new GetVectorsCommand({
          vectorBucketName: this.bucket,
          indexName: this.index,
          keys: ids.slice(i, i + 100).map((id) => vectorKey(tenantId, id)),
          returnMetadata: true,
        }),
      );
      for (const vector of response.vectors ?? []) {
        const memory = vector.key ? fromMetadata(vector.key, vector.metadata) : undefined;
        if (memory && memory.tenantId === tenantId) {
          found.push(memory);
        }
      }
    }
    return found;
  }

  async delete(tenantId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    // DeleteVectors takes at most 500 keys per call.
    for (let i = 0; i < ids.length; i += 500) {
      await this.client.send(
        new DeleteVectorsCommand({
          vectorBucketName: this.bucket,
          indexName: this.index,
          keys: ids.slice(i, i + 500).map((id) => vectorKey(tenantId, id)),
        }),
      );
    }
  }
}

export function createVectorStore(
  region: string,
  bucket: string,
  index: string,
): { store: VectorStore; client: S3VectorsClient } {
  const client = new S3VectorsClient({ region });
  return { store: new S3VectorsStore(client, bucket, index), client };
}
