/**
 * Access counters, without a lock and without a database.
 *
 * This is the piece that replaces DynamoDB's atomic increments, and it is the
 * part of an S3-only design that has to be got right. S3 has no read-modify-
 * write that several pods can share, so nothing here ever modifies a shared
 * object in place. Instead:
 *
 *   - A pod accumulates counts in memory and periodically writes a **delta**
 *     to a key only it will ever write: `shard/<ulid>-<podId>.json`. Shards are
 *     append-only, so two pods flushing at the same instant cannot collide.
 *   - A reader takes `merged.json` plus every shard newer than its watermark
 *     and adds them up. Counts are summed; timestamps take the later of the two.
 *     That is a G-Counter beside a last-write-wins register — both of which
 *     converge no matter what order the parts arrive in.
 *   - When shards pile up, whichever request notices folds them into
 *     `merged.json` with a compare-and-swap and advances the watermark.
 *
 * **The watermark is what makes compaction safe.** It records the newest shard
 * already folded in, so a shard is never counted twice — even if the pod that
 * folded it died before deleting it, and even if two pods compact at once.
 * Deleting absorbed shards is therefore garbage collection, not correctness.
 *
 * What this gives up, deliberately: a pod that dies before its next flush takes
 * up to `flushMs` of counts with it. Counters feed ranking and nothing else, so
 * the cost is that a memory sits a little lower for a while. Paying for exactness
 * here would mean a write to shared storage on every read, which is the thing
 * this design exists to avoid.
 */

import { ulid } from "../id.js";
import { logError } from "../log.js";
import { EMPTY_STATS, type MemoryStats } from "../types.js";
import { PreconditionFailed, type ObjectStore } from "./objects.js";

/** One pod-flush worth of counts. Deltas, not totals — see the module note. */
type Delta = Record<string, { access: number; lastAt: string }>;

interface Merged {
  counts: Delta;
  /** The newest shard filename folded in. Shards at or below this are already counted. */
  watermark: string;
}

const EMPTY_MERGED: Merged = { counts: {}, watermark: "" };

/**
 * Shards fetched at once when merging.
 *
 * Bounded rather than unbounded: compaction normally keeps the count near
 * `compactThreshold`, but a tenant whose compaction has been failing can have
 * a listing's worth of them, and opening a thousand sockets to recover from
 * that is its own outage.
 */
const SHARD_READ_BATCH = 16;

export interface StatsOptions {
  podId: string;
  flushMs: number;
  compactThreshold: number;
  /** How long a merged read is reused before going back to S3. */
  cacheTtlMs?: number;
  now?: () => number;
}

function shardPrefix(tenant: string): string {
  return `stats/${tenant}/shard/`;
}

function mergedKey(tenant: string): string {
  return `stats/${tenant}/merged.json`;
}

/**
 * The part of a shard key the watermark is compared against: the whole
 * filename, `<ulid>-<podId>.json`.
 *
 * The ULID alone would be the obvious choice and is subtly wrong. Two pods
 * flushing in the same millisecond can mint the same ULID timestamp, and a
 * watermark set to it would exclude the other pod's shard with `>` forever —
 * its counts silently dropped. The filename carries the pod id, so no two
 * shards ever compare equal, and it orders by time first because the ULID is
 * the prefix.
 */
function shardOrder(key: string): string {
  return key.slice(key.lastIndexOf("/") + 1);
}

function addInto(target: Delta, source: Delta): void {
  for (const [id, entry] of Object.entries(source)) {
    const existing = target[id];
    if (!existing) {
      target[id] = { access: entry.access, lastAt: entry.lastAt };
      continue;
    }
    existing.access += entry.access;
    // ISO 8601 in UTC compares correctly as a string, which is why it is stored
    // that way rather than as an epoch number.
    if (entry.lastAt > existing.lastAt) {
      existing.lastAt = entry.lastAt;
    }
  }
}

function parseDelta(body: string): Delta {
  return coerceDelta(JSON.parse(body));
}

