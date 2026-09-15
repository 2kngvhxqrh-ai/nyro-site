/**
 * MOCK PROVIDER — NOT A REAL MODEL.
 *
 * Clearly marked as mock per spec §175/§176. It exists for two reasons:
 *   1. Deterministic tests of Core (router, executor, SSE) with no network.
 *   2. Letting a fresh install prove the full UI → API → Core → Router →
 *      Provider → Response path before any real provider is configured.
 *
 * It is registered as `local: true` because it runs in-process, but it is
 * disabled unless NYRO_ENABLE_MOCK_PROVIDER=true, and every surface that shows
 * it (registry, /api/providers, UI) labels it a mock. It must never be
 * presented to the user as a real model.
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
import { estimateCostDefault, type ModelProvider, type ProviderConfig } from "./provider.ts";
import { estimateMessagesTokens, estimateTokens } from "../util/tokens.ts";
import { NyroError } from "../core/errors.ts";

export const MOCK_MODEL_ID = "nyro-mock-echo";
/** Sending this exact text makes the mock fail — used to test the fallback chain. */
export const MOCK_FAIL_TRIGGER = "__nyro_mock_fail__";

const SUPPORTED: ReadonlySet<Capability> = new Set<Capability>(["chat", "streaming"]);

export class MockProvider implements ModelProvider {
  readonly id: string;
  readonly displayName: string;
  readonly transport = "mock" as const;
  readonly local = true;
  private readonly cfg: ProviderConfig;

  constructor(cfg: ProviderConfig) {
    this.cfg = cfg;
    this.id = cfg.id;
    this.displayName = cfg.displayName;
  }

  supports(capability: Capability): boolean {
    return SUPPORTED.has(capability);
  }

  estimateCost(usage: TokenUsage, inCost: number, outCost: number): CostEstimate {
    return estimateCostDefault(usage, inCost, outCost);
  }

  async listModels(): Promise<ProviderModelInfo[]> {
    return [{ modelIdentifier: MOCK_MODEL_ID, displayName: "Mock Echo (not a real model)", contextWindow: 8192 }];
  }

  /** Deterministic, obviously-synthetic output. Never phrased as a real answer. */
  private render(req: ProviderChatRequest): string {
    const lastUser = [...req.messages].reverse().find((m) => m.role === "user");
    const text = lastUser?.content ?? "";
    if (text.includes(MOCK_FAIL_TRIGGER)) {
      throw new NyroError("provider_bad_response", "Mock provider failed on purpose (fallback test trigger).", {
        component: `provider:${this.id}`,
      });
    }
    return `[mock provider — not a real model] received ${text.length} chars via model "${req.modelIdentifier}".`;
  }

  async chat(req: ProviderChatRequest): Promise<ProviderChatResult> {
    const content = this.render(req);
    return {
      content,
      usage: { inputTokens: estimateMessagesTokens(req.messages), outputTokens: estimateTokens(content) },
      modelIdentifier: req.modelIdentifier,
      finishReason: "stop",
    };
  }

  async *stream(req: ProviderChatRequest, signal?: AbortSignal): AsyncIterable<ProviderChatChunk> {
    const content = this.render(req);
    const words = content.split(/(\s+)/).filter((w) => w.length > 0);
    for (const w of words) {
      if (signal?.aborted) {
        yield { type: "done", finishReason: "cancelled" };
        return;
      }
      // A small delay so the UI's streaming path is exercised realistically.
      await new Promise((r) => setTimeout(r, 8));
      yield { type: "delta", text: w };
    }
    yield {
      type: "usage",
      usage: { inputTokens: estimateMessagesTokens(req.messages), outputTokens: estimateTokens(content) },
    };
    yield { type: "done", finishReason: "stop" };
  }

  async healthCheck(): Promise<ProviderHealth> {
    return {
      state: "healthy",
      latencyMs: 0,
      detail: "Mock provider (in-process, not a real model)",
      checkedAt: new Date().toISOString(),
    };
  }
}
