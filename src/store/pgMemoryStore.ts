/** PostgreSQL persistence for memories, embeddings, access statistics and listing. */

import { isMemoryScope, isMemoryType, type MemoryStats, type StoredMemory } from "../types.js";
import {
  assertWithinContentBudget,
  type ListMemoriesOptions,
  type MemoryCounts,
  type MemoryHit,
  type MemoryStore,
} from "./memoryStore.js";

export interface Queryable {
  connect(): Promise<{
    query: Queryable["query"];
    release(): void;
  }>;
  query(
    text: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount?: number | null }>;
}

/** pgvector's text form: the numbers in square brackets. */
export function toVectorLiteral(embedding: number[]): string {
  return `[${embedding.join(",")}]`;
}

function timestamp(value: unknown, fallback = ""): string {
  if (value instanceof Date && Number.isFinite(value.getTime())) {
    return value.toISOString();
  }
  return typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : fallback;
}

function number(value: unknown, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function readMemory(row: Record<string, unknown>): StoredMemory | undefined {
  if (
    typeof row.id !== "string" ||
    typeof row.tenant_id !== "string" ||
    typeof row.content !== "string"
  ) {
    return undefined;
  }
  return {
    id: row.id,
    tenantId: row.tenant_id,
    content: row.content,
    memoryType: isMemoryType(row.memory_type) ? row.memory_type : "project",
    ...(typeof row.category === "string" && row.category ? { category: row.category } : {}),
    tags: Array.isArray(row.tags) ? row.tags.filter((tag): tag is string => typeof tag === "string") : [],
    createdAt: timestamp(row.created_at, new Date(0).toISOString()),
    ...(isMemoryScope(row.scope) && row.scope !== "project" ? { scope: row.scope } : {}),
    ...(typeof row.conversation === "string" && row.conversation
      ? { conversation: row.conversation }
      : {}),
    trustBase: number(row.trust_base, 1),
  };
}

function readStats(row: Record<string, unknown>): MemoryStats {
  return {
    accessCount: number(row.access_count, 0),
    lastAccessedAt: timestamp(row.last_accessed_at),
  };
}

/** SQL shared by query, list and count so their visibility rules cannot drift. */
function visibleSql(conversationParameter: number): string {
  return (
    `(scope = 'project' OR (` +
    `scope = 'conversation' AND $${conversationParameter}::text IS NOT NULL ` +
    `AND conversation = $${conversationParameter}))`
  );
}

const COLUMNS =
  "id, tenant_id, content, memory_type, category, tags, created_at, scope, conversation, trust_base";

export class PgMemoryStore implements MemoryStore {
  constructor(private readonly db: Queryable) {}

  async put(memory: StoredMemory, embedding: number[]): Promise<void> {
    assertWithinContentBudget(memory);
    await this.db.query(
      `INSERT INTO memories (` +
        `tenant_id, id, content, memory_type, category, tags, created_at, scope, conversation, ` +
        `trust_base, embedding` +
        `) VALUES ($1, $2, $3, $4, $5, $6::text[], $7::timestamptz, $8, $9, $10, $11::vector)`,
      [
        memory.tenantId,
        memory.id,
        memory.content,
        memory.memoryType,
        memory.category ?? null,
        memory.tags,
        memory.createdAt,
        memory.scope ?? "project",
        memory.conversation ?? null,
        memory.trustBase,
        toVectorLiteral(embedding),
      ],
    );
  }

  async putIfAbsent(memory: StoredMemory, embedding: number[]): Promise<StoredMemory | undefined> {
    assertWithinContentBudget(memory);
    const client = await this.db.connect();
    try {
      await client.query("BEGIN ISOLATION LEVEL READ COMMITTED");
      try {
        // The next statement gets a fresh READ COMMITTED snapshot after the lock.
        // Hash collisions only serialize unrelated writes; equality is checked below.
        await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [
          JSON.stringify([memory.tenantId, memory.scope ?? "project",
            memory.scope === "conversation" ? memory.conversation : null, memory.content]),
        ]);
        const { rows } = await client.query(
          `SELECT ${COLUMNS} FROM memories WHERE tenant_id = $1 AND content = $2 ` +
            `AND scope = $3 AND ($3 = 'project' OR conversation = $4) ` +
            `ORDER BY created_at, id LIMIT 1 FOR UPDATE`,
          [memory.tenantId, memory.content, memory.scope ?? "project", memory.conversation ?? null],
        );
        const existing = rows[0] ? readMemory(rows[0]) : undefined;
        const store = new PgMemoryStore({ connect: () => this.db.connect(), query: client.query.bind(client) });
        if (existing) {
          await store.touch(memory.tenantId, [existing.id], memory.createdAt);
        } else {
          await store.put(memory, embedding);
        }
        await client.query("COMMIT");
        return existing;
      } catch (error) {
        await client.query("ROLLBACK").catch(() => {});
        throw error;
      }
    } finally {
      client.release();
    }
  }

  async query(
    tenantId: string,
    embedding: number[],
    topK: number,
    conversation?: string,
  ): Promise<MemoryHit[]> {
    const { rows } = await this.db.query(
      `SELECT ${COLUMNS}, access_count, last_accessed_at, embedding <=> $2::vector AS distance ` +
        `FROM memories WHERE tenant_id = $1 AND ${visibleSql(3)} ` +
        `ORDER BY embedding <=> $2::vector LIMIT $4`,
      [tenantId, toVectorLiteral(embedding), conversation ?? null, topK],
    );
    const hits: MemoryHit[] = [];
    for (const row of rows) {
      const memory = readMemory(row);
      if (!memory || memory.tenantId !== tenantId) {
        continue;
      }
      const distance = number(row.distance, 1);
      hits.push({ memory, similarity: 1 - distance, stats: readStats(row) });
    }
    return hits;
  }

  async get(tenantId: string, ids: string[]): Promise<StoredMemory[]> {
    if (ids.length === 0) {
      return [];
    }
    const { rows } = await this.db.query(
      `SELECT ${COLUMNS} FROM memories WHERE tenant_id = $1 AND id = ANY($2::text[])`,
      [tenantId, ids],
    );
    return rows.flatMap((row) => {
      const memory = readMemory(row);
      return memory?.tenantId === tenantId ? [memory] : [];
    });
  }

  async list(tenantId: string, options: ListMemoriesOptions): Promise<StoredMemory[]> {
    const { rows } = await this.db.query(
      `SELECT ${COLUMNS} FROM memories WHERE tenant_id = $1 AND ${visibleSql(2)} ` +
        `AND ($3::text IS NULL OR memory_type = $3) ORDER BY created_at DESC, id DESC LIMIT $4`,
      [tenantId, options.conversation ?? null, options.memoryType ?? null, options.limit],
    );
    return rows.flatMap((row) => {
      const memory = readMemory(row);
      return memory?.tenantId === tenantId ? [memory] : [];
    });
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

  async touch(tenantId: string, ids: string[], accessedAt: string): Promise<void> {
    if (ids.length === 0) {
      return;
    }
    await this.db.query(
      `UPDATE memories SET access_count = access_count + 1, ` +
        `last_accessed_at = GREATEST(COALESCE(last_accessed_at, '-infinity'::timestamptz), $3::timestamptz) ` +
        `WHERE tenant_id = $1 AND id = ANY($2::text[])`,
      [tenantId, ids, accessedAt],
    );
  }

  async count(tenantId: string, conversation?: string): Promise<MemoryCounts> {
    const { rows } = await this.db.query(
      `SELECT memory_type, count(*)::int AS count FROM memories ` +
        `WHERE tenant_id = $1 AND ${visibleSql(2)} GROUP BY memory_type`,
      [tenantId, conversation ?? null],
    );
    const counts: MemoryCounts = {};
    for (const row of rows) {
      if (isMemoryType(row.memory_type)) {
        counts[row.memory_type] = number(row.count, 0);
      }
    }
    return counts;
  }
}