/** The validation half, taking parsed JSON — `merged.json` already has its counts in hand. */
function coerceDelta(raw: unknown): Delta {
  if (!raw || typeof raw !== "object") {
    return {};
  }
  const out: Delta = {};
  for (const [id, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!value || typeof value !== "object") {
      continue;
    }
    const entry = value as { access?: unknown; lastAt?: unknown };
    // `lastAt` has to parse, not merely be a string: it is fed to `Date.parse`
    // on the recall path, and a NaN from there scrambles the ranking of every
    // memory in the result set, not just this one. See `ranking.ts`.
    if (
      typeof entry.access === "number" &&
      typeof entry.lastAt === "string" &&
      Number.isFinite(Date.parse(entry.lastAt))
    ) {
      out[id] = { access: entry.access, lastAt: entry.lastAt };
    }
  }
  return out;
}

function parseMerged(body: string): Merged {
  const raw: unknown = JSON.parse(body);
  if (!raw || typeof raw !== "object") {
    return { ...EMPTY_MERGED };
  }
  const value = raw as { counts?: unknown; watermark?: unknown };
  return {
    counts: coerceDelta(value.counts),
    watermark: typeof value.watermark === "string" ? value.watermark : "",
  };
}

export class StatsTracker {
  /** Counts observed since this pod's last flush, per tenant. */
  private readonly pending = new Map<string, Delta>();
  private readonly cache = new Map<string, { counts: Delta; at: number }>();
  private timer: NodeJS.Timeout | undefined;
  /**
   * The compaction currently running, if any. Compaction is deliberately off
   * the caller's latency path, which leaves no other way to know when it has
   * finished — tests await this, and so does shutdown.
   */
  private compaction: Promise<void> | undefined;
  private readonly cacheTtlMs: number;
  private readonly now: () => number;

  constructor(
    private readonly store: ObjectStore,
    private readonly options: StatsOptions,
  ) {
    this.cacheTtlMs = options.cacheTtlMs ?? 60_000;
    this.now = options.now ?? Date.now;
  }

  /** Note that a memory was used. In memory only — no I/O on the read path. */
  record(tenant: string, id: string, at: number = this.now()): void {
    let deltas = this.pending.get(tenant);
    if (!deltas) {
      deltas = {};
      this.pending.set(tenant, deltas);
    }
    const iso = new Date(at).toISOString();
    const existing = deltas[id];
    if (existing) {
      existing.access += 1;
      if (iso > existing.lastAt) {
        existing.lastAt = iso;
      }
    } else {
      deltas[id] = { access: 1, lastAt: iso };
    }
  }

  /**
   * Merged counters for a tenant: what is durable, plus what this pod has seen
   * since its last flush. Including the unflushed part is what stops a memory
   * the caller just used from looking untouched for the rest of the interval.
   */
  async load(tenant: string): Promise<Map<string, MemoryStats>> {
    const durable = await this.loadDurable(tenant);
    const combined: Delta = {};
    addInto(combined, durable);
    const pending = this.pending.get(tenant);
    if (pending) {
      addInto(combined, pending);
    }
    const out = new Map<string, MemoryStats>();
    for (const [id, entry] of Object.entries(combined)) {
      out.set(id, { accessCount: entry.access, lastAccessedAt: entry.lastAt });
    }
    return out;
  }

  /** Counters for one memory, or zeroes when it has never been used. */
  static statsFor(all: Map<string, MemoryStats>, id: string): MemoryStats {
    return all.get(id) ?? EMPTY_STATS;
  }

  /** Resolves once any in-flight compaction has settled. */
  async settled(): Promise<void> {
    await this.compaction;
  }

