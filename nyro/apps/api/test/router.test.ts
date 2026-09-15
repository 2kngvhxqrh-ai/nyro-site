/**
 * Router tests.
 *
 * These are the tests that make NYRO's privacy and override promises real
 * rather than documentation. If any of them fails, the system is unsafe to use
 * with a "local only" setting, regardless of what the UI displays.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { route } from "../src/core/router.ts";
import type { Capability, RegisteredModel, RoutingRequest } from "../src/core/types.ts";

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
    mode: "auto",
    requiredCapabilities: ["chat"],
    preferredCapabilities: [],
    privacy: "normal",
    estimatedInputTokens: 100,
    estimatedOutputTokens: 500,
    maxCostUsd: null,
    ...over,
  };
}

const localTiny = model({
  id: "ollama:llama3.2:1b",
  local: true,
  scores: { speed: 10, reasoning: 2, coding: 2, vision: 0, tool_calling: 1 },
});
const cloudStrong = model({
  id: "anthropic:claude-opus",
  inputCostPer1m: 15,
  outputCostPer1m: 75,
  capabilities: ["chat", "streaming", "reasoning", "coding", "vision", "long_context"],
  scores: { speed: 6, reasoning: 10, coding: 10, vision: 9, tool_calling: 10 },
});
const cloudCheap = model({
  id: "openai:gpt-4o-mini",
  inputCostPer1m: 0.15,
  outputCostPer1m: 0.6,
  capabilities: ["chat", "streaming", "reasoning", "coding", "vision"],
  scores: { speed: 9, reasoning: 6, coding: 6, vision: 7, tool_calling: 8 },
});

const ALL = [localTiny, cloudStrong, cloudCheap];

describe("privacy is a hard constraint", () => {
  test("local_only privacy excludes every cloud model", () => {
    const d = route(ALL, req({ privacy: "local_only" }));
    assert.equal(d.candidates.length, 1);
    assert.equal(d.candidates[0]!.model.id, localTiny.id);
    assert.ok(d.candidates.every((c) => c.model.local));
  });

  test("local_only mode excludes every cloud model even when quality is requested", () => {
    const d = route(ALL, req({ mode: "local_only", requiredCapabilities: ["chat"] }));
    assert.ok(d.candidates.every((c) => c.model.local), "a cloud model entered a local-only route");
  });

  test("sensitive privacy excludes cloud models", () => {
    const d = route(ALL, req({ privacy: "sensitive" }));
    assert.ok(d.candidates.every((c) => c.model.local));
    assert.ok(d.rejected.some((r) => r.reason.includes("sensitive")));
  });

  test("an explicit model override cannot breach local_only", () => {
    // The single most important test here: "use Claude" must NOT win over privacy.
    const d = route(ALL, req({ privacy: "local_only", requestedModelId: cloudStrong.id }));
    assert.ok(
      d.candidates.every((c) => c.model.local),
      "explicit override escalated a local-only request to the cloud",
    );
    assert.ok(d.rejected.some((r) => r.modelId === cloudStrong.id));
  });

  test("the whole fallback chain respects local_only, not just the first pick", () => {
    const d = route(ALL, req({ privacy: "local_only" }));
    for (const c of d.candidates) assert.equal(c.model.local, true);
  });

  test("cloud_only excludes local models", () => {
    const d = route(ALL, req({ mode: "cloud_only" }));
    assert.ok(d.candidates.every((c) => !c.model.local));
  });
});

describe("routing modes", () => {
  test("cheapest prefers the free local model", () => {
    const d = route(ALL, req({ mode: "cheapest" }));
    assert.equal(d.candidates[0]!.model.id, localTiny.id);
  });

  test("best prefers the strongest reasoning model", () => {
    const d = route(ALL, req({ mode: "best", requiredCapabilities: ["chat", "reasoning"] }));
    assert.equal(d.candidates[0]!.model.id, cloudStrong.id);
  });

  test("fastest prefers the highest speed score", () => {
    const d = route(ALL, req({ mode: "fastest" }));
    assert.equal(d.candidates[0]!.model.id, localTiny.id);
  });

  test("a coding request does not pick a model that cannot code", () => {
    const d = route(ALL, req({ requiredCapabilities: ["chat", "coding"] }));
    assert.ok(d.candidates.every((c) => c.model.capabilities.includes("coding")));
    assert.ok(d.rejected.some((r) => r.modelId === localTiny.id && r.reason.includes("coding")));
  });
});

describe("required vs preferred capabilities", () => {
  test("a preferred capability never excludes a model", () => {
    // The bug this guards: guessing "this looks like reasoning" must not make
    // NYRO refuse when only a weak local model is configured.
    const d = route([localTiny], req({ preferredCapabilities: ["reasoning", "coding"] }));
    assert.equal(d.candidates.length, 1, "a soft preference excluded the only available model");
    assert.equal(d.candidates[0]!.model.id, localTiny.id);
  });

  test("a required capability still excludes a model that lacks it", () => {
    const d = route([localTiny], req({ requiredCapabilities: ["chat", "vision"] }));
    assert.equal(d.candidates.length, 0);
    assert.ok(d.rejected[0]!.reason.includes("vision"));
  });

  test("a preferred capability still steers ranking", () => {
    const d = route([localTiny, cloudStrong], req({ mode: "best", preferredCapabilities: ["coding"] }));
    assert.equal(d.candidates[0]!.model.id, cloudStrong.id, "preference should have raised the strong coder");
  });
});

describe("eligibility filters", () => {
  test("a model whose context is too small is rejected with a specific reason", () => {
    const d = route(ALL, req({ estimatedInputTokens: 500_000 }));
    assert.equal(d.candidates.length, 0);
    assert.ok(d.rejected.every((r) => r.reason.includes("context window too small")));
  });

  test("an unreachable provider's model is excluded", () => {
    const dead = { ...cloudStrong, health: "unreachable" as const };
    const d = route([dead, cloudCheap], req());
    assert.ok(!d.candidates.some((c) => c.model.id === dead.id));
    assert.ok(d.rejected.some((r) => r.reason.includes("unreachable")));
  });

  test("a disabled model is excluded", () => {
    const off = { ...cloudCheap, enabled: false };
    const d = route([off], req());
    assert.equal(d.candidates.length, 0);
    assert.ok(d.rejected[0]!.reason.includes("disabled"));
  });

  test("a per-request cost ceiling excludes models above it", () => {
    // 100 in + 500 out on Opus = 100/1e6*15 + 500/1e6*75 = $0.0390
    const d = route(ALL, req({ maxCostUsd: 0.001 }));
    assert.ok(!d.candidates.some((c) => c.model.id === cloudStrong.id));
    assert.ok(d.rejected.some((r) => r.modelId === cloudStrong.id && r.reason.includes("exceeds")));
  });

  test("no eligible models yields an empty candidate list, not a throw", () => {
    const d = route([], req());
    assert.equal(d.candidates.length, 0);
  });
});

describe("overrides and determinism", () => {
  test("an explicit eligible model is chosen first", () => {
    const d = route(ALL, req({ requestedModelId: cloudCheap.id }));
    assert.equal(d.candidates[0]!.model.id, cloudCheap.id);
    assert.ok(d.candidates[0]!.reasons.some((r) => r.includes("explicitly requested")));
  });

  test("an explicit model still leaves other models as fallbacks", () => {
    const d = route(ALL, req({ requestedModelId: cloudCheap.id }));
    assert.ok(d.candidates.length > 1, "an override must not destroy the fallback chain");
  });

  test("requesting a provider restricts candidates to that provider", () => {
    const d = route(ALL, req({ requestedProviderId: "openai" }));
    assert.ok(d.candidates.every((c) => c.model.providerId === "openai"));
  });

  test("routing is deterministic for identical inputs", () => {
    const a = route(ALL, req());
    const b = route(ALL, req());
    assert.deepEqual(a.candidates.map((c) => c.model.id), b.candidates.map((c) => c.model.id));
  });

  test("equal-scoring models are ordered stably by id", () => {
    const m1 = model({ id: "p:aaa" });
    const m2 = model({ id: "p:bbb" });
    const d = route([m2, m1], req());
    assert.deepEqual(d.candidates.map((c) => c.model.id), ["p:aaa", "p:bbb"]);
  });

  test("a degraded provider is ranked below a healthy equivalent", () => {
    const healthy = model({ id: "a:m", health: "healthy" });
    const degraded = model({ id: "b:m", health: "degraded" });
    const d = route([degraded, healthy], req());
    assert.equal(d.candidates[0]!.model.id, "a:m");
  });
});
