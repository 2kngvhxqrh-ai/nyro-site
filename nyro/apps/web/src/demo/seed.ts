/**
 * Seed registry for the browser demo.
 *
 * These describe models that really exist, with traits produced by the REAL
 * `traitsFor()` catalog — the same function the server uses after discovery.
 * What is fake is only that no discovery call happened: a browser cannot reach
 * a provider. Prices are list prices and drift; they are here to make relative
 * routing decisions meaningful, not to be quoted.
 */
import { traitsFor, type RegisteredModel } from "./core-imports.ts";

interface SeedSpec {
  providerId: string;
  identifier: string;
  local: boolean;
  health?: RegisteredModel["health"];
}

const SEEDS: SeedSpec[] = [
  { providerId: "ollama", identifier: "llama3.2:1b", local: true },
  { providerId: "ollama", identifier: "qwen2.5-coder:7b", local: true },
  { providerId: "anthropic", identifier: "claude-sonnet-4", local: false },
  { providerId: "anthropic", identifier: "claude-haiku-4", local: false },
  { providerId: "openai", identifier: "gpt-4o", local: false },
  { providerId: "openai", identifier: "gpt-4o-mini", local: false },
  { providerId: "google", identifier: "gemini-2.0-flash", local: false },
  { providerId: "groq", identifier: "llama-3.3-70b", local: false, health: "degraded" },
];

export function seedModels(): RegisteredModel[] {
  return SEEDS.map((s) => {
    const t = traitsFor(s.identifier, s.local);
    return {
      id: `${s.providerId}:${s.identifier}`,
      providerId: s.providerId,
      modelIdentifier: s.identifier,
      displayName: t.displayName === s.identifier ? s.identifier : t.displayName,
      contextWindow: t.contextWindow,
      maxOutputTokens: t.maxOutputTokens,
      inputCostPer1m: t.inputCostPer1m,
      outputCostPer1m: t.outputCostPer1m,
      // Browser demo has no adapters, so no transport gating is applied here.
      // The consequence is visible and intended: vision/tool_calling appear for
      // models whose catalog entry claims them, which is what the registry
      // would hold once an adapter implements them.
      capabilities: t.capabilities,
      scores: t.scores,
      local: s.local,
      enabled: true,
      health: s.health ?? "healthy",
    };
  });
}

export interface SeedProvider {
  id: string;
  displayName: string;
  local: boolean;
  transport: string;
  health: RegisteredModel["health"];
  detail: string;
}

export const SEED_PROVIDERS: SeedProvider[] = [
  { id: "ollama", displayName: "Ollama", local: true, transport: "ollama", health: "healthy", detail: "2 model(s) available" },
  { id: "anthropic", displayName: "Anthropic", local: false, transport: "anthropic", health: "healthy", detail: "2 model(s) listed" },
  { id: "openai", displayName: "OpenAI", local: false, transport: "openai_compatible", health: "healthy", detail: "2 model(s) listed" },
  { id: "google", displayName: "Google Gemini", local: false, transport: "openai_compatible", health: "healthy", detail: "1 model(s) listed" },
  { id: "groq", displayName: "Groq", local: false, transport: "openai_compatible", health: "degraded", detail: "provider reported degraded health" },
];
