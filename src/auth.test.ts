import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { authorizes, authorizesOrigin, describeAuth } from "./auth.js";

describe("authorizes", () => {
  it("lets everyone through when no key is configured", () => {
    // The deployed mode: a ClusterIP with no ingress, where the network is the
    // boundary. Asserted rather than assumed, because it is a deliberate choice.
    assert.equal(authorizes(undefined, undefined), true);
    assert.equal(authorizes("", "Bearer whatever"), true);
  });

  it("requires exactly the configured key when one is set", () => {
    assert.equal(authorizes("s3cret", "Bearer s3cret"), true);
    assert.equal(authorizes("s3cret", "bearer s3cret"), true);
    assert.equal(authorizes("s3cret", "BEARER  s3cret"), true);
    assert.equal(authorizes("s3cret", "Bearer wrong"), false);
    assert.equal(authorizes("s3cret", "Bearer s3cret "), false);
    assert.equal(authorizes("s3cret", "s3cret"), false);
    assert.equal(authorizes("s3cret", "Basic s3cret"), false);
    assert.equal(authorizes("s3cret", undefined), false);
    assert.equal(authorizes("s3cret", "Bearer "), false);
  });

  it("rejects a key of a different length without throwing", () => {
    // timingSafeEqual throws on a length mismatch, so the length is checked first.
    assert.equal(authorizes("s3cret", "Bearer s"), false);
    assert.equal(authorizes("s3cret", `Bearer ${"x".repeat(500)}`), false);
  });
});

describe("authorizesOrigin", () => {
  it("refuses browser origins on the cluster-internal endpoint", () => {
    assert.equal(authorizesOrigin(undefined), true);
    assert.equal(authorizesOrigin("https://example.com"), false);
    assert.equal(authorizesOrigin("null"), false);
  });
});

describe("describeAuth", () => {
  it("says which mode the process is in, in both modes", () => {
    assert.match(describeAuth("k"), /MCP_API_KEY is set/);
    assert.match(describeAuth(undefined), /answers ANY caller/);
  });
});
