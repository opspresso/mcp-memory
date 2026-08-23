/**
 * The memories in PostgreSQL, through pgvector.
 *
 * The same record S3 Vectors holds, held the same way: the vector beside a
 * JSONB copy of exactly the metadata `toMetadata` builds, read back through
 * `fromMetadata`. That is not laziness about a relational schema — it is what
 * keeps a memory meaning the same thing whichever store it came out of, and
 * what keeps the tolerance for records an earlier deploy wrote in one place.
 *
 * Similarity is `1 − (embedding <=> query)`, pgvector's cosine distance turned
 * back into the cosine S3 Vectors reports, so `RECALL_MIN_SIMILARITY` and the
 * dedup threshold in `service.ts` read the same under either backend.
 *
 * The `vector` column is declared without a width, so the width is whatever
 * the embedding model produces and nothing here has to be told it. pgvector
 * will not index a column like that, and none is wanted: the query is a
 * sequential scan over one tenant's rows, which is exact — an approximate
 * index can miss the nearest neighbour, and dedup asks for precisely that
 * one. A project keeps thousands of memories, not millions, and an exact scan
 * of thousands of vectors is milliseconds.
 */

import type { StoredMemory } from "../types.js";
import type { Queryable } from "./pgObjects.js";
import {
  assertWithinMetadataBudget,
  fromMetadata,
  toMetadata,
  vectorKey,
  type VectorHit,
  type VectorStore,
} from "./vectors.js";

/** pgvector's text form: the numbers in square brackets. */
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

export class PgVectorStore implements VectorStore {
  constructor(private readonly db: Queryable) {}

  async put(memory: StoredMemory, embedding: number[]): Promise<void> {
    // The same ceiling as S3 Vectors, on purpose: what a single `remember` may
    // carry is documented once, and a deployment that moved between backends
    // should not find its memories refused on one side of the move.
    assertWithinMetadataBudget(memory);
    await this.db.query(
      "INSERT INTO memories (tenant_id, id, embedding, metadata) VALUES ($1, $2, $3::vector, $4::jsonb) " +
        "ON CONFLICT (tenant_id, id) DO UPDATE SET embedding = EXCLUDED.embedding, metadata = EXCLUDED.metadata",
      [memory.tenantId, memory.id, toVectorLiteral(embedding), JSON.stringify(toMetadata(memory))],
    );
  }

  async query(tenantId: string, embedding: number[], topK: number): Promise<VectorHit[]> {
    // The isolation boundary: the tenant is a WHERE clause on an indexed
    // column, and nothing else in this query may widen it.
    const { rows } = await this.db.query(
      "SELECT id, metadata, embedding <=> $2::vector AS distance FROM memories " +
        "WHERE tenant_id = $1 ORDER BY embedding <=> $2::vector LIMIT $3",
      [tenantId, toVectorLiteral(embedding), topK],
    );
    const hits: VectorHit[] = [];
    for (const row of rows) {
      const memory = this.read(row);
      // Unreachable if the WHERE clause holds. Checked anyway, as the S3 store
      // does: a silent mismatch here is the one bug whose blast radius is
      // another project's data.
      if (!memory || memory.tenantId !== tenantId) {
        continue;
      }
      const distance = Number(row.distance);
      hits.push({ memory, similarity: 1 - (Number.isFinite(distance) ? distance : 1) });
    }
    return hits;
  }

  async get(tenantId: string, ids: string[]): Promise<StoredMemory[]> {
    if (ids.length === 0) {
      return [];
    }
    const { rows } = await this.db.query(
      "SELECT id, metadata FROM memories WHERE tenant_id = $1 AND id = ANY($2::text[])",
      [tenantId, ids],
    );
    const found: StoredMemory[] = [];
    for (const row of rows) {
      const memory = this.read(row);
      if (memory && memory.tenantId === tenantId) {
        found.push(memory);
      }
    }
    return found;
  }

  async delete(tenantId: string, ids: string[]): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    await this.db.query("DELETE FROM memories WHERE tenant_id = $1 AND id = ANY($2::text[])", [
      tenantId,
      ids,
    ]);
  }

  /** A row back into a memory, through the same reader the S3 store uses. */
  private read(row: Record<string, unknown>): StoredMemory | undefined {
    if (typeof row.id !== "string") {
      return undefined;
    }
    // `fromMetadata` takes the tenant from the metadata and the id from the
    // key, so the key is rebuilt the way `vectorKey` would have spelled it.
    const tenantId = (row.metadata as { tenantId?: unknown } | null)?.tenantId;
    return fromMetadata(vectorKey(typeof tenantId === "string" ? tenantId : "", row.id), row.metadata);
  }
}
