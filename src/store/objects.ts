/**
 * Ordinary S3, behind the four operations this server actually needs.
 *
 * A port rather than the SDK directly, for one reason: the counter merging in
 * `stats.ts` is the part of this design that replaces DynamoDB's atomic
 * increments, and it has to be tested against concurrency it can control. That
 * needs an in-memory implementation, which needs an interface. The same port is
 * what lets `pgObjects.ts` stand in for S3 on a deployment with no AWS.
 *
 * `put` carries the conditional-write headers because compare-and-swap is what
 * makes the compaction in `stats.ts` safe to run from several pods at once.
 *
 * The SDK is loaded lazily — see `vectors.ts` for why.
 */

import type { S3Client } from "@aws-sdk/client-s3";

type S3Sdk = typeof import("@aws-sdk/client-s3");
let sdk: Promise<S3Sdk> | undefined;
function loadSdk(): Promise<S3Sdk> {
  return (sdk ??= import("@aws-sdk/client-s3"));
}

export interface StoredObject {
  body: string;
  etag: string;
}

export interface PutOptions {
  /** Compare-and-swap: the write applies only if the object still has this ETag. */
  ifMatch?: string;
  /** Create-only: the write applies only if no object exists at the key. */
  ifNoneMatch?: boolean;
}

/** Thrown when a conditional `put` did not apply. The caller decides whether to retry. */
export class PreconditionFailed extends Error {}

export interface ObjectStore {
  get(key: string): Promise<StoredObject | undefined>;
  put(key: string, body: string, options?: PutOptions): Promise<void>;
  /** Keys under `prefix`, ascending — the only ordering S3 offers. */
  list(prefix: string, limit?: number, startAfter?: string): Promise<string[]>;
  delete(keys: string[]): Promise<void>;
}

function isStatus(error: unknown, ...codes: number[]): boolean {
  const status = (error as { $metadata?: { httpStatusCode?: number } })?.$metadata?.httpStatusCode;
  return status !== undefined && codes.includes(status);
}

export class S3ObjectStore implements ObjectStore {
  constructor(
    private readonly client: S3Client,
    private readonly bucket: string,
  ) {}

  async get(key: string): Promise<StoredObject | undefined> {
    const { GetObjectCommand } = await loadSdk();
    try {
      const response = await this.client.send(
        new GetObjectCommand({ Bucket: this.bucket, Key: key }),
      );
      const body = await response.Body?.transformToString("utf8");
      if (body === undefined || !response.ETag) {
        return undefined;
      }
      return { body, etag: response.ETag };
    } catch (error) {
      if (isStatus(error, 404)) {
        return undefined;
      }
      throw error;
    }
  }

  async put(key: string, body: string, options: PutOptions = {}): Promise<void> {
    const { PutObjectCommand } = await loadSdk();
    try {
      await this.client.send(
        new PutObjectCommand({
          Bucket: this.bucket,
          Key: key,
          Body: body,
          ContentType: "application/json",
          ...(options.ifMatch ? { IfMatch: options.ifMatch } : {}),
          ...(options.ifNoneMatch ? { IfNoneMatch: "*" } : {}),
        }),
      );
    } catch (error) {
      // 412 is the condition failing. 409 is S3 reporting a concurrent update
      // to the same key, which for a caller doing compare-and-swap means the
      // same thing: someone else got there, re-read and decide again.
      if (isStatus(error, 412, 409)) {
        throw new PreconditionFailed(`conditional write did not apply for ${key}`);
      }
      throw error;
    }
  }

  async list(prefix: string, limit = 1000, startAfter?: string): Promise<string[]> {
    const { ListObjectsV2Command } = await loadSdk();
    const keys: string[] = [];
    let token: string | undefined;
    do {
      const response = await this.client.send(
        new ListObjectsV2Command({
          Bucket: this.bucket,
          Prefix: prefix,
          MaxKeys: Math.min(1000, limit - keys.length),
          ...(startAfter ? { StartAfter: startAfter } : {}),
          ...(token ? { ContinuationToken: token } : {}),
        }),
      );
      for (const item of response.Contents ?? []) {
        if (item.Key) {
          keys.push(item.Key);
        }
      }
      token = response.IsTruncated ? response.NextContinuationToken : undefined;
    } while (token && keys.length < limit);
    return keys.slice(0, limit);
  }

  async delete(keys: string[]): Promise<void> {
    if (keys.length === 0) {
      return;
    }
    const { DeleteObjectsCommand } = await loadSdk();
    // DeleteObjects takes at most 1000 keys per call.
    for (let i = 0; i < keys.length; i += 1000) {
      const response = await this.client.send(
        new DeleteObjectsCommand({
          Bucket: this.bucket,
          Delete: { Objects: keys.slice(i, i + 1000).map((Key) => ({ Key })), Quiet: true },
        }),
      );
      // A per-key failure does not fail the request. `DeleteObjects` answers
      // 200 and names the keys it could not remove, so a caller that only
      // awaited the call was told the deletion succeeded whatever happened —
      // and the callers here treat this as best-effort cleanup, meaning the
      // one signal that it is not working was the one being discarded.
      const failures = response.Errors ?? [];
      if (failures.length > 0) {
        const first = failures[0];
        throw new Error(
          `DeleteObjects could not remove ${failures.length} of ` +
            `${Math.min(1000, keys.length - i)} keys: ${first?.Key} — ${first?.Code}`,
        );
      }
    }
  }
}

export async function createObjectStore(
  region: string,
  bucket: string,
): Promise<{ store: ObjectStore; client: S3Client }> {
  const { S3Client } = await loadSdk();
  const client = new S3Client({ region });
  return { store: new S3ObjectStore(client, bucket), client };
}
