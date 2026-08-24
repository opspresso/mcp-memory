/**
 * Opening PostgreSQL: the pool, and the schema the two stores expect.
 *
 * The schema is created by the process itself, at boot, rather than by a
 * migration a deployment has to remember to run: an on-premises install gets
 * a database URL and nothing else, and the first pod to start is the one that
 * finds the tables missing. Several may start at once, so the statements run
 * under an advisory lock — `IF NOT EXISTS` alone is not enough, because two
 * sessions can both pass the existence check and one then fails on the
 * unique name the other just claimed.
 *
 * Its own module, and the only one that imports `pg`: `backend.ts` loads it
 * dynamically on the PostgreSQL path, so the S3 path never touches the
 * driver, just as the PostgreSQL path never touches an AWS SDK.
 */

import pg from "pg";
import { logError } from "../log.js";
import { PgObjectStore } from "./pgObjects.js";
import { PgVectorStore } from "./pgVectors.js";
import type { ObjectStore } from "./objects.js";
import type { VectorStore } from "./vectors.js";

export class SchemaError extends Error {}

/**
 * The advisory lock's key. Any fixed number distinct from what else shares the
 * database would do; this one is arbitrary and stable, which is all that
 * matters.
 */
const SCHEMA_LOCK_KEY = 7_304_592_118_001;

/**
 * The schema, as idempotent statements.
 *
 * `memories.embedding` carries no width — see `pgVectors.ts`. `objects.key`
 * is collated `"C"` — see `pgObjects.ts`. `objects_version` is one sequence
 * for every row — see `pgObjects.ts` too. Nothing here is altered on a later
 * boot: a column added later is a new statement in this list, never a change
 * to one that has already run somewhere.
 */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS memories (
     tenant_id text NOT NULL,
     id text NOT NULL,
     embedding vector NOT NULL,
     metadata jsonb NOT NULL,
     PRIMARY KEY (tenant_id, id)
   )`,
  `CREATE SEQUENCE IF NOT EXISTS objects_version`,
  `CREATE TABLE IF NOT EXISTS objects (
     key text COLLATE "C" PRIMARY KEY,
     body text NOT NULL,
     version bigint NOT NULL,
     updated_at timestamptz NOT NULL DEFAULT now()
   )`,
];

/** What `ensureSchema` needs from a pool: one connection it can hold for the duration. */
export interface SchemaPool {
  connect(): Promise<{
    query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
    release(): void;
  }>;
}

/**
 * Create what is missing, once, however many pods boot together.
 *
 * The extension is the one statement that can fail for a reason the operator
 * has to act on: `CREATE EXTENSION` needs a superuser unless the build marks
 * pgvector trusted, and the role a server runs as usually is not one. So it is
 * attempted only when the extension is absent, and a refusal says what to do
 * rather than surfacing as a permissions error on a statement nobody wrote.
 */
export async function ensureSchema(pool: SchemaPool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    try {
      await client.query("SELECT pg_advisory_xact_lock($1)", [SCHEMA_LOCK_KEY]);
      const { rows } = await client.query("SELECT 1 FROM pg_extension WHERE extname = 'vector'");
      if (rows.length === 0) {
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

export interface PgStores {
  vectors: VectorStore;
  objects: ObjectStore;
  /** Drain the pool. Called on shutdown, after the last counter flush. */
  close(): Promise<void>;
}

/**
 * Say when an idle connection dies, rather than letting it end the process.
 *
 * A pool emits `error` for a connection sitting *idle* in it — the database
 * restarting, a proxy reaping the connection, a network blip — and an
 * EventEmitter with no listener for `error` **throws what it was handed**. So
 * the pod that had done nothing wrong exits, on the exact day the database is
 * already having trouble, over a connection nobody was using.
 *
 * There is nothing to do about it beyond saying so: the pool has already
 * discarded that client, and the next `connect` opens a fresh one. Its own
 * exported function so the listener can be proved to be there — the property
 * that matters is not what it logs but that the emit does not throw.
 */
export function reportIdleFailures(pool: {
  on(event: "error", listener: (error: Error) => void): unknown;
}): void {
  pool.on("error", (error) => {
    logError("pg_idle_client_failed", error);
  });
}

export async function openPgStores(databaseUrl: string): Promise<PgStores> {
  const pool = new pg.Pool({ connectionString: databaseUrl });
  reportIdleFailures(pool);
  try {
    await ensureSchema(pool);
  } catch (error) {
    await pool.end().catch(() => {});
    throw error;
  }
  return {
    vectors: new PgVectorStore(pool),
    objects: new PgObjectStore(pool),
    close: () => pool.end(),
  };
}