  private async loadDurable(tenant: string): Promise<Delta> {
    const cached = this.cache.get(tenant);
    if (cached && this.now() - cached.at < this.cacheTtlMs) {
      return cached.counts;
    }
    const merged = await this.readMerged(tenant);
    const shardKeys = await this.store.list(shardPrefix(tenant));
    const fresh = shardKeys.filter((key) => shardOrder(key) > merged.value.watermark);

    const counts: Delta = {};
    addInto(counts, merged.value.counts);
    // Fetched in batches rather than one at a time. This runs on the critical
    // path of every recall whose cache has expired, and a shard is a few
    // hundred bytes — so serialising the round trips spent most of a recall's
    // latency waiting, once per shard, for nothing that depended on the last
    // one. Order does not matter here: counts add and timestamps take the
    // later, which is the whole reason this merge converges.
    for (let i = 0; i < fresh.length; i += SHARD_READ_BATCH) {
      const batch = await Promise.all(
        fresh.slice(i, i + SHARD_READ_BATCH).map((key) => this.store.get(key)),
      );
      for (const object of batch) {
        if (object) {
          addInto(counts, parseDelta(object.body));
        }
      }
    }

    this.cache.set(tenant, { counts, at: this.now() });

    if (fresh.length > this.options.compactThreshold) {
      // Best effort, and deliberately not awaited into the caller's latency:
      // whoever loses the compare-and-swap simply did not need to win it.
      this.compaction = this.compact(tenant, merged.etag, counts, fresh)
        .catch((error: unknown) => {
          // Losing the compare-and-swap is not an error and returns normally,
          // so anything arriving here is the store itself failing. Harmless
          // once — shards keep piling up if it is not.
          logError("stats_compaction_failed", error, { tenant });
        })
        .finally(() => {
          this.compaction = undefined;
        });
    }
    return counts;
  }

  private async readMerged(tenant: string): Promise<{ value: Merged; etag: string | undefined }> {
    const object = await this.store.get(mergedKey(tenant));
    if (!object) {
      return { value: { ...EMPTY_MERGED }, etag: undefined };
    }
    try {
      return { value: parseMerged(object.body), etag: object.etag };
    } catch {
      // Unreadable merged state would otherwise wedge a tenant permanently. Its
      // counts are lost; the shards above the (now empty) watermark are not.
      return { value: { ...EMPTY_MERGED }, etag: object.etag };
    }
  }

  private async compact(
    tenant: string,
    etag: string | undefined,
    counts: Delta,
    absorbed: string[],
  ): Promise<void> {
    const watermark = absorbed.map(shardOrder).reduce((a, b) => (b > a ? b : a), "");
    const body = JSON.stringify({ counts, watermark } satisfies Merged);
    try {
      await this.store.put(mergedKey(tenant), body, etag ? { ifMatch: etag } : { ifNoneMatch: true });
    } catch (error) {
      if (error instanceof PreconditionFailed) {
        // Another pod compacted first. Its watermark covers the same shards, so
        // there is nothing left to do and nothing to clean up.
        return;
      }
      throw error;
    }
    // Garbage collection, not correctness: the watermark already excludes these
    // from every future read, so a failure here costs storage and nothing else.
    await this.store.delete(absorbed).catch((error: unknown) => {
      logError("stats_shard_cleanup_failed", error, { tenant });
    });
  }

  /** Write this pod's accumulated deltas as new shards and clear them. */
  async flush(): Promise<void> {
    const tenants = [...this.pending.keys()];
    for (const tenant of tenants) {
      const deltas = this.pending.get(tenant);
      if (!deltas || Object.keys(deltas).length === 0) {
        this.pending.delete(tenant);
        continue;
      }
      // Cleared before the write, not after: a failed flush must not replay the
      // same counts on the next one, and losing a delta is already an accepted
      // outcome of this design.
      this.pending.delete(tenant);
      const key = `${shardPrefix(tenant)}${ulid(this.now())}-${this.options.podId}.json`;
      await this.store.put(key, JSON.stringify(deltas));
    }
  }

  start(): void {
    if (this.timer) {
      return;
    }
    this.timer = setInterval(() => {
      void this.flush().catch((error: unknown) => {
        // The counts in that flush are gone, which the design accepts. What it
        // does not accept is nobody knowing it keeps happening.
        logError("stats_flush_failed", error);
      });
    }, this.options.flushMs);
    // Never hold the process open for a counter flush.
    this.timer.unref?.();
  }

  /** Flush what is pending and stop the timer. Called on SIGTERM. */
  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    await this.flush().catch((error: unknown) => {
      logError("stats_final_flush_failed", error);
    });
  }
}
