import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ulid } from "./id.js";

describe("ulid", () => {
  it("is 26 characters of Crockford base32", () => {
    const id = ulid();
    assert.equal(id.length, 26);
    assert.match(id, /^[0-9A-HJKMNP-TV-Z]{26}$/);
  });

  it("sorts lexicographically in the order the timestamps happened", () => {
    const times = [0, 1, 1000, Date.parse("2020-01-01"), Date.parse("2026-07-01")];
    const ids = times.map((at) => ulid(at));
    assert.deepEqual([...ids].sort(), ids);
  });

  it("refuses a timestamp it cannot encode", () => {
    assert.throws(() => ulid(-1), RangeError);
    assert.throws(() => ulid(2 ** 48), RangeError);
    assert.throws(() => ulid(Number.NaN), RangeError);
  });
});
