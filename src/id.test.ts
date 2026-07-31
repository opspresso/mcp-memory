import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { invertedTime, ulid, ulidTime } from "./id.js";

describe("ulid", () => {
  it("is 26 characters of Crockford base32", () => {
    const id = ulid();
    assert.equal(id.length, 26);
    assert.match(id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("recovers the millisecond it encodes", () => {
    const at = Date.parse("2026-07-01T12:34:56.789Z");
    assert.equal(ulidTime(ulid(at)), at);
  });

  it("sorts lexicographically in the order the timestamps happened", () => {
    // The property the whole recency index rests on: S3 sorts keys as strings,
    // so a ULID has to sort as a string the way its instants sort as numbers.
    const times = [0, 1, 1000, Date.parse("2020-01-01"), Date.parse("2026-07-01")];
    const ids = times.map((at) => ulid(at));
    assert.deepEqual([...ids].sort(), ids);
  });

  it("reports a non-ulid as NaN rather than a wrong time", () => {
    assert.ok(Number.isNaN(ulidTime("nope")));
    assert.ok(Number.isNaN(ulidTime("!!!!!!!!!!ABCDEFGHIJKLMNOP")));
  });

  it("refuses a timestamp it cannot encode", () => {
    assert.throws(() => ulid(-1), RangeError);
    assert.throws(() => ulid(2 ** 48), RangeError);
    assert.throws(() => ulid(Number.NaN), RangeError);
  });
});

describe("invertedTime", () => {
  it("puts newer first when sorted ascending", () => {
    // S3 lists ascending with no reverse, so "newest first" has to come out of
    // the key itself.
    const older = invertedTime(Date.parse("2026-01-01"));
    const newer = invertedTime(Date.parse("2026-07-01"));
    assert.ok(newer < older, `${newer} should sort before ${older}`);
  });

  it("is fixed width, so comparison never depends on length", () => {
    assert.equal(invertedTime(0).length, 10);
    assert.equal(invertedTime(Date.now()).length, 10);
  });
});
