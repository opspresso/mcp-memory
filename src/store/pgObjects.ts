/**
 * The object port over a PostgreSQL table, for a deployment with no S3.
 *
 * One row per key, and the compare-and-swap that `stats.ts` leans on is a row
 * version: `put` with `ifMatch` is an UPDATE that names the version it read,
 * `ifNoneMatch` an INSERT that does nothing on conflict, and either applying to
 * zero rows is the refusal S3 expresses as a 412. The version is what `get`
 * hands back as the ETag, so a caller written against S3 sees the same shape —
 * an opaque string it read, to be presented again on the write.
 *
 * Versions come from one sequence for the whole table rather than from a
 * per-row counter. A row deleted and recreated would otherwise restart at 1,
 * and a stale reader holding "1" from the earlier life would win a
 * compare-and-swap it should have lost.
 *
 * The key column is collated `"C"`. S3 lists keys in byte order, and the
 * recency index in `service.ts` is built on that: its keys carry an inverted
 * timestamp so that ascending order reads newest-first. A locale collation
 * would sort them by its own rules — `en_US` weighs `#` and digits differently
 * from a byte comparison — and `startAfter` would skip or repeat keys at a
 * page boundary.
 */

import { PreconditionFailed, type ObjectStore, type PutOptions, type StoredObject } from "./objects.js";

/**
 * What this store needs from a connection: `pg.Pool` satisfies it, and so does
 * a stub in a test. Declared here rather than imported from `pg` so the port's
 * implementation carries no dependency its tests have to load.
 */
export interface Queryable {
  query(text: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}

export class PgObjectStore implements ObjectStore {
  constructor(private readonly db: Queryable) {}

  async get(key: string): Promise<StoredObject | undefined> {
    const { rows } = await this.db.query(
      "SELECT body, version::text AS etag FROM objects WHERE key = $1",
      [key],
    );
    const row = rows[0];
    if (!row || typeof row.body !== "string" || typeof row.etag !== "string") {
      return undefined;
    }
    return { body: row.body, etag: row.etag };
  }

  async put(key: string, body: string, options: PutOptions = {}): Promise<void> {
    if (options.ifMatch !== undefined) {
      // Compared as text: the ETag is opaque to the caller and may be anything
      // it once read. A value that is not one of ours simply matches no row,
      // which is the right answer — not a parse error.
      const { rowCount } = await this.db.query(
        "UPDATE objects SET body = $2, version = nextval('objects_version'), updated_at = now() " +
          "WHERE key = $1 AND version::text = $3",
        [key, body, options.ifMatch],
      );
      if (rowCount === 0) {
        throw new PreconditionFailed(`conditional write did not apply for ${key}`);
      }
      return;
    }
    if (options.ifNoneMatch) {
      const { rowCount } = await this.db.query(
        "INSERT INTO objects (key, body, version) VALUES ($1, $2, nextval('objects_version')) " +
          "ON CONFLICT (key) DO NOTHING",
        [key, body],
      );
      if (rowCount === 0) {
        throw new PreconditionFailed(`object already exists at ${key}`);
      }
      return;
    }
    await this.db.query(
      "INSERT INTO objects (key, body, version) VALUES ($1, $2, nextval('objects_version')) " +
        "ON CONFLICT (key) DO UPDATE SET body = EXCLUDED.body, " +
        "version = nextval('objects_version'), updated_at = now()",
      [key, body],
    );
  }

  async list(prefix: string, limit = 1000, startAfter?: string): Promise<string[]> {
    // `starts_with` rather than LIKE: a key may carry `_` and `%` — a pod id
    // does — and a prefix match must not read them as wildcards.
    const { rows } = await this.db.query(
      "SELECT key FROM objects WHERE starts_with(key, $1) AND key > $2 ORDER BY key LIMIT $3",
      [prefix, startAfter ?? "", limit],
    );
    return rows.flatMap((row) => (typeof row.key === "string" ? [row.key] : []));
  }

  async delete(keys: string[]): Promise<void> {
    if (keys.length === 0) {
      return;
    }
    await this.db.query("DELETE FROM objects WHERE key = ANY($1::text[])", [keys]);
  }
}
