/**
 * Measured routing tests (spec §13, §102).
 *
 * The point of this feature is that NYRO stops guessing. These tests protect
 * two things: that a measurement only overrides a guess once there is enough
 * evidence, and that the user is always told which one they are looking at.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  adjustmentFor,
  buildPerformanceIndex,
  MIN_SAMPLES,
  speedScoreFromThroughput,
  type ObservedPerformance,
} from "../src/core/performance.ts";
import { route } from "../src/core/router.ts";
import type { Capability, RegisteredModel, RoutingRequest } from "../src/core/types.ts";

function obs(over: Partial<ObservedPerformance> & { modelId: string }): ObservedPerformance {
  return { medianTokensPerSecond: 50, successRate: 1, samples: 20, ...over };
}

describe("throughput to score", () => {
  test("faster is always a higher score", () => {
    const scores = [1, 5, 20, 60, 150, 400].map(speedScoreFromThroughput);
    for (let i = 1; i < scores.length; i++) {
      assert.ok(scores[i]! >= scores[i - 1]!, `not monotonic at ${i}: ${scores.join(", ")}`);
    }
  });

  test("stays inside the registry's 0..10 scale", () => {
    for (const tps of [0, 0.01, 1, 100, 5000, 1e9]) {
      const s = speedScoreFromThroughput(tps);
      assert.ok(s >= 0 && s <= 10, `${tps} tok/s scored ${s}`);
    }
  });

  test("a very slow model scores low and a very fast one scores high", () => {
    assert.ok(speedScoreFromThroughput(2) < 3);
    assert.ok(speedScoreFromThroughput(300) >= 9.5);
  });

  test("zero or negative throughput scores zero rather than NaN", () => {
    assert.equal(speedScoreFromThroughput(0), 0);
    assert.equal(speedScoreFromThroughput(-5), 0);
  });
});

describe("evidence threshold", () => {
  test("too few samples produces no adjustment", () => {
    assert.equal(adjustmentFor(obs({ modelId: "a", samples: MIN_SAMPLES - 1 })), null);
  });

  test("enough samples produces one", () => {
    assert.notEqual(adjustmentFor(obs({ modelId: "a", samples: MIN_SAMPLES })), null);
  });

  test("no observation at all produces no adjustment", () => {
    assert.equal(adjustmentFor(undefined), null);
  });

  test("the index only contains models with enough evidence", () => {
    const index = buildPerformanceIndex([
      obs({ modelId: "enough", samples: 30 }),
      obs({ modelId: "too-few", samples: 1 }),
    ]);
    assert.ok(index.has("enough"));
    assert.ok(!index.has("too-few"));
  });
});

describe("the note tells the user it is measured", () => {
  test("a reliable model reports throughput and sample count", () => {
    const adj = adjustmentFor(obs({ modelId: "a", medianTokensPerSecond: 42.4, samples: 12 }))!;
    assert.match(adj.note, /measured/);
    assert.match(adj.note, /42 tok\/s/);
    assert.match(adj.note, /12 runs/);
  });

  test("an unreliable model reports its success rate too", () => {
    const adj = adjustmentFor(obs({ modelId: "a", successRate: 0.8, samples: 10 }))!;
    assert.match(adj.note, /80% success/);
  });

  test("a slow model keeps a decimal so it is not rounded to a useless integer", () => {
    const adj = adjustmentFor(obs({ modelId: "a", medianTokensPerSecond: 2.4, samples: 10 }))!;
    assert.match(adj.note, /2\.4 tok\/s/);
  });
});

describe("reliability", () => {
  test("a perfect record costs nothing", () => {
    assert.equal(adjustmentFor(obs({ modelId: "a", successRate: 1 }))!.reliabilityPenalty, 0);
  });

  test("a failing model is penalised in proportion", () => {
    const half = adjustmentFor(obs({ modelId: "a", successRate: 0.5 }))!.reliabilityPenalty;
    const mostly = adjustmentFor(obs({ modelId: "a", successRate: 0.9 }))!.reliabilityPenalty;
    assert.ok(half > mostly && mostly > 0);
  });
});

// ---------------------------------------------------------------------------
function model(over: Partial<RegisteredModel> & { id: string }): RegisteredModel {
  return {
    providerId: over.id.split(":")[0]!,
    modelIdentifier: over.id.split(":").slice(1).join(":"),
    displayName: over.id,
    contextWindow: 128_000,
    maxOutputTokens: 4096,
    inputCostPer1m: 0,
    outputCostPer1m: 0,
    capabilities: ["chat", "streaming"] as Capability[],
    scores: { speed: 5, reasoning: 5, coding: 5, vision: 0, tool_calling: 5 },
    local: false,
    enabled: true,
    health: "healthy",
    ...over,
  };
}
function req(over: Partial<RoutingRequest> = {}): RoutingRequest {
  return {
    mode: "fastest",
    requiredCapabilities: ["chat"],
    preferredCapabilities: [],
    privacy: "normal",
    estimatedInputTokens: 100,
    estimatedOutputTokens: 500,
    maxCostUsd: null,
    ...over,
  };
}

describe("measured scores change routing", () => {
  // Identical on paper; only observation separates them.
  const slow = model({ id: "p:slow", scores: { speed: 9, reasoning: 5, coding: 5, vision: 0, tool_calling: 5 } });
  const fast = model({ id: "p:fast", scores: { speed: 2, reasoning: 5, coding: 5, vision: 0, tool_calling: 5 } });

  test("without measurements the guessed score decides", () => {
    const d = route([slow, fast], req());
    assert.equal(d.candidates[0]!.model.id, "p:slow");
  });

  test("with measurements the observed one wins", () => {
    // "p:slow" was guessed fast but measures slow; "p:fast" is the reverse.
    const observed = buildPerformanceIndex([
      obs({ modelId: "p:slow", medianTokensPerSecond: 3 }),
      obs({ modelId: "p:fast", medianTokensPerSecond: 200 }),
    ]);
    const d = route([slow, fast], req({ observed }));
    assert.equal(d.candidates[0]!.model.id, "p:fast", "a guessed score beat a measured one");
  });

  test("the explanation says the figure was measured", () => {
    const observed = buildPerformanceIndex([obs({ modelId: "p:fast", medianTokensPerSecond: 200 })]);
    const d = route([fast], req({ observed }));
    assert.match(d.candidates[0]!.reasons.join(" "), /measured/);
  });

  test("a model with no measurements is still routable alongside measured ones", () => {
    const observed = buildPerformanceIndex([obs({ modelId: "p:fast", medianTokensPerSecond: 200 })]);
    const d = route([slow, fast], req({ observed }));
    assert.equal(d.candidates.length, 2);
  });

  test("an unreliable model loses to a reliable one at similar speed", () => {
    const observed = buildPerformanceIndex([
      obs({ modelId: "p:slow", medianTokensPerSecond: 50, successRate: 1 }),
      obs({ modelId: "p:fast", medianTokensPerSecond: 55, successRate: 0.4 }),
    ]);
    const d = route([slow, fast], req({ observed }));
    assert.equal(d.candidates[0]!.model.id, "p:slow");
  });

  test("measurements never override privacy", () => {
    const localSlow = model({ id: "ollama:m", local: true });
    const cloudFast = model({ id: "openai:m" });
    const observed = buildPerformanceIndex([
      obs({ modelId: "ollama:m", medianTokensPerSecond: 1 }),
      obs({ modelId: "openai:m", medianTokensPerSecond: 500 }),
    ]);
    const d = route([localSlow, cloudFast], req({ privacy: "local_only", observed }));
    assert.ok(d.candidates.every((c) => c.model.local));
  });
});
