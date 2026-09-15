/**
 * Model traits: turning a discovered model id into routable metadata.
 *
 * HONESTY NOTE (spec §131): these are heuristics derived from the model's name
 * and a small table of well-known families — they are NOT measured benchmarks.
 * Phase 13 (§13/§102) replaces them with observed latency and success rates
 * from the model_runs table. Every value here is overridable per-model in the
 * registry, and the `source` field says where a number came from so the UI can
 * be truthful about it.
 */
import type { Capability, ModelScores } from "../core/types.ts";

export interface ModelTraits {
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number;
  inputCostPer1m: number;
  outputCostPer1m: number;
  capabilities: Capability[];
  scores: ModelScores;
  source: "catalog" | "heuristic";
}

interface CatalogEntry {
  /** Matched case-insensitively against the model identifier. */
  match: RegExp;
  displayName?: string;
  contextWindow: number;
  maxOutputTokens: number;
  inputCostPer1m: number;
  outputCostPer1m: number;
  capabilities: Capability[];
  scores: ModelScores;
}

const BASE_CHAT: Capability[] = ["chat", "streaming"];

/**
 * Known families. Costs are list prices in USD per 1M tokens and drift over
 * time — they are used for *relative* routing decisions and rough budgeting,
 * not billing. Users can correct any of them in the Models UI.
 */
const CATALOG: CatalogEntry[] = [
  {
    match: /^claude.*opus/i,
    contextWindow: 200_000,
    maxOutputTokens: 32_000,
    inputCostPer1m: 15,
    outputCostPer1m: 75,
    capabilities: [...BASE_CHAT, "reasoning", "coding", "vision", "tool_calling", "structured_output", "long_context"],
    scores: { speed: 6, reasoning: 10, coding: 10, vision: 9, tool_calling: 10 },
  },
  {
    match: /^claude.*sonnet/i,
    contextWindow: 200_000,
    maxOutputTokens: 64_000,
    inputCostPer1m: 3,
    outputCostPer1m: 15,
    capabilities: [...BASE_CHAT, "reasoning", "coding", "vision", "tool_calling", "structured_output", "long_context"],
    scores: { speed: 8, reasoning: 9, coding: 9, vision: 9, tool_calling: 9 },
  },
  {
    match: /^claude.*haiku/i,
    contextWindow: 200_000,
    maxOutputTokens: 8_192,
    inputCostPer1m: 0.8,
    outputCostPer1m: 4,
    capabilities: [...BASE_CHAT, "reasoning", "coding", "vision", "tool_calling", "structured_output", "long_context"],
    scores: { speed: 9, reasoning: 7, coding: 7, vision: 8, tool_calling: 8 },
  },
  {
    match: /^gpt-4o-mini/i,
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    inputCostPer1m: 0.15,
    outputCostPer1m: 0.6,
    capabilities: [...BASE_CHAT, "reasoning", "coding", "vision", "tool_calling", "structured_output", "long_context"],
    scores: { speed: 9, reasoning: 6, coding: 6, vision: 7, tool_calling: 8 },
  },
  {
    match: /^gpt-4o/i,
    contextWindow: 128_000,
    maxOutputTokens: 16_384,
    inputCostPer1m: 2.5,
    outputCostPer1m: 10,
    capabilities: [...BASE_CHAT, "reasoning", "coding", "vision", "tool_calling", "structured_output", "long_context"],
    scores: { speed: 8, reasoning: 8, coding: 8, vision: 9, tool_calling: 9 },
  },
  {
    match: /^gemini.*flash/i,
    contextWindow: 1_000_000,
    maxOutputTokens: 8_192,
    inputCostPer1m: 0.1,
    outputCostPer1m: 0.4,
    capabilities: [...BASE_CHAT, "reasoning", "coding", "vision", "tool_calling", "structured_output", "long_context"],
    scores: { speed: 9, reasoning: 7, coding: 7, vision: 8, tool_calling: 8 },
  },
  {
    match: /^gemini.*pro/i,
    contextWindow: 2_000_000,
    maxOutputTokens: 8_192,
    inputCostPer1m: 1.25,
    outputCostPer1m: 5,
    capabilities: [...BASE_CHAT, "reasoning", "coding", "vision", "tool_calling", "structured_output", "long_context"],
    scores: { speed: 7, reasoning: 9, coding: 8, vision: 9, tool_calling: 8 },
  },
  {
    match: /^llama3\.2:1b/i,
    displayName: "Llama 3.2 1B",
    contextWindow: 131_072,
    maxOutputTokens: 4_096,
    inputCostPer1m: 0,
    outputCostPer1m: 0,
    capabilities: [...BASE_CHAT, "structured_output"],
    scores: { speed: 10, reasoning: 2, coding: 2, vision: 0, tool_calling: 1 },
  },
  {
    match: /^llama3\.2:3b/i,
    displayName: "Llama 3.2 3B",
    contextWindow: 131_072,
    maxOutputTokens: 4_096,
    inputCostPer1m: 0,
    outputCostPer1m: 0,
    capabilities: [...BASE_CHAT, "structured_output", "tool_calling"],
    scores: { speed: 9, reasoning: 3, coding: 3, vision: 0, tool_calling: 3 },
  },
  {
    match: /^qwen.*coder/i,
    contextWindow: 32_768,
    maxOutputTokens: 8_192,
    inputCostPer1m: 0,
    outputCostPer1m: 0,
    capabilities: [...BASE_CHAT, "coding", "structured_output", "tool_calling"],
    scores: { speed: 7, reasoning: 5, coding: 7, vision: 0, tool_calling: 5 },
  },
];

