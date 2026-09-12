/**
 * Task-specific routing rules (spec §10, §147, §148).
 *
 * Lets the user say "coding goes to Claude, quick things go to Ollama" without
 * pinning a model on every request.
 *
 * THE IMPORTANT DESIGN DECISION: a rule is a PREFERENCE, never a constraint.
 * It boosts a candidate's score; it cannot add one the router already excluded.
 * That single choice gives three properties for free:
 *
 *   - A rule can never breach privacy. Privacy is an eligibility filter that
 *     runs first, so a rule pointing at a cloud model simply has nothing to
 *     boost on a local-only request.
 *   - A rule can never cause a hard failure. If the preferred model is
 *     unreachable or disabled, routing continues normally instead of erroring.
 *   - A rule can never exceed a budget, for the same reason.
 *
 * Spec §147 warns against an opaque system the user cannot override. Rules are
 * the opposite: they are the user's own override, and the decision reports
 * which rule applied and why.
 */
import { z } from "zod";
import { CAPABILITIES } from "./types.ts";
import type { Capability } from "./types.ts";

export const routingRuleSchema = z.object({
  id: z.string().min(1).max(64),
  enabled: z.boolean().default(true),
  /** Human label, shown in the routing explanation. */
  name: z.string().min(1).max(120),
  /** Fires when the request wants this capability (required or inferred). */
  whenCapability: z.enum(CAPABILITIES),
  /** Exactly one target; a model is more specific than a provider. */
  preferModelId: z.string().min(1).nullable().default(null),
  preferProviderId: z.string().min(1).nullable().default(null),
});

export type RoutingRule = z.infer<typeof routingRuleSchema>;

export const routingRulesSchema = z.object({
  rules: z.array(routingRuleSchema).max(50).default([]),
});

export type RoutingRules = z.infer<typeof routingRulesSchema>;

export const DEFAULT_ROUTING_RULES: RoutingRules = { rules: [] };

/** A scoring nudge the router applies to candidates it has already accepted. */
export interface RoutingPreference {
  modelId: string | null;
  providerId: string | null;
  /** Shown to the user as part of the routing explanation. */
  reason: string;
}

/**
 * Turns the configured rules into preferences for one request.
 *
 * Earlier rules win: the first matching rule for a given capability is the one
 * that applies, so reordering is how a user expresses precedence.
 */
export function preferencesFor(
  rules: RoutingRule[],
  wantedCapabilities: Capability[],
): RoutingPreference[] {
  const wanted = new Set(wantedCapabilities);
  const seenCapabilities = new Set<Capability>();
  const out: RoutingPreference[] = [];

  for (const rule of rules) {
    if (!rule.enabled) continue;
    if (!wanted.has(rule.whenCapability)) continue;
    if (seenCapabilities.has(rule.whenCapability)) continue;
    if (rule.preferModelId === null && rule.preferProviderId === null) continue;

    seenCapabilities.add(rule.whenCapability);
    out.push({
      modelId: rule.preferModelId,
      providerId: rule.preferProviderId,
      reason: `your rule "${rule.name}"`,
    });
  }
  return out;
}

/** Validation that needs the registry, so it lives outside the zod schema. */
export function validateRuleTargets(
  rules: RoutingRule[],
  knownModelIds: Set<string>,
  knownProviderIds: Set<string>,
): string | null {
  for (const rule of rules) {
    if (rule.preferModelId !== null && rule.preferProviderId !== null) {
      return `Rule "${rule.name}" targets both a model and a provider; choose one.`;
    }
    if (rule.preferModelId === null && rule.preferProviderId === null) {
      return `Rule "${rule.name}" has no target.`;
    }
    if (rule.preferModelId !== null && !knownModelIds.has(rule.preferModelId)) {
      return `Rule "${rule.name}" points at unknown model "${rule.preferModelId}".`;
    }
    if (rule.preferProviderId !== null && !knownProviderIds.has(rule.preferProviderId)) {
      return `Rule "${rule.name}" points at unknown provider "${rule.preferProviderId}".`;
    }
  }
  const ids = rules.map((r) => r.id);
  if (new Set(ids).size !== ids.length) return "Rule ids must be unique.";
  return null;
}
