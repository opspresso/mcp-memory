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
 * A port with three implementations: this one, `pgVectors.ts` over pgvector,
 * and the fake in `src/testing/`. S3 Vectors has no local emulator, so the
 * fake is the only way the layers above it get tested without a database; it
 * is there rather than beside a test file because the service tests need it
 * too. The port, the metadata shape and the budget live here because the other
 * two implement the same record — `fromMetadata` is what makes a memory read
 * back the same whichever store holds it.
 *
 * The SDK is loaded lazily, as `embeddings.ts` and `docs.ts` load theirs: a
 * PostgreSQL deployment imports this module for the port and must not pay for
 * an AWS client it will never construct.
 */

import type { S3VectorsClient } from "@aws-sdk/client-s3vectors";
import type { StoredMemory } from "../types.js";
import { isMemoryScope, isMemoryType } from "../types.js";

type S3VectorsSdk = typeof import("@aws-sdk/client-s3vectors");
let sdk: Promise<S3VectorsSdk> | undefined;
function loadSdk(): Promise<S3VectorsSdk> {
  return (sdk ??= import("@aws-sdk/client-s3vectors"));
}

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
  /**
   * Nearest neighbours within one tenant, already converted to similarity.
   *
   * Returns at most one page, however large `topK` is — see
   * `MAX_RESULTS_PER_PAGE`. No ordering is promised; callers that need the
   * best hit must find it rather than take the first.
   */
  query(tenantId: string, embedding: number[], topK: number): Promise<VectorHit[]>;
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

/**
 * The service's own quotas, in bytes.
 *
 * AWS documents these as "40 KB" and "2 KB" without saying whether the K is
 * 1000 or 1024. Taken as 1000, because being wrong in that direction refuses a
 * memory the service would have accepted, and being wrong in the other lets
 * through the rejection this check exists to pre-empt.
 */
const MAX_METADATA_BYTES = 40_000;
/** The filterable half's own, much smaller ceiling. `category` is what can fill it. */
const MAX_FILTERABLE_BYTES = 2_000;
/**
 * Results one `QueryVectors` response can carry, whatever `topK` asked for.
 *
 * The rest come back behind a `nextToken` this store does not follow, so a
 * `topK` above it would not raise an error — it would quietly return a prefix.
 * Clamped rather than documented, so the truncation cannot be reintroduced by
 * raising a constant somewhere else.
 */
const MAX_RESULTS_PER_PAGE = 100;

/**
 * Refuse a memory the service would refuse, and say which part is too big.
 *
 * Measured against the serialised metadata rather than against `content`
 * alone, because content is not the only thing a *model* chose. `category`
 * lands in the filterable half and can exhaust its 2 KB by itself; twenty tags
 * land beside a 32 KB body and can carry the pair past 40 KB. Checking only the
 * body left both of those to come back from AWS as a rejection naming neither
 * the field nor the limit.
 */
export function assertWithinMetadataBudget(memory: StoredMemory): void {
  const contentBytes = Buffer.byteLength(memory.content, "utf8");
  if (contentBytes > MAX_CONTENT_BYTES) {
    throw new VectorStoreError(
      `content is ${contentBytes} bytes; the maximum a single memory may hold is ` +
        `${MAX_CONTENT_BYTES}. Store the essential fact rather than the whole document.`,
    );
  }

  const metadata = toMetadata(memory);
  const nonFilterable = new Set<string>(NON_FILTERABLE_KEYS);
  const filterable: Record<string, MetadataValue> = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (!nonFilterable.has(key)) {
      filterable[key] = value;
    }
  }

  const filterableBytes = Buffer.byteLength(JSON.stringify(filterable), "utf8");
  if (filterableBytes > MAX_FILTERABLE_BYTES) {
    throw new VectorStoreError(
      `the filterable metadata is ${filterableBytes} bytes against a ${MAX_FILTERABLE_BYTES} ` +
        "byte limit. Shorten the category — it is a label, not a description.",
    );
  }

  const totalBytes = Buffer.byteLength(JSON.stringify(metadata), "utf8");
  if (totalBytes > MAX_METADATA_BYTES) {
    throw new VectorStoreError(
      `the memory and its labels are ${totalBytes} bytes against a ${MAX_METADATA_BYTES} byte ` +
        "limit. Shorten the tags, or store a shorter fact.",
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
    // Absent for `project`, so a memory written before scopes existed and one
    // written after read the same. `conversation` is at most 512 ASCII bytes
    // and shares the 2 KB filterable half — the budget check below counts it.
    ...(memory.scope === "conversation" ? { scope: memory.scope } : {}),
    ...(memory.conversation ? { conversation: memory.conversation } : {}),
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
    ...(isMemoryScope(raw.scope) && raw.scope !== "project" ? { scope: raw.scope } : {}),
    ...(typeof raw.conversation === "string" && raw.conversation
      ? { conversation: raw.conversation }
      : {}),
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
    assertWithinMetadataBudget(memory);
    const { PutVectorsCommand } = await loadSdk();
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

  async query(tenantId: string, embedding: number[], topK: number): Promise<VectorHit[]> {
    const { QueryVectorsCommand } = await loadSdk();
    const response = await this.client.send(
      new QueryVectorsCommand({
        vectorBucketName: this.bucket,
        indexName: this.index,
        topK: Math.min(topK, MAX_RESULTS_PER_PAGE),
        queryVector: { float32: embedding },
        // The isolation boundary, and a single key on purpose: a bare value is
        // documented as an implicit `$eq`, which is the one filter shape this
        // server needs and the only one it exercises. Nothing here may widen
        // it, and nothing untested sits on this line.
        filter: { tenantId },
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
    const { GetVectorsCommand } = await loadSdk();
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
    const { DeleteVectorsCommand } = await loadSdk();
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

export async function createVectorStore(
  region: string,
  bucket: string,
  index: string,
): Promise<{ store: VectorStore; client: S3VectorsClient }> {
  const { S3VectorsClient } = await loadSdk();
  const client = new S3VectorsClient({ region });
  return { store: new S3VectorsStore(client, bucket, index), client };
}
