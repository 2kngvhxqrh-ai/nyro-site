/**
 * OpenAI-compatible adapter (/v1/models, /v1/chat/completions with SSE).
 *
 * One adapter, many providers. This single class backs OpenAI, Groq, Mistral,
 * OpenRouter, xAI, Google's OpenAI-compatible Gemini endpoint, Together,
 * DeepSeek, and any self-hosted server speaking the same protocol (vLLM,
 * llama.cpp, LM Studio, Ollama's own /v1 shim). Connecting one of those is a
 * row in providers/presets.ts plus an API key — no new code.
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
 * Tool calling, response_format and image parts are Phase 5 / Phase 11 work;
 * they are not listed because this adapter does not send them.
 * `reasoning` and `coding` are model properties and are set by the registry.
 */
const SUPPORTED: ReadonlySet<Capability> = new Set<Capability>(["chat", "streaming"]);

interface CompletionChoice {
  message?: { content?: string | null };
  delta?: { content?: string | null };
  finish_reason?: string | null;
}

interface CompletionFrame {
  choices?: CompletionChoice[];
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null;
}

function mapFinish(reason: string | null | undefined): ProviderChatResult["finishReason"] {
  if (reason === "length" || reason === "max_tokens") return "length";
  if (reason === "stop" || reason === "end_turn") return "stop";
  return reason ? "other" : "stop";
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly id: string;
  readonly displayName: string;
  readonly transport = "openai_compatible" as const;
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

  /** The key is read here and nowhere else, and is never returned or logged. */
  private headers(): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.cfg.apiKey) h["authorization"] = `Bearer ${this.cfg.apiKey}`;
    // OpenRouter asks for attribution headers; harmless elsewhere, so only set when present.
    const referer = this.cfg.extra["httpReferer"];
    const title = this.cfg.extra["xTitle"];
    if (referer) h["http-referer"] = referer;
    if (title) h["x-title"] = title;
    return h;
  }

  supports(capability: Capability): boolean {
    return SUPPORTED.has(capability);
  }

  estimateCost(usage: TokenUsage, inCost: number, outCost: number): CostEstimate {
    return estimateCostDefault(usage, inCost, outCost);
  }

  async listModels(signal?: AbortSignal): Promise<ProviderModelInfo[]> {
    const res = await providerFetch({
      url: this.url("/models"),
      headers: this.headers(),
      timeoutMs: this.cfg.requestTimeoutMs,
      signal,
      component: `provider:${this.id}`,
    });
    const body = (await res.json()) as { data?: Array<{ id?: string; context_length?: number }> };
    if (!Array.isArray(body.data)) {
      throw new NyroError("provider_bad_response", "Provider /models did not return a data array.", {
        component: `provider:${this.id}`,
      });
    }
    return body.data
      .filter((m): m is { id: string; context_length?: number } => typeof m.id === "string" && m.id.length > 0)
      .map((m) => ({
        modelIdentifier: m.id,
        displayName: m.id,
        ...(typeof m.context_length === "number" ? { contextWindow: m.context_length } : {}),
      }));
  }

  private payload(req: ProviderChatRequest, stream: boolean): Record<string, unknown> {
    return {
      model: req.modelIdentifier,
      messages: req.messages.map((m) => ({ role: m.role, content: m.content })),
      stream,
      // Ask for usage on the final SSE frame; providers that don't know this field ignore it.
      ...(stream ? { stream_options: { include_usage: true } } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.maxOutputTokens !== undefined ? { max_tokens: req.maxOutputTokens } : {}),
    };
  }

  async chat(req: ProviderChatRequest, signal?: AbortSignal): Promise<ProviderChatResult> {
    const res = await providerFetch({
      url: this.url("/chat/completions"),
      method: "POST",
      headers: this.headers(),
      body: this.payload(req, false),
      timeoutMs: this.cfg.requestTimeoutMs,
      signal,
      component: `provider:${this.id}`,
    });
    const body = (await res.json()) as CompletionFrame;
    const choice = body.choices?.[0];
    const content = choice?.message?.content;
    if (typeof content !== "string") {
      throw new NyroError("provider_bad_response", "Provider response had no choices[0].message.content.", {
        component: `provider:${this.id}`,
      });
    }
    return {
      content,
      usage: {
        inputTokens: body.usage?.prompt_tokens ?? 0,
        outputTokens: body.usage?.completion_tokens ?? 0,
      },
      modelIdentifier: req.modelIdentifier,
      finishReason: mapFinish(choice?.finish_reason),
    };
  }

  async *stream(req: ProviderChatRequest, signal?: AbortSignal): AsyncIterable<ProviderChatChunk> {
    const res = await providerFetch({
      url: this.url("/chat/completions"),
      method: "POST",
      headers: { ...this.headers(), accept: "text/event-stream" },
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
      if (!line.startsWith("data:")) continue; // ignore `event:`/`id:`/comment lines
      const data = line.slice(5).trim();
      if (data === "[DONE]") break;

      let frame: CompletionFrame;
      try {
        frame = JSON.parse(data) as CompletionFrame;
      } catch {
        continue;
      }
      const choice = frame.choices?.[0];
      const text = choice?.delta?.content;
      if (typeof text === "string" && text.length > 0) {
        yield { type: "delta", text };
      }
      if (choice?.finish_reason) finish = mapFinish(choice.finish_reason);
      if (frame.usage) {
        usage = {
          inputTokens: frame.usage.prompt_tokens ?? 0,
          outputTokens: frame.usage.completion_tokens ?? 0,
        };
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
        detail: `${models.length} model(s) listed`,
        checkedAt: new Date().toISOString(),
      };
    } catch (err) {
      const e = NyroError.from(err, `provider:${this.id}`);
      const unreachable = e.code === "provider_unreachable" || e.code === "provider_timeout";
      return {
        state: unreachable ? "unreachable" : "degraded",
        latencyMs: Date.now() - startedAt,
        detail: `${e.code}: ${e.message} (${safeOrigin(this.cfg.baseUrl)})`,
        checkedAt: new Date().toISOString(),
      };
    }
  }
}
