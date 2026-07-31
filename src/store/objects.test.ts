/**
 * What this store actually sends to S3, and what it makes of the answers.
 *
 * The conditional-write headers are the reason this file exists at all: the
 * compaction in `stats.ts` is safe across pods only because a `put` can be made
 * to fail when someone else got there first. Everything above this layer is
 * tested against a fake that reimplements that rule, so nothing checked whether
 * the real one asks S3 for it, or recognises the refusal when it comes back.
 */

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { S3Client } from "@aws-sdk/client-s3";
import { PreconditionFailed, S3ObjectStore } from "./objects.js";

interface Sent {
  name: string;
  input: Record<string, any>;
}

/** An error shaped the way the SDK shapes them, so `$metadata` is what is read. */
function awsError(httpStatusCode: number): Error {
  return Object.assign(new Error(`status ${httpStatusCode}`), { $metadata: { httpStatusCode } });
}

/** Canned answers in order; a thrown entry is thrown rather than returned. */
function stub(answers: unknown[] = []) {
  const sent: Sent[] = [];
  let next = 0;
  const client = {
    send: async (command: { constructor: { name: string }; input: Record<string, unknown> }) => {
      sent.push({ name: command.constructor.name, input: command.input });
      const answer = answers[next++];
      if (answer instanceof Error) {
        throw answer;
      }
      return answer ?? {};
    },
  };
  return { store: new S3ObjectStore(client as unknown as S3Client, "state"), sent };
}

/** What GetObject's body looks like coming off the wire. */
function body(text: string) {
  return { Body: { transformToString: async () => text }, ETag: '"v1"' };
}

describe("get", () => {
  it("returns the body and the etag a compare-and-swap will need", async () => {
    const { store } = stub([body("{}")]);
    assert.deepEqual(await store.get("stats/demo/merged.json"), { body: "{}", etag: '"v1"' });
  });

  it("reads a missing object as absent rather than as an error", async () => {
    // Every tenant's first read is a miss, so this is the common path.
    const { store } = stub([awsError(404)]);
    assert.equal(await store.get("stats/demo/merged.json"), undefined);
  });

  it("lets anything else through", async () => {
    const { store } = stub([awsError(403)]);
    await assert.rejects(() => store.get("stats/demo/merged.json"), /status 403/);
  });
});

describe("put", () => {
  it("sends no condition when none was asked for", async () => {
    const { store, sent } = stub();
    await store.put("k", "v");

    assert.equal(sent[0]!.input.IfMatch, undefined);
    assert.equal(sent[0]!.input.IfNoneMatch, undefined);
    assert.equal(sent[0]!.input.Body, "v");
  });

  it("carries the etag as IfMatch, which is what makes compaction safe", async () => {
    const { store, sent } = stub();
    await store.put("k", "v", { ifMatch: '"v1"' });

    assert.equal(sent[0]!.input.IfMatch, '"v1"');
  });

  it("asks for create-only with a wildcard IfNoneMatch", async () => {
    const { store, sent } = stub();
    await store.put("k", "v", { ifNoneMatch: true });

    assert.equal(sent[0]!.input.IfNoneMatch, "*");
  });

  it("reports a failed condition as one, so the loser can stand down", async () => {
    // 412 is the condition failing. 409 is a concurrent update to the same key,
    // which for a caller doing compare-and-swap means the same thing.
    for (const status of [412, 409]) {
      const { store } = stub([awsError(status)]);
      await assert.rejects(() => store.put("k", "v", { ifMatch: '"v1"' }), PreconditionFailed);
    }
  });

  it("does not disguise an unrelated failure as a lost race", async () => {
    const { store } = stub([awsError(500)]);
    await assert.rejects(() => store.put("k", "v", { ifMatch: '"v1"' }), /status 500/);
  });
});

describe("list", () => {
  it("passes the prefix and the start key, and stops at the limit", async () => {
    const { store, sent } = stub([{ Contents: [{ Key: "a" }, { Key: "b" }, { Key: "c" }] }]);
    const keys = await store.list("index/demo/", 2, "index/demo/aa");

    assert.equal(sent[0]!.input.Prefix, "index/demo/");
    assert.equal(sent[0]!.input.StartAfter, "index/demo/aa");
    assert.equal(sent[0]!.input.MaxKeys, 2);
    assert.deepEqual(keys, ["a", "b"], "never more than asked for");
  });

  it("follows the continuation token until it has enough", async () => {
    const { store, sent } = stub([
      { Contents: [{ Key: "a" }], IsTruncated: true, NextContinuationToken: "t1" },
      { Contents: [{ Key: "b" }], IsTruncated: false },
    ]);
    assert.deepEqual(await store.list("p/", 10), ["a", "b"]);
    assert.equal(sent[1]!.input.ContinuationToken, "t1");
  });

  it("stops when S3 says truncated but offers no token", async () => {
    // Would spin forever if the token were assumed to exist.
    const { store } = stub([{ Contents: [{ Key: "a" }], IsTruncated: true }]);
    assert.deepEqual(await store.list("p/", 10), ["a"]);
  });

  it("answers an empty prefix with an empty list", async () => {
    const { store } = stub([{}]);
    assert.deepEqual(await store.list("p/", 10), []);
  });
});

describe("delete", () => {
  it("says nothing to S3 when there is nothing to delete", async () => {
    const { store, sent } = stub();
    await store.delete([]);
    assert.equal(sent.length, 0);
  });

  it("splits at the 1000 keys one call accepts", async () => {
    const { store, sent } = stub();
    await store.delete(Array.from({ length: 2_500 }, (_, i) => `k${i}`));

    assert.deepEqual(
      sent.map((call) => call.input.Delete.Objects.length),
      [1000, 1000, 500],
    );
  });

  it("fails when S3 reports keys it could not remove", async () => {
    // The defect this pins: DeleteObjects answers 200 and names the failures in
    // the body. A caller that only awaited the call was told every deletion
    // succeeded — and both callers here treat this as best-effort cleanup, so
    // the single signal that cleanup is broken was the one being discarded.
    const { store } = stub([{ Errors: [{ Key: "index/demo/abc", Code: "AccessDenied" }] }]);
    await assert.rejects(() => store.delete(["index/demo/abc"]), /could not remove 1 of 1 keys/);
  });

  it("succeeds quietly when every key went", async () => {
    const { store } = stub([{ Errors: [] }]);
    await assert.doesNotReject(() => store.delete(["k"]));
  });
});
