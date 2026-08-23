/**
 * Which storage a process runs on, decided once from its configuration.
 *
 * The stores are a pair — the vectors and the objects come from the same
 * backend, never one from each — so this is the only place that builds them,
 * and `main.ts` asks for the pair rather than choosing twice.
 *
 * Each path loads only its own driver. The AWS SDKs are imported lazily inside
 * `vectors.ts` and `objects.ts`; `pg` is imported by `pg.ts`, which is reached
 * only through the dynamic import below. A container built for one backend
 * carries both packages, since they are dependencies, but executes neither of
 * the other's — `backend.test.ts` is what keeps a static import from creeping
 * back in.
 */

import type { StorageConfig } from "../config.js";
import { createObjectStore, type ObjectStore } from "./objects.js";
import { createVectorStore, type VectorStore } from "./vectors.js";

export interface Stores {
  vectors: VectorStore;
  objects: ObjectStore;
  /** One line for the boot log, naming where the memories are. */
  description: string;
  /** Release what the backend holds open. S3 holds nothing; PostgreSQL a pool. */
  close(): Promise<void>;
}

export async function openStores(storage: StorageConfig, region: string): Promise<Stores> {
  if (storage.backend === "postgres") {
    const { openPgStores } = await import("./pg.js");
    const stores = await openPgStores(storage.databaseUrl);
    return {
      vectors: stores.vectors,
      objects: stores.objects,
      description: `store: postgres (memories, objects) at ${redact(storage.databaseUrl)}`,
      close: stores.close,
    };
  }
  const [{ store: vectors }, { store: objects }] = await Promise.all([
    createVectorStore(region, storage.vectorBucket, storage.vectorIndex),
    createObjectStore(region, storage.stateBucket),
  ]);
  return {
    vectors,
    objects,
    description:
      `store: s3vectors://${storage.vectorBucket}/${storage.vectorIndex}, ` +
      `state: s3://${storage.stateBucket}`,
    close: async () => {},
  };
}

/** The URL without its password, for a log line. An unparseable one is not printed at all. */
export function redact(databaseUrl: string): string {
  try {
    const url = new URL(databaseUrl);
    url.password = "";
    return url.toString();
  } catch {
    return "<database url>";
  }
}