/** Parameter count parsed from a local tag like "llama3.1:70b" — our best size proxy. */
function parseParamBillions(identifier: string): number | null {
  const m = identifier.match(/[:\-_](\d+(?:\.\d+)?)\s*b\b/i);
  if (!m || m[1] === undefined) return null;
  const n = Number.parseFloat(m[1]);
  return Number.isFinite(n) ? n : null;
}

/**
 * Heuristic fallback for a model we have never seen.
 * Deliberately conservative: an unknown model gets mid-to-low quality scores so
 * the router does not hand it important work purely because it is cheap.
 */
function heuristicTraits(identifier: string, local: boolean, contextWindow?: number): ModelTraits {
  const params = parseParamBillions(identifier);
  const looksVision = /vision|vl\b|llava|multimodal|omni/i.test(identifier);
  const looksCoder = /cod(er|e)|dev|program/i.test(identifier);
  const looksTiny = params !== null && params <= 4;

  // Size → quality proxy: small local models are fast but weak.
  const qualityFromSize = params === null ? 5 : Math.max(1, Math.min(9, Math.round(Math.log2(params) * 1.6)));
  const speedFromSize = params === null ? 6 : Math.max(3, Math.min(10, 11 - Math.round(Math.log2(params) * 1.4)));

  const capabilities: Capability[] = [...BASE_CHAT, "structured_output"];
  if (looksVision) capabilities.push("vision");
  if (looksCoder) capabilities.push("coding");
  if (!looksTiny) capabilities.push("reasoning", "tool_calling");
  const ctx = contextWindow ?? (local ? 8_192 : 32_768);
  if (ctx >= 100_000) capabilities.push("long_context");

  return {
    displayName: identifier,
    contextWindow: ctx,
    maxOutputTokens: Math.min(8_192, Math.floor(ctx / 4)),
    // An unknown cloud model's price is unknown; 0 would make "cheapest" mode
    // pick it blindly, so we assume a mid-market price until the user corrects it.
    inputCostPer1m: local ? 0 : 1,
    outputCostPer1m: local ? 0 : 3,
    capabilities,
    scores: {
      speed: local ? speedFromSize : 7,
      reasoning: qualityFromSize,
      coding: looksCoder ? Math.min(10, qualityFromSize + 2) : qualityFromSize,
      vision: looksVision ? 6 : 0,
      tool_calling: looksTiny ? 1 : Math.max(1, qualityFromSize - 1),
    },
    source: "heuristic",
  };
}

export function traitsFor(identifier: string, local: boolean, contextWindow?: number): ModelTraits {
  // Strip an aggregator prefix like "anthropic/claude-..." before matching.
  const bare = identifier.includes("/") ? identifier.slice(identifier.lastIndexOf("/") + 1) : identifier;
  for (const entry of CATALOG) {
    if (entry.match.test(bare)) {
      return {
        displayName: entry.displayName ?? identifier,
        contextWindow: contextWindow ?? entry.contextWindow,
        maxOutputTokens: entry.maxOutputTokens,
        inputCostPer1m: local ? 0 : entry.inputCostPer1m,
        outputCostPer1m: local ? 0 : entry.outputCostPer1m,
        capabilities: [...entry.capabilities],
        scores: { ...entry.scores },
        source: "catalog",
      };
    }
  }
  return heuristicTraits(identifier, local, contextWindow);
}
