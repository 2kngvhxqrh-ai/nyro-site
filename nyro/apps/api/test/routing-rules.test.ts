/**
 * Routing rule tests (spec §10, §147, §148).
 *
 * The rule that matters most is the one asserting a user rule CANNOT win:
 * preferences reorder candidates the router already accepted, so privacy,
 * budget and availability all still come first. If that ever inverts, a rule
 * saying "coding goes to Claude" would quietly send private code to the cloud.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { route } from "../src/core/router.ts";
import { preferencesFor, validateRuleTargets, routingRulesSchema, type RoutingRule } from "../src/core/routing-rules.ts";
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
    capabilities: ["chat", "streaming", "coding", "reasoning"] as Capability[],
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

function rule(over: Partial<RoutingRule> & { id: string; name: string }): RoutingRule {
  return {
    enabled: true,
    whenCapability: "coding",
    preferModelId: null,
    preferProviderId: null,
    ...over,
  };
}

const localTiny = model({ id: "ollama:llama3.2:1b", local: true, scores: { speed: 10, reasoning: 2, coding: 2, vision: 0, tool_calling: 1 } });
const claude = model({ id: "anthropic:claude-sonnet", inputCostPer1m: 3, outputCostPer1m: 15, scores: { speed: 8, reasoning: 9, coding: 9, vision: 0, tool_calling: 9 } });
const gpt = model({ id: "openai:gpt-4o", inputCostPer1m: 2.5, outputCostPer1m: 10, scores: { speed: 8, reasoning: 8, coding: 8, vision: 0, tool_calling: 9 } });
const ALL = [localTiny, claude, gpt];

describe("preferences are built from matching rules", () => {
  test("a rule fires when the request wants its capability", () => {
    const prefs = preferencesFor([rule({ id: "1", name: "Coding to Claude", preferProviderId: "anthropic" })], ["chat", "coding"]);
    assert.equal(prefs.length, 1);
    assert.equal(prefs[0]!.providerId, "anthropic");
    assert.match(prefs[0]!.reason, /Coding to Claude/);
  });

  test("a rule does not fire for an unrelated request", () => {
    const prefs = preferencesFor([rule({ id: "1", name: "Coding", preferProviderId: "anthropic" })], ["chat"]);
    assert.equal(prefs.length, 0);
  });

  test("a disabled rule never fires", () => {
    const prefs = preferencesFor([rule({ id: "1", name: "Off", enabled: false, preferProviderId: "anthropic" })], ["chat", "coding"]);
    assert.equal(prefs.length, 0);
  });

  test("the first matching rule for a capability wins", () => {
    const prefs = preferencesFor(
      [
        rule({ id: "1", name: "First", preferProviderId: "anthropic" }),
        rule({ id: "2", name: "Second", preferProviderId: "openai" }),
      ],
      ["coding"],
    );
    assert.equal(prefs.length, 1);
    assert.equal(prefs[0]!.providerId, "anthropic");
  });

  test("rules for different capabilities both fire", () => {
    const prefs = preferencesFor(
      [
        rule({ id: "1", name: "Coding", whenCapability: "coding", preferProviderId: "anthropic" }),
        rule({ id: "2", name: "Reasoning", whenCapability: "reasoning", preferProviderId: "openai" }),
      ],
      ["coding", "reasoning"],
    );
    assert.equal(prefs.length, 2);
  });
});

describe("a rule steers routing", () => {
  test("a provider rule wins over the default ranking", () => {
    const withoutRule = route(ALL, req({ preferredCapabilities: ["coding"] }));
    const withRule = route(ALL, req({
      preferredCapabilities: ["coding"],
      preferences: [{ modelId: null, providerId: "openai", reason: 'your rule "Code to GPT"' }],
    }));
    assert.equal(withRule.candidates[0]!.model.providerId, "openai");
    assert.notEqual(withoutRule.candidates[0]!.model.id, withRule.candidates[0]!.model.id);
  });

  test("the reason is shown to the user", () => {
    const d = route(ALL, req({ preferences: [{ modelId: null, providerId: "openai", reason: 'your rule "Code to GPT"' }] }));
    assert.match(d.candidates[0]!.reasons.join(" "), /your rule "Code to GPT"/);
  });

  test("a model-specific rule outranks a provider rule", () => {
    const d = route(ALL, req({
      preferences: [
        { modelId: null, providerId: "openai", reason: "provider rule" },
        { modelId: "anthropic:claude-sonnet", providerId: null, reason: "model rule" },
      ],
    }));
    assert.equal(d.candidates[0]!.model.id, "anthropic:claude-sonnet");
  });
});

describe("a rule can never win against a hard constraint", () => {
  test("privacy beats a rule pointing at the cloud", () => {
    // The most important test in this file.
    const d = route(ALL, req({
      privacy: "local_only",
      preferences: [{ modelId: "anthropic:claude-sonnet", providerId: null, reason: "your rule" }],
    }));
    assert.ok(d.candidates.every((c) => c.model.local), "a routing rule sent a local-only request to the cloud");
    assert.equal(d.candidates[0]!.model.id, localTiny.id);
  });

  test("a cost ceiling beats a rule", () => {
    const d = route(ALL, req({
      maxCostUsd: 0.0001,
      preferences: [{ modelId: "anthropic:claude-sonnet", providerId: null, reason: "your rule" }],
    }));
    assert.ok(!d.candidates.some((c) => c.model.id === "anthropic:claude-sonnet"));
  });

  test("a provider excluded by its budget beats a rule", () => {
    const d = route(ALL, req({
      excludedProviderIds: ["anthropic"],
      preferences: [{ modelId: "anthropic:claude-sonnet", providerId: null, reason: "your rule" }],
    }));
    assert.ok(!d.candidates.some((c) => c.model.providerId === "anthropic"));
  });

  test("an unreachable preferred model does not cause a failure", () => {
    const dead = { ...claude, health: "unreachable" as const };
    const d = route([localTiny, dead, gpt], req({
      preferences: [{ modelId: dead.id, providerId: null, reason: "your rule" }],
    }));
    assert.ok(d.candidates.length > 0, "a rule pointing at a dead model emptied the candidate list");
    assert.notEqual(d.candidates[0]!.model.id, dead.id);
  });

  test("a rule for a model that does not exist is simply ignored", () => {
    const d = route(ALL, req({ preferences: [{ modelId: "nope:nope", providerId: null, reason: "your rule" }] }));
    assert.ok(d.candidates.length > 0);
  });
});

describe("rule validation", () => {
  const models = new Set(["anthropic:claude-sonnet"]);
  const providers = new Set(["anthropic", "openai"]);

  test("accepts a valid provider rule", () => {
    assert.equal(validateRuleTargets([rule({ id: "1", name: "ok", preferProviderId: "anthropic" })], models, providers), null);
  });

  test("rejects an unknown provider", () => {
    assert.match(validateRuleTargets([rule({ id: "1", name: "bad", preferProviderId: "nope" })], models, providers) ?? "", /unknown provider/i);
  });

  test("rejects an unknown model", () => {
    assert.match(validateRuleTargets([rule({ id: "1", name: "bad", preferModelId: "nope:nope" })], models, providers) ?? "", /unknown model/i);
  });

  test("rejects a rule with both targets", () => {
    const r = rule({ id: "1", name: "both", preferModelId: "anthropic:claude-sonnet", preferProviderId: "anthropic" });
    assert.match(validateRuleTargets([r], models, providers) ?? "", /choose one/i);
  });

  test("rejects a rule with no target", () => {
    assert.match(validateRuleTargets([rule({ id: "1", name: "empty" })], models, providers) ?? "", /no target/i);
  });

  test("rejects duplicate ids", () => {
    const rs = [
      rule({ id: "dup", name: "a", preferProviderId: "anthropic" }),
      rule({ id: "dup", name: "b", preferProviderId: "openai" }),
    ];
    assert.match(validateRuleTargets(rs, models, providers) ?? "", /unique/i);
  });

  test("schema rejects an unknown capability and caps the list length", () => {
    assert.equal(routingRulesSchema.safeParse({ rules: [{ id: "1", name: "x", whenCapability: "telepathy" }] }).success, false);
    const many = Array.from({ length: 51 }, (_, i) => ({ id: String(i), name: "x", whenCapability: "coding" }));
    assert.equal(routingRulesSchema.safeParse({ rules: many }).success, false);
  });
});
