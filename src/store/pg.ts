/** PostgreSQL pool and the schema owned by the memory store. */

import pg from "pg";
import { logError } from "../log.js";
import { PgMemoryStore } from "./pgMemoryStore.js";
import type { MemoryStore } from "./memoryStore.js";

export class SchemaError extends Error {}

const SCHEMA_LOCK_KEY = 7_304_592_118_001;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS memories (
     tenant_id text NOT NULL,
     id text NOT NULL,
     content text NOT NULL,
     memory_type text NOT NULL CHECK (memory_type IN ('project', 'pattern', 'reference', 'conversation')),
     category text,
     tags text[] NOT NULL DEFAULT '{}',
     created_at timestamptz NOT NULL,
     scope text NOT NULL DEFAULT 'project' CHECK (scope IN ('project', 'conversation')),
     conversation text,
     trust_base double precision NOT NULL DEFAULT 1,
     embedding vector NOT NULL,
     access_count bigint NOT NULL DEFAULT 0 CHECK (access_count >= 0),
     last_accessed_at timestamptz,
     PRIMARY KEY (tenant_id, id),
     CHECK (scope = 'project' OR conversation IS NOT NULL)
   )`,
  `CREATE INDEX IF NOT EXISTS memories_recent_idx
     ON memories (tenant_id, created_at DESC, id DESC)`,
  `CREATE INDEX IF NOT EXISTS memories_type_recent_idx
     ON memories (tenant_id, memory_type, created_at DESC, id DESC)`,
];

export interface SchemaPool {
  connect(): Promise<{
    query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
    release(): void;
  }>;
}

/**
 * Create the current schema under one cross-process lock.
 *
 * Version 0.8 stored an S3-shaped JSON document and emulated object keys in a
 * second table. This development-only breaking release intentionally discards
 * that layout instead of carrying a migration or compatibility path.
 */
export async function ensureSchema(pool: SchemaPool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      await client.query("SELECT pg_advisory_xact_lock($1)", [SCHEMA_LOCK_KEY]);
      const { rows: extensions } = await client.query(
        "SELECT 1 FROM pg_extension WHERE extname = 'vector'",
      );
      if (extensions.length === 0) {
        try {
          await client.query("CREATE EXTENSION IF NOT EXISTS vector");
        } catch (error) {
          throw new SchemaError(
            "the pgvector extension is not installed and could not be created — run " +
              "`CREATE EXTENSION vector` on the database as a superuser, or use an image " +
              `that ships it (pgvector/pgvector): ${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }

      const { rows: legacy } = await client.query(
        "SELECT 1 FROM information_schema.columns " +
          "WHERE table_schema = current_schema() AND table_name = 'memories' AND column_name = 'metadata'",
      );
      if (legacy.length > 0) {
        await client.query("DROP TABLE memories");
        await client.query("DROP TABLE IF EXISTS objects");
        await client.query("DROP SEQUENCE IF EXISTS objects_version");
      }

      for (const statement of SCHEMA) {
        await client.query(statement);
      }
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK").catch(() => {});
      throw error;
    }
  } finally {
    client.release();
  }
}

export function reportIdleFailures(pool: {
  on(event: "error", listener: (error: Error) => void): unknown;
}): void {
  pool.on("error", (error) => {
    logError("pg_idle_client_failed", error);
  });
}

export interface PgStore {
  memories: MemoryStore;
  description: string;
  close(): Promise<void>;
}

function redact(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    url.password = "";
    return url.toString();
  } catch {
    return "<database url>";
  }
}

export async function openPgStore(databaseUrl: string): Promise<PgStore> {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  reportIdleFailures(pool);
  try {
    await ensureSchema(pool);
  } catch (error) {
    await pool.end().catch(() => {});
    throw error;
  }
  return {
    memories: new PgMemoryStore(pool),
    description: `store: postgres at ${redact(databaseUrl)}`,
    close: () => pool.end(),
  };
}
