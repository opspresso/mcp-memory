import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  accessScore,
  compositeScore,
  confidenceOf,
  decayedTrust,
  guidanceFor,
  modeConfig,
  recencyScore,
  relativeSimilarity,
} from "./ranking.js";

const NOW = Date.parse("2026-07-01T00:00:00.000Z");
const DAY = 86_400_000;

describe("recencyScore", () => {
  it("is 1 for something just touched and 0.5 at the half-life", () => {
    assert.equal(recencyScore(NOW, NOW), 1);
    assert.ok(Math.abs(recencyScore(NOW, NOW - 30 * DAY) - 0.5) < 1e-9);
    assert.ok(Math.abs(recencyScore(NOW, NOW - 60 * DAY) - 0.25) < 1e-9);
  });

  it("does not exceed 1 for a timestamp in the future", () => {
    // Clock skew between pods is normal; it must not manufacture a score above 1.
    assert.equal(recencyScore(NOW, NOW + 10 * DAY), 1);
  });
});

describe("decayedTrust", () => {
  it("decays a conversation faster than an architectural fact", () => {
    // The spread is the whole point of having per-type half-lives: a decision
    // is still true a season later, something said once often is not.
    const age = NOW - 60 * DAY;
    const project = decayedTrust(NOW, 1, age, "project", 0);
    const conversation = decayedTrust(NOW, 1, age, "conversation", 0);
    assert.ok(project > conversation, `${project} should beat ${conversation}`);
    assert.ok(Math.abs(conversation - 0.25) < 1e-9, "conversation halves twice over 60 days");
  });

  it("lets frequent use slow the decay", () => {
    const age = NOW - 60 * DAY;
    assert.ok(decayedTrust(NOW, 1, age, "pattern", 50) > decayedTrust(NOW, 1, age, "pattern", 0));
  });

  it("never lets use push trust above where it started", () => {
    assert.equal(decayedTrust(NOW, 1, NOW, "pattern", 10_000), 1);
    assert.ok(decayedTrust(NOW, 0.5, NOW, "pattern", 10_000) <= 0.5);
  });
});

describe("accessScore", () => {
  it("normalises against the busiest memory in the set", () => {
    assert.equal(accessScore(5, 10), 0.5);
    assert.equal(accessScore(10, 10), 1);
    assert.equal(accessScore(0, 0), 0, "no divide by zero when nothing has been used");
    assert.equal(accessScore(20, 10), 1, "capped");
  });
});

describe("compositeScore", () => {
  it("weights similarity hardest in precision and loosest in exploratory", () => {
    const parts = { similarity: 1, recency: 0, access: 0, trust: 0 };
    assert.ok(compositeScore("precision", parts) > compositeScore("balanced", parts));
    assert.ok(compositeScore("balanced", parts) > compositeScore("exploratory", parts));
  });

  it("lets recency and access decide between equally similar memories", () => {
    const base = { similarity: 0.8, recency: 0, access: 0, trust: 1 };
    assert.ok(compositeScore("balanced", { ...base, recency: 1 }) > compositeScore("balanced", base));
    assert.ok(compositeScore("balanced", { ...base, access: 1 }) > compositeScore("balanced", base));
  });
});

describe("modeConfig", () => {
  it("gates harder and returns less as precision rises", () => {
    assert.ok(modeConfig("precision").keepRatio > modeConfig("exploratory").keepRatio);
    assert.ok(modeConfig("precision").limit < modeConfig("exploratory").limit);
    assert.deepEqual(modeConfig(), modeConfig("balanced"), "balanced is the default");
  });

  it("gates on a fraction of the top match, not an absolute cosine", () => {
    // Absolute thresholds do not survive an embedding-model swap: measured on
    // Titan v2 a correct answer scores 0.15–0.41, so a threshold tuned for a
    // model whose correct answers sit at 0.8 returns nothing at all.
    for (const mode of ["precision", "balanced", "exploratory"] as const) {
      assert.ok(modeConfig(mode).keepRatio > 0 && modeConfig(mode).keepRatio <= 1);
    }
  });
});

describe("relativeSimilarity", () => {
  it("puts the best match at 1 and scales the rest against it", () => {
    assert.equal(relativeSimilarity(0.4, 0.4), 1);
    assert.equal(relativeSimilarity(0.2, 0.4), 0.5);
    assert.equal(relativeSimilarity(0, 0.4), 0);
  });

  it("survives a degenerate top score", () => {
    assert.equal(relativeSimilarity(0, 0), 0);
    assert.equal(relativeSimilarity(-0.1, -0.1), 0, "a negative top means nothing was relevant");
  });

  it("keeps a raw cosine from outweighing recency by accident", () => {
    // The bug this exists to prevent: on Titan, raw similarity varies by ~0.26
    // across a result set while recency varies by a full 1.0 — so a fresh,
    // weakly-matching memory would outrank an older, better one.
    const better = { similarity: relativeSimilarity(0.4, 0.4), recency: 0, access: 0, trust: 1 };
    const fresher = { similarity: relativeSimilarity(0.15, 0.4), recency: 1, access: 0, trust: 1 };
    assert.ok(compositeScore("balanced", better) > compositeScore("balanced", fresher));
  });
});

describe("confidenceOf", () => {
  it("calls nothing low and a clearly-above-floor match high", () => {
    assert.equal(confidenceOf(undefined, 0.1), "low");
    assert.equal(confidenceOf(0.33, 0.1), "high");
    assert.equal(confidenceOf(0.15, 0.1), "medium");
  });

  it("moves with the floor, so it survives a model swap", () => {
    // The same cosine means different things under different models; expressing
    // confidence against the floor is what keeps the label meaningful.
    assert.equal(confidenceOf(0.9, 0.1), "high");
    assert.equal(confidenceOf(0.9, 0.7), "medium", "0.9 is unremarkable when the floor is 0.7");
  });
});

describe("guidanceFor", () => {
  it("tells the model not to fill an empty result from its own priors", () => {
    // The specific failure this exists to prevent: a search that finds nothing
    // reading, mid-task, like permission to invent an answer.
    const empty = guidanceFor("low", 0, 0, "balanced");
    assert.match(empty, /NO MATCH FOUND/);
    assert.match(empty, /do not infer an answer/i);
  });

  it("distinguishes 'nothing stored' from 'nothing close enough'", () => {
    const gated = guidanceFor("low", 0, 3, "balanced");
    assert.match(gated, /NO CONFIDENT MATCH/);
    assert.match(gated, /3 memories were found/);
    assert.match(gated, /Do not present a guess as a remembered fact/);
  });

  it("suggests a looser mode only when the caller was in a tighter one", () => {
    assert.match(guidanceFor("low", 0, 0, "precision"), /exploratory/);
    assert.doesNotMatch(guidanceFor("low", 0, 0, "exploratory"), /mode 'exploratory'/);
  });

  it("marks a close match as usable directly", () => {
    assert.match(guidanceFor("high", 2, 0, "balanced"), /HIGH CONFIDENCE/);
    assert.match(guidanceFor("medium", 2, 0, "balanced"), /MEDIUM CONFIDENCE/);
  });
});
