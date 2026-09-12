/**
 * NYRO Core domain types.
 *
 * ARCHITECTURAL CONTRACT (spec §113, §114, §180):
 * Nothing in this file may reference a specific vendor, wire format, or SDK.
 * Provider adapters translate *into* these types; NYRO Core only ever sees these.
 * If you find yourself adding `openai_` or `ollama_` to a field name here, the
 * abstraction has leaked and the fix belongs in the adapter, not here.
 */

// ---------------------------------------------------------------------------
// Conversation primitives
// ---------------------------------------------------------------------------

export type Role = "system" | "user" | "assistant";

export interface ChatMessage {
  role: Role;
  content: string;
}

// ---------------------------------------------------------------------------
// Capabilities — what a task needs / what a model can do
// ---------------------------------------------------------------------------

export const CAPABILITIES = [
  "chat",
  "streaming",
  "reasoning",
  "coding",
  "vision",
  "tool_calling",
  "structured_output",
  "embedding",
  "long_context",
] as const;

export type Capability = (typeof CAPABILITIES)[number];

// ---------------------------------------------------------------------------
// Privacy classes (spec §67) — the constraint the router may never violate
// ---------------------------------------------------------------------------

export const PRIVACY_CLASSES = ["local_only", "sensitive", "normal", "public"] as const;
export type PrivacyClass = (typeof PRIVACY_CLASSES)[number];

// ---------------------------------------------------------------------------
// Routing (spec §9, §10)
// ---------------------------------------------------------------------------

export const ROUTING_MODES = [
  "auto",
  "manual",
  "cheapest",
  "fastest",
  "best",
  "local_only",
  "cloud_only",
] as const;
export type RoutingMode = (typeof ROUTING_MODES)[number];

export interface RoutingRequest {
  mode: RoutingMode;
  /** Explicit user override, e.g. "use Claude". Honoured unless impossible (spec §148). */
  requestedModelId?: string | null;
  requestedProviderId?: string | null;
  /**
   * HARD requirement. A model lacking any of these is excluded outright.
   * Use for things the request genuinely cannot work without (an image to
   * analyse needs vision; nothing can substitute).
   */
  requiredCapabilities: Capability[];
  /**
   * SOFT preference. Steers ranking but never excludes.
   *
   * This is where guessed intent belongs. NYRO inferring "this looks like a
   * reasoning question" must not cause a refusal when the only available model
   * is a small local one — answering with the best thing available beats
   * refusing to answer at all.
   */
  preferredCapabilities: Capability[];
  privacy: PrivacyClass;
  /** Approximate prompt size so we can reject models whose context is too small (spec §129). */
  estimatedInputTokens: number;
  /** Rough ceiling on output tokens, used for cost estimation only. */
  estimatedOutputTokens: number;
  /** Per-request hard cost ceiling in USD; candidates above it are excluded (spec §66). */
  maxCostUsd?: number | null;
}

export interface RoutingCandidate {
  model: RegisteredModel;
  score: number;
  estimatedCostUsd: number;
  /** Human-readable, short. Shown in the UI; never chain-of-thought (spec §59, §81). */
  reasons: string[];
}

export interface RoutingDecision {
  mode: RoutingMode;
  /** Ranked. [0] is the primary; the rest are the fallback chain (spec §11). */
  candidates: RoutingCandidate[];
  /** Models considered and dropped, with the rule that dropped them. */
  rejected: Array<{ modelId: string; reason: string }>;
}

// ---------------------------------------------------------------------------
// Model registry (spec §7)
// ---------------------------------------------------------------------------

export type HealthState = "healthy" | "degraded" | "unreachable" | "unknown";

export interface ModelScores {
  /** All 0..10. Heuristic defaults for unknown models; see providers/model-traits.ts. */
  speed: number;
  reasoning: number;
  coding: number;
  vision: number;
  tool_calling: number;
}

export interface RegisteredModel {
  /** Stable NYRO id: "<providerId>:<modelIdentifier>". */
  id: string;
  providerId: string;
  /** The string the provider's own API expects. */
  modelIdentifier: string;
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number;
  /** USD per 1M tokens. 0 for local models. */
  inputCostPer1m: number;
  outputCostPer1m: number;
  capabilities: Capability[];
  scores: ModelScores;
  /** True when inference happens on the user's own hardware (spec §1.5, §67). */
  local: boolean;
  enabled: boolean;
  health: HealthState;
}

// ---------------------------------------------------------------------------
// Provider-facing request/response (what adapters implement)
// ---------------------------------------------------------------------------

export interface ProviderChatRequest {
  modelIdentifier: string;
  messages: ChatMessage[];
  temperature?: number;
  maxOutputTokens?: number;
}

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface ProviderChatResult {
  content: string;
  usage: TokenUsage;
  /** What the provider said it used; may differ from what we asked for. */
  modelIdentifier: string;
  finishReason: "stop" | "length" | "cancelled" | "other";
}

export type ProviderChatChunk =
  | { type: "delta"; text: string }
  | { type: "usage"; usage: TokenUsage }
  | { type: "done"; finishReason: ProviderChatResult["finishReason"] };

export interface ProviderModelInfo {
  modelIdentifier: string;
  displayName?: string;
  contextWindow?: number;
}

export interface ProviderHealth {
  state: HealthState;
  latencyMs: number | null;
  detail: string;
  checkedAt: string;
}

export interface CostEstimate {
  inputCostUsd: number;
  outputCostUsd: number;
  totalCostUsd: number;
}

// ---------------------------------------------------------------------------
// Execution result handed back to the API layer
// ---------------------------------------------------------------------------

export interface ExecutionAttempt {
  modelId: string;
  providerId: string;
  startedAt: string;
  latencyMs: number;
  ok: boolean;
  errorCode?: string;
  errorMessage?: string;
}

export interface ExecutionOutcome {
  content: string;
  usage: TokenUsage;
  model: RegisteredModel;
  costUsd: number;
  decision: RoutingDecision;
  attempts: ExecutionAttempt[];
}
