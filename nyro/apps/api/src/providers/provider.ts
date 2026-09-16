/**
 * The provider boundary (spec §5, §6, §183).
 *
 * NYRO Core depends on THIS interface and nothing below it. Adding a provider
 * means: write an adapter, register a factory in providers/index.ts, add tests.
 * No file in core/ changes. That property is what §152 asks for and what the
 * tests in test/providers.test.ts are there to protect.
 */
import type {
  Capability,
  CostEstimate,
  ProviderChatChunk,
  ProviderChatRequest,
  ProviderChatResult,
  ProviderHealth,
  ProviderModelInfo,
  TokenUsage,
} from "../core/types.ts";

/** How a provider is reached. Drives which config fields are required. */
export type ProviderTransport = "ollama" | "openai_compatible" | "anthropic" | "mock";

export interface ProviderConfig {
  /** Stable instance id, e.g. "ollama", "openai", "my-vllm-box". User-chosen for custom providers. */
  id: string;
  displayName: string;
  transport: ProviderTransport;
  baseUrl: string;
  /** Decrypted at the last possible moment; null when the provider needs no auth. */
  apiKey: string | null;
  /** True when inference runs on the user's hardware. Set from the preset, not guessed. */
  local: boolean;
  requestTimeoutMs: number;
  /** Free-form per-transport knobs (e.g. Anthropic version header). */
  extra: Record<string, string>;
}

export interface ModelProvider {
  readonly id: string;
  readonly displayName: string;
  readonly transport: ProviderTransport;
  readonly local: boolean;

  /** Dynamic discovery (spec §7: the registry must not be hard-coded). */
  listModels(signal?: AbortSignal): Promise<ProviderModelInfo[]>;

  chat(req: ProviderChatRequest, signal?: AbortSignal): Promise<ProviderChatResult>;

  /** Must be cancellable: the consumer may stop iterating at any point (spec §37, §83). */
  stream(req: ProviderChatRequest, signal?: AbortSignal): AsyncIterable<ProviderChatChunk>;

  healthCheck(signal?: AbortSignal): Promise<ProviderHealth>;

  supports(capability: Capability): boolean;

  estimateCost(usage: TokenUsage, inputCostPer1m: number, outputCostPer1m: number): CostEstimate;
}

/**
 * Capability ownership.
 *
 * A capability is either something the ADAPTER implements (can it send an
 * image? can it stream? can it carry a tool definition?) or something the
 * MODEL is (is it good at reasoning? at code? how much context?).
 *
 * Conflating the two is a real bug, not a nicety: intersecting a coder model's
 * "coding" capability with an adapter's transport list strips it, and the
 * router then refuses to use the right model for the job.
 */
export const TRANSPORT_CAPABILITIES: readonly Capability[] = [
  "chat",
  "streaming",
  "vision",
  "tool_calling",
  "structured_output",
  "embedding",
];

/** Set by the model registry from model traits. No transport can grant or revoke these. */
export const MODEL_CAPABILITIES: readonly Capability[] = ["reasoning", "coding", "long_context"];

export function isTransportCapability(c: Capability): boolean {
  return TRANSPORT_CAPABILITIES.includes(c);
}

/** Shared default; adapters inherit it rather than each reimplementing arithmetic. */
export function estimateCostDefault(
  usage: TokenUsage,
  inputCostPer1m: number,
  outputCostPer1m: number,
): CostEstimate {
  const inputCostUsd = (usage.inputTokens / 1_000_000) * inputCostPer1m;
  const outputCostUsd = (usage.outputTokens / 1_000_000) * outputCostPer1m;
  return {
    inputCostUsd,
    outputCostUsd,
    totalCostUsd: inputCostUsd + outputCostUsd,
  };
}
