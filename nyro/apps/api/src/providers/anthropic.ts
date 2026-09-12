/**
 * Anthropic adapter (/v1/messages).
 *
 * This adapter exists partly to keep NYRO honest. Anthropic's wire format
 * differs from OpenAI's in ways that would break a "generic" layer that was
 * secretly OpenAI-shaped: system prompts are a top-level field rather than a
 * message, auth is `x-api-key` not `Authorization: Bearer`, max_tokens is
 * required, streaming uses typed SSE events, and input/output token counts
 * arrive on two different events. If NYRO Core ever needs to know any of that,
 * the abstraction has failed.
 */
import { NyroError } from "../core/errors.ts";
import type {
  Capability,
  ChatMessage,
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
 * Anthropic's API supports tools and image blocks; this adapter sends neither
 * yet, so it does not claim them. `reasoning`, `coding` and `long_context` are
 * model properties set by the registry, not by this list.
 */
const SUPPORTED: ReadonlySet<Capability> = new Set<Capability>(["chat", "streaming"]);

const DEFAULT_VERSION = "2023-06-01";
/** Anthropic requires max_tokens; this is only the floor when the caller gives none. */
const DEFAULT_MAX_TOKENS = 4096;

interface AnthropicStreamEvent {
  type?: string;
  delta?: { text?: string; stop_reason?: string | null };
  message?: { usage?: { input_tokens?: number; output_tokens?: number }; stop_reason?: string | null };
  usage?: { input_tokens?: number; output_tokens?: number };
  content_block?: { type?: string };
}

/** Splits the system prompt out of the message list — an Anthropic-shaped concern. */
function splitSystem(messages: ChatMessage[]): { system: string | null; rest: ChatMessage[] } {
  const systems = messages.filter((m) => m.role === "system").map((m) => m.content);
  const rest = messages.filter((m) => m.role !== "system");
  return { system: systems.length > 0 ? systems.join("\n\n") : null, rest };
}

function mapStop(reason: string | null | undefined): ProviderChatResult["finishReason"] {
  if (reason === "max_tokens") return "length";
  if (reason === "end_turn" || reason === "stop_sequence") return "stop";
  return reason ? "other" : "stop";
}

export class AnthropicProvider implements ModelProvider {
  readonly id: string;
  readonly displayName: string;
  readonly transport = "anthropic" as const;
  readonly local = false;
  private readonly cfg: ProviderConfig;

  constructor(cfg: ProviderConfig) {
    this.cfg = cfg;
    this.id = cfg.id;
    this.displayName = cfg.displayName;
  }

  private url(path: string): string {
    return `${this.cfg.baseUrl.replace(/\/+$/, "")}${path}`;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      "anthropic-version": this.cfg.extra["anthropicVersion"] ?? DEFAULT_VERSION,
    };
    if (this.cfg.apiKey) h["x-api-key"] = this.cfg.apiKey;
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
    const body = (await res.json()) as { data?: Array<{ id?: string; display_name?: string }> };
    if (!Array.isArray(body.data)) {
      throw new NyroError("provider_bad_response", "Anthropic /v1/models did not return a data array.", {
        component: `provider:${this.id}`,
      });
    }
    return body.data
      .filter((m): m is { id: string; display_name?: string } => typeof m.id === "string" && m.id.length > 0)
      .map((m) => ({ modelIdentifier: m.id, displayName: m.display_name ?? m.id }));
  }

  private payload(req: ProviderChatRequest, stream: boolean): Record<string, unknown> {
    const { system, rest } = splitSystem(req.messages);
    return {
      model: req.modelIdentifier,
      max_tokens: req.maxOutputTokens ?? DEFAULT_MAX_TOKENS,
      messages: rest.map((m) => ({ role: m.role, content: m.content })),
      ...(system ? { system } : {}),
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(stream ? { stream: true } : {}),
    };
  }

  async chat(req: ProviderChatRequest, signal?: AbortSignal): Promise<ProviderChatResult> {
    const res = await providerFetch({
      url: this.url("/messages"),
      method: "POST",
      headers: this.headers(),
      body: this.payload(req, false),
      timeoutMs: this.cfg.requestTimeoutMs,
      signal,
      component: `provider:${this.id}`,
    });
    const body = (await res.json()) as {
      content?: Array<{ type?: string; text?: string }>;
      usage?: { input_tokens?: number; output_tokens?: number };
      stop_reason?: string | null;
    };
    if (!Array.isArray(body.content)) {
      throw new NyroError("provider_bad_response", "Anthropic response had no content array.", {
        component: `provider:${this.id}`,
      });
    }
    const text = body.content
      .filter((b) => b.type === "text" && typeof b.text === "string")
      .map((b) => b.text as string)
      .join("");
    return {
      content: text,
      usage: {
        inputTokens: body.usage?.input_tokens ?? 0,
        outputTokens: body.usage?.output_tokens ?? 0,
      },
      modelIdentifier: req.modelIdentifier,
      finishReason: mapStop(body.stop_reason),
    };
  }

  async *stream(req: ProviderChatRequest, signal?: AbortSignal): AsyncIterable<ProviderChatChunk> {
    const res = await providerFetch({
      url: this.url("/messages"),
      method: "POST",
      headers: { ...this.headers(), accept: "text/event-stream" },
      body: this.payload(req, true),
      timeoutMs: this.cfg.requestTimeoutMs,
      signal,
      component: `provider:${this.id}`,
    });

    // input_tokens arrive on message_start; output_tokens on message_delta.
    const usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };
    let finish: ProviderChatResult["finishReason"] = "stop";

    for await (const line of readLines(res, signal)) {
      if (signal?.aborted) {
        yield { type: "done", finishReason: "cancelled" };
        return;
      }
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") break;

      let evt: AnthropicStreamEvent;
      try {
        evt = JSON.parse(data) as AnthropicStreamEvent;
      } catch {
        continue;
      }

      switch (evt.type) {
        case "message_start":
          usage.inputTokens = evt.message?.usage?.input_tokens ?? 0;
          usage.outputTokens = evt.message?.usage?.output_tokens ?? 0;
          break;
        case "content_block_delta":
          if (typeof evt.delta?.text === "string" && evt.delta.text.length > 0) {
            yield { type: "delta", text: evt.delta.text };
          }
          break;
        case "message_delta":
          if (evt.usage?.output_tokens !== undefined) usage.outputTokens = evt.usage.output_tokens;
          if (evt.delta?.stop_reason !== undefined) finish = mapStop(evt.delta.stop_reason);
          break;
        case "error":
          throw new NyroError("provider_bad_response", "Anthropic stream reported an error event.", {
            component: `provider:${this.id}`,
            detail: data.slice(0, 400),
          });
        default:
          break;
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
