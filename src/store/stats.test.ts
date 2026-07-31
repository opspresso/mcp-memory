/**
 * The counter layer is where an S3-only design is most likely to be quietly
 * wrong, so these tests are about convergence rather than about the API: many
 * pods writing at once, a compaction landing in the middle of it, and a second
 * compaction over the same shards. The property under test throughout is that
 * the total is the total — never doubled, never lost to a race.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { InMemoryObjectStore } from "../testing/fakes.js";
import { StatsTracker } from "./stats.js";

const TENANT = "demo";
const START = Date.parse("2026-07-01T00:00:00.000Z");

function tracker(store: InMemoryObjectStore, podId: string, overrides: Partial<{ compactThreshold: number; cacheTtlMs: number; now: () => number }> = {}) {
  return new StatsTracker(store, {
    podId,
    flushMs: 30_000,
    compactThreshold: overrides.compactThreshold ?? 20,
    // Off by default: a cache would make most of these tests assert against a
    // stale copy rather than against what is durable.
    cacheTtlMs: overrides.cacheTtlMs ?? 0,
    now: overrides.now ?? (() => START),
  });
}

async function totalFor(store: InMemoryObjectStore, id: string): Promise<number> {
  const reader = tracker(store, "reader", { compactThreshold: Number.MAX_SAFE_INTEGER });
  const counts = await reader.load(TENANT);
  return counts.get(id)?.accessCount ?? 0;
}

describe("StatsTracker", () => {
  it("counts what a pod recorded but has not yet flushed", async () => {
    const store = new InMemoryObjectStore();
    const pod = tracker(store, "pod-a");
    pod.record(TENANT, "m1");
    pod.record(TENANT, "m1");

    // Nothing is durable yet — but the pod that did the recording must still
    // see it, or a memory the caller just used looks untouched for a whole
    // flush interval.
    assert.equal(store.size, 0);
    assert.equal((await pod.load(TENANT)).get("m1")?.accessCount, 2);
  });

  it("makes counts durable on flush and readable by another pod", async () => {
    const store = new InMemoryObjectStore();
    const writer = tracker(store, "pod-a");
    writer.record(TENANT, "m1");
    await writer.flush();

    assert.equal(await totalFor(store, "m1"), 1);
  });

  it("clears pending on flush so the same counts are not written twice", async () => {
    const store = new InMemoryObjectStore();
    const pod = tracker(store, "pod-a");
    pod.record(TENANT, "m1");
    await pod.flush();
    await pod.flush();

    assert.equal(await totalFor(store, "m1"), 1);
  });

  it("sums shards from concurrent pods rather than letting one overwrite another", async () => {
    const store = new InMemoryObjectStore();
    let clock = START;
    const pods = ["pod-a", "pod-b", "pod-c"].map((id) => tracker(store, id, { now: () => clock }));

    for (const pod of pods) {
      pod.record(TENANT, "m1");
      pod.record(TENANT, "m1");
    }
    // Same instant on purpose: shard keys must not collide even when several
    // pods flush within one millisecond of each other.
    await Promise.all(pods.map((pod) => pod.flush()));
    clock += 1;

    assert.equal(await totalFor(store, "m1"), 6);
  });

  it("takes the later timestamp when pods disagree", async () => {
    const store = new InMemoryObjectStore();
    const early = tracker(store, "pod-a");
    const late = tracker(store, "pod-b");
    early.record(TENANT, "m1", START);
    late.record(TENANT, "m1", START + 60_000);
    await early.flush();
    await late.flush();

    const counts = await tracker(store, "reader").load(TENANT);
    assert.equal(counts.get("m1")?.lastAccessedAt, new Date(START + 60_000).toISOString());
  });

  it("keeps the total intact across compaction", async () => {
    const store = new InMemoryObjectStore();
    let clock = START;
    const pod = tracker(store, "pod-a", { now: () => clock });

    for (let i = 0; i < 5; i++) {
      pod.record(TENANT, "m1");
      await pod.flush();
      clock += 1000;
    }

    const compactor = tracker(store, "compactor", { compactThreshold: 3, now: () => clock });
    assert.equal((await compactor.load(TENANT)).get("m1")?.accessCount, 5);
    await compactor.settled();

    // Folded away, and the total survives being read again from the merged form.
    const remaining = await store.list(`stats/${TENANT}/shard/`);
    assert.equal(remaining.length, 0);
    assert.equal(await totalFor(store, "m1"), 5);
  });

  it("does not double count when compaction runs twice over the same shards", async () => {
    const store = new InMemoryObjectStore();
    let clock = START;
    const pod = tracker(store, "pod-a", { now: () => clock });
    for (let i = 0; i < 4; i++) {
      pod.record(TENANT, "m1");
      await pod.flush();
      clock += 1000;
    }

    // The failure this guards: a compactor that wrote merged.json and then died
    // before deleting the shards it had folded in. The watermark is what makes
    // the next pass skip them, so put the shards back and read again.
    const shards = await store.list(`stats/${TENANT}/shard/`);
    const bodies = await Promise.all(shards.map(async (key) => [key, (await store.get(key))!.body] as const));

    const first = tracker(store, "c1", { compactThreshold: 2, now: () => clock });
    await first.load(TENANT);
    await first.settled();

    for (const [key, body] of bodies) {
      await store.put(key, body);
    }

    assert.equal(await totalFor(store, "m1"), 4);
  });

  it("leaves shards alone when it loses the compare-and-swap", async () => {
    const store = new InMemoryObjectStore();
    let clock = START;
    const pod = tracker(store, "pod-a", { now: () => clock });
    for (let i = 0; i < 4; i++) {
      pod.record(TENANT, "m1");
      await pod.flush();
      clock += 1000;
    }

    const loser = tracker(store, "loser", { compactThreshold: 2, now: () => clock });
    const durable = loser.load(TENANT);
    // Another pod gets there first, changing the ETag the loser is holding.
    await store.put(`stats/${TENANT}/merged.json`, JSON.stringify({ counts: {}, watermark: "" }));
    await durable;
    await loser.settled();

    // The winner's own pass will fold them in; the loser must not have deleted
    // them out from under it.
    const remaining = await store.list(`stats/${TENANT}/shard/`);
    assert.equal(remaining.length, 4);
  });

  it("keeps tenants apart", async () => {
    const store = new InMemoryObjectStore();
    const pod = tracker(store, "pod-a");
    pod.record("alpha", "m1");
    pod.record("beta", "m1");
    await pod.flush();

    const reader = tracker(store, "reader");
    assert.equal((await reader.load("alpha")).get("m1")?.accessCount, 1);
    assert.equal((await reader.load("beta")).get("m1")?.accessCount, 1);
  });

  it("serves a cached read within the TTL and a fresh one after it", async () => {
    const store = new InMemoryObjectStore();
    let clock = START;
    const writer = tracker(store, "pod-a", { now: () => clock });
    const reader = tracker(store, "reader", { cacheTtlMs: 60_000, now: () => clock });

    writer.record(TENANT, "m1");
    await writer.flush();
    assert.equal((await reader.load(TENANT)).get("m1")?.accessCount, 1);

    clock += 1000;
    writer.record(TENANT, "m1");
    await writer.flush();
    assert.equal((await reader.load(TENANT)).get("m1")?.accessCount, 1, "still cached");

    clock += 60_000;
    assert.equal((await reader.load(TENANT)).get("m1")?.accessCount, 2, "cache expired");
  });

  it("survives merged state it cannot parse", async () => {
    const store = new InMemoryObjectStore();
    await store.put(`stats/${TENANT}/merged.json`, "{ not json");
    const pod = tracker(store, "pod-a");
    pod.record(TENANT, "m1");
    await pod.flush();

    // The corrupt object's counts are gone, but the tenant keeps working and
    // the shards above the reset watermark still land.
    assert.equal(await totalFor(store, "m1"), 1);
  });
});
