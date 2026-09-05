import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ConversationError, parseConversation } from "./conversation.js";

describe("parseConversation", () => {
  it("is absent when the header is, or is blank — a request need not be in a conversation", () => {
    assert.equal(parseConversation(undefined), undefined);
    assert.equal(parseConversation(null), undefined);
    assert.equal(parseConversation(""), undefined);
    assert.equal(parseConversation("   "), undefined);
  });

  it("keeps what the platform sends: printable ASCII, percent-encoding and all", () => {
    assert.equal(parseConversation("chat:0d1e-4f"), "chat:0d1e-4f");
    assert.equal(parseConversation(" slack:C1:1723.45 "), "slack:C1:1723.45");
    assert.equal(parseConversation("api:9f2c1a:%ED%9A%8C%EC%9D%98-1"), "api:9f2c1a:%ED%9A%8C%EC%9D%98-1");
    assert.equal(parseConversation("a".repeat(512)), "a".repeat(512));
  });

  it("refuses a malformed header rather than reading it as no conversation", () => {
    // Quietly dropping it would file a thread's note under the project.
    assert.throws(() => parseConversation("a".repeat(513)), ConversationError);
    assert.throws(() => parseConversation("has space"), ConversationError);
    assert.throws(() => parseConversation("회의"), ConversationError);
    assert.throws(() => parseConversation("line\nbreak"), ConversationError);
    assert.throws(() => parseConversation(["one", "two"]), ConversationError);
  });
});
