/**
 * Ollama adapter — Ollama's *native* API (/api/tags, /api/chat), which streams
 * newline-delimited JSON rather than SSE.
 *
 * Ollama is one provider among several. Nothing here is imported by core/.
 */
import { NyroError } from "../core/errors.ts";
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
import { providerFetch, readLines, safeOrigin } from "../util/http-client.ts";
import { estimateCostDefault, type ModelProvider, type ProviderConfig } from "./provider.ts";

/**
 * TRANSPORT capabilities only — what this adapter actually implements today.
 *
 * Ollama's API also supports tool calling, structured output via `format`, and
 * vision models, but this adapter does not yet send any of those. Advertising
 * them would make the router select this provider for work it cannot do, so
 * they stay out until the adapter genuinely carries them (Phase 5 / Phase 11).
 */
const SUPPORTED: ReadonlySet<Capability> = new Set<Capability>(["chat", "streaming"]);

interface OllamaChatFrame {
  message?: { content?: string };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
}

export class OllamaProvider implements ModelProvider {
  readonly id: string;
  readonly displayName: string;
  readonly transport = "ollama" as const;
  readonly local: boolean;
  private readonly cfg: ProviderConfig;

  constructor(cfg: ProviderConfig) {
    this.cfg = cfg;
    this.id = cfg.id;
    this.displayName = cfg.displayName;
    this.local = cfg.local;
  }

  private url(path: string): string {
    return `${this.cfg.baseUrl.replace(/\/+$/, "")}${path}`;
  }

  supports(capability: Capability): boolean {
    return SUPPORTED.has(capability);
  }

  estimateCost(usage: TokenUsage, inCost: number, outCost: number): CostEstimate {
    // Local inference has no per-token price; the preset sets both to 0.
    return estimateCostDefault(usage, inCost, outCost);
  }

  async listModels(signal?: AbortSignal): Promise<ProviderModelInfo[]> {
    const res = await providerFetch({
      url: this.url("/api/tags"),
      timeoutMs: this.cfg.requestTimeoutMs,
      signal,
      component: `provider:${this.id}`,
    });
    const body = (await res.json()) as { models?: Array<{ name?: string; details?: { parameter_size?: string } }> };
    if (!Array.isArray(body.models)) {
      throw new NyroError("provider_bad_response", "Ollama /api/tags did not return a models array.", {
        component: `provider:${this.id}`,
      });
    }
    return body.models
      .filter((m): m is { name: string } => typeof m.name === "string" && m.name.length > 0)
      .map((m) => ({ modelIdentifier: m.name, displayName: m.name }));
  }

  private payload(req: ProviderChatRequest, stream: boolean): Record<string, unknown> {
    const options: Record<string, unknown> = {};
    if (req.temperature !== undefined) options["temperature"] = req.temperature;
    if (req.maxOutputTokens !== undefined) options["num_predict"] = req.maxOutputTokens;
    return {
      model: req.modelIdentifier,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      stream,
      ...(Object.keys(options).length > 0 ? { options } : {}),
    };
  }

  async chat(req: ProviderChatRequest, signal?: AbortSignal): Promise<ProviderChatResult> {
    const res = await providerFetch({
      url: this.url("/api/chat"),
      method: "POST",
      body: this.payload(req, false),
      timeoutMs: this.cfg.requestTimeoutMs,
      signal,
      component: `provider:${this.id}`,
    });
    const frame = (await res.json()) as OllamaChatFrame;
    const content = frame.message?.content;
    if (typeof content !== "string") {
      throw new NyroError("provider_bad_response", "Ollama response did not contain message.content.", {
        component: `provider:${this.id}`,
      });
    }
    return {
      content,
      usage: {
        inputTokens: frame.prompt_eval_count ?? 0,
        outputTokens: frame.eval_count ?? 0,
      },
      modelIdentifier: req.modelIdentifier,
      finishReason: frame.done_reason === "length" ? "length" : "stop",
    };
  }

  async *stream(req: ProviderChatRequest, signal?: AbortSignal): AsyncIterable<ProviderChatChunk> {
    const res = await providerFetch({
      url: this.url("/api/chat"),
      method: "POST",
      body: this.payload(req, true),
      timeoutMs: this.cfg.requestTimeoutMs,
      signal,
      component: `provider:${this.id}`,
    });

    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let finish: ProviderChatResult["finishReason"] = "stop";

    for await (const line of readLines(res, signal)) {
      if (signal?.aborted) {
        yield { type: "done", finishReason: "cancelled" };
        return;
      }
      let frame: OllamaChatFrame;
      try {
        frame = JSON.parse(line) as OllamaChatFrame;
      } catch {
        // A partial or non-JSON keepalive line is not fatal; skip it.
        continue;
      }
      const text = frame.message?.content;
      if (typeof text === "string" && text.length > 0) {
        yield { type: "delta", text };
      }
      if (frame.done === true) {
        usage = {
          inputTokens: frame.prompt_eval_count ?? 0,
          outputTokens: frame.eval_count ?? 0,
        };
        finish = frame.done_reason === "length" ? "length" : "stop";
      }
    }

    if (signal?.aborted) {
      yield { type: "done", finishReason: "cancelled" };
      return;
    }
    yield { type: "usage", usage };
    yield { type: "done", finishReason: finish };
  }

  async healthCheck(signal?: AbortSignal): Promise<ProviderHealth> {
    const startedAt = Date.now();
    try {
      const models = await this.listModels(signal);
      return {
        state: models.length > 0 ? "healthy" : "degraded",
        latencyMs: Date.now() - startedAt,
        detail: models.length > 0 ? `${models.length} model(s) available` : "Reachable, but no models are pulled",
        checkedAt: new Date().toISOString(),
      };
    } catch (err) {
      const e = NyroError.from(err, `provider:${this.id}`);
      return {
        state: e.code === "provider_unreachable" || e.code === "provider_timeout" ? "unreachable" : "degraded",
        latencyMs: Date.now() - startedAt,
        detail: `${e.code}: ${e.message} (${safeOrigin(this.cfg.baseUrl)})`,
        checkedAt: new Date().toISOString(),
      };
    }
  }
}
