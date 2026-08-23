/**
 * What this store actually sends to PostgreSQL, and what it makes of the
 * answers — the counterpart of `objects.test.ts` for the other backend.
 *
 * The conditional writes are the reason, as there: compaction in `stats.ts` is
 * safe across pods only because a `put` can be made to fail when someone else
 * got there first, and here that rule is a WHERE clause on a version. These
 * assert the SQL carries the condition and that zero rows is read as the
 * refusal. `pg.test.ts` runs the same contract against a real database.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { PreconditionFailed } from "./objects.js";
import { PgObjectStore, type Queryable } from "./pgObjects.js";

interface Sent {
  text: string;
  values: unknown[];
}

/** Captures queries and hands back canned results in order. */
function stub(answers: { rows?: Record<string, unknown>[]; rowCount?: number }[] = []) {
  const sent: Sent[] = [];
  let next = 0;
  const db: Queryable = {
    query: async (text, values = []) => {
      sent.push({ text, values });
      const answer = answers[next++] ?? {};
      return { rows: answer.rows ?? [], rowCount: answer.rowCount ?? answer.rows?.length ?? 0 };
    },
  };
  return { store: new PgObjectStore(db), sent };
}

describe("get", () => {
  it("returns the body and the version as the etag a compare-and-swap will need", async () => {
    const { store, sent } = stub([{ rows: [{ body: "{}", etag: "17" }] }]);
    assert.deepEqual(await store.get("stats/demo/merged.json"), { body: "{}", etag: "17" });
    assert.deepEqual(sent[0]!.values, ["stats/demo/merged.json"]);
  });

  it("reads a missing row as absent rather than as an error", async () => {
    const { store } = stub([{ rows: [] }]);
    assert.equal(await store.get("stats/demo/merged.json"), undefined);
  });
});

describe("put", () => {
  it("upserts when no condition was asked for", async () => {
    const { store, sent } = stub([{ rowCount: 1 }]);
    await store.put("k", "v");

    assert.match(sent[0]!.text, /ON CONFLICT \(key\) DO UPDATE/);
    assert.deepEqual(sent[0]!.values, ["k", "v"]);
  });

  it("names the version it read as the condition, which is what makes compaction safe", async () => {
    const { store, sent } = stub([{ rowCount: 1 }]);
    await store.put("k", "v", { ifMatch: "17" });

    assert.match(sent[0]!.text, /^UPDATE objects/);
    assert.match(sent[0]!.text, /WHERE key = \$1 AND version::text = \$3/);
    assert.deepEqual(sent[0]!.values, ["k", "v", "17"]);
  });

  it("asks for create-only with an insert that does nothing on conflict", async () => {
    const { store, sent } = stub([{ rowCount: 1 }]);
    await store.put("k", "v", { ifNoneMatch: true });

    assert.match(sent[0]!.text, /ON CONFLICT \(key\) DO NOTHING/);
  });

  it("reports a condition that touched no row as a failed one, so the loser can stand down", async () => {
    for (const options of [{ ifMatch: "17" }, { ifNoneMatch: true }]) {
      const { store } = stub([{ rowCount: 0 }]);
      await assert.rejects(() => store.put("k", "v", options), PreconditionFailed);
    }
  });

  it("does not disguise an unrelated failure as a lost race", async () => {
    const db: Queryable = {
      query: async () => {
        throw new Error("connection refused");
      },
    };
    await assert.rejects(
      () => new PgObjectStore(db).put("k", "v", { ifMatch: "17" }),
      /connection refused/,
    );
  });
});

describe("list", () => {
  it("passes the prefix, the start key and the limit, ascending", async () => {
    const { store, sent } = stub([{ rows: [{ key: "a" }, { key: "b" }] }]);
    const keys = await store.list("index/demo/", 2, "index/demo/aa");

    assert.match(sent[0]!.text, /starts_with\(key, \$1\) AND key > \$2 ORDER BY key LIMIT \$3/);
    assert.deepEqual(sent[0]!.values, ["index/demo/", "index/demo/aa", 2]);
    assert.deepEqual(keys, ["a", "b"]);
  });

  it("starts from the beginning when no start key was given", async () => {
    // The empty string sorts before every key, so one comparison serves both cases.
    const { store, sent } = stub([{ rows: [] }]);
    await store.list("p/", 10);
    assert.deepEqual(sent[0]!.values, ["p/", "", 10]);
  });
});

describe("delete", () => {
  it("says nothing to the database when there is nothing to delete", async () => {
    const { store, sent } = stub();
    await store.delete([]);
    assert.equal(sent.length, 0);
  });

  it("removes every key in one statement", async () => {
    const { store, sent } = stub([{ rowCount: 2 }]);
    await store.delete(["a", "b"]);

    assert.match(sent[0]!.text, /key = ANY\(\$1::text\[\]\)/);
    assert.deepEqual(sent[0]!.values, [["a", "b"]]);
  });
});
