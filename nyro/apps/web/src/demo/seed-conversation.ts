/**
 * An opening exchange for the demo, so the page shows the thing it does
 * instead of an empty input box.
 *
 * It is a record of a routing decision the real router produces for this exact
 * prompt against the seeded registry — not an invented transcript. The reply
 * carries the same "[simulated]" prefix every other reply does, so nothing
 * here reads as a real model answer.
 */
import type { Turn } from "../components/Chat.tsx";
import { estimateMessagesTokens, route } from "./core-imports.ts";
import { seedModels } from "./seed.ts";
import { simulate } from "./simulated-provider.ts";

const PROMPT = "Refactor this Python function so it streams instead of loading the whole file.";

export function seedConversation(): Turn[] {
  const models = seedModels();
  const estimatedInputTokens = estimateMessagesTokens([{ role: "user", content: PROMPT }]);

  const decision = route(models, {
    mode: "auto",
    requestedModelId: null,
    requestedProviderId: null,
    requiredCapabilities: ["chat"],
    preferredCapabilities: ["coding"],
    privacy: "normal",
    estimatedInputTokens,
    estimatedOutputTokens: 800,
    maxCostUsd: null,
  });

  const first = decision.candidates[0];
  if (!first) return [];

  const run = simulate(first.model, PROMPT, estimatedInputTokens);
  const costUsd =
    (run.inputTokens / 1_000_000) * first.model.inputCostPer1m +
    (run.outputTokens / 1_000_000) * first.model.outputCostPer1m;

  return [
    { kind: "user", text: PROMPT },
    {
      kind: "assistant",
      text: run.text,
      decision: {
        mode: decision.mode,
        chosen: {
          modelId: first.model.id,
          displayName: first.model.displayName,
          providerId: first.model.providerId,
          local: first.model.local,
          estimatedCostUsd: first.estimatedCostUsd,
          reasons: first.reasons,
        },
        fallbacks: decision.candidates.slice(1, 3).map((c) => ({
          modelId: c.model.id,
          displayName: c.model.displayName,
          providerId: c.model.providerId,
          local: c.model.local,
        })),
        rejected: decision.rejected,
      },
      attempts: [{ modelId: first.model.id, isFallback: false }],
      usage: { inputTokens: run.inputTokens, outputTokens: run.outputTokens, costUsd },
      budget: null,
      latencyMs: null,
      error: null,
      streaming: false,
    },
  ];
}
