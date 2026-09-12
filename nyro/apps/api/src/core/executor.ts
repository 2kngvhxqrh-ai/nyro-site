/**
 * Chat execution with fallback (spec §11, §23, §37, §79).
 *
 * Walks the router's ranked candidates until one succeeds. Two invariants this
 * must never break:
 *
 *  1. It only ever tries models the router returned. The router already removed
 *     everything that would violate privacy or a cost ceiling, so there is no
 *     path by which a local-only request reaches a cloud provider.
 *  2. A user cancellation is final. It is not a retryable error and must not
 *     trigger a fallback attempt.
 */
import type { EventBus } from "./events.ts";
import { NyroError } from "./errors.ts";
import type { Registry } from "./registry.ts";
import type {
  ChatMessage,
  ExecutionAttempt,
  ExecutionOutcome,
  ProviderChatChunk,
  RegisteredModel,
  RoutingDecision,
  TokenUsage,
} from "./types.ts";
import { logger } from "../util/logger.ts";
import type { RunRepo } from "../db/repos.ts";

const log = logger("executor");

export interface ExecuteOptions {
  decision: RoutingDecision;
  messages: ChatMessage[];
  conversationId: string | null;
  temperature?: number;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  /** Called for each token as it arrives. Absent = non-streaming. */
  onDelta?: (text: string) => void;
  /** Called when a fallback begins, so the UI can say so honestly. */
  onAttempt?: (info: { modelId: string; attemptIndex: number; isFallback: boolean }) => void;
}

/** Fallbacks are bounded: an unhealthy system should fail fast, not grind. */
const MAX_ATTEMPTS = 3;

export class Executor {
  private readonly registry: Registry;
  private readonly runs: RunRepo;
  private readonly bus: EventBus;

  constructor(registry: Registry, runs: RunRepo, bus: EventBus) {
    this.registry = registry;
    this.runs = runs;
    this.bus = bus;
  }

  async execute(opts: ExecuteOptions): Promise<ExecutionOutcome> {
    const { decision } = opts;
    if (decision.candidates.length === 0) {
      throw new NyroError(
        "no_eligible_model",
        "No configured model can serve this request. Check the Models page: a provider may be unreachable, or the request's privacy setting may exclude every available model.",
        { component: "executor", detail: JSON.stringify(decision.rejected.slice(0, 10)) },
      );
    }

    const attempts: ExecutionAttempt[] = [];
    const chain = decision.candidates.slice(0, MAX_ATTEMPTS);
    let lastError: NyroError | null = null;

    for (let i = 0; i < chain.length; i++) {
      const candidate = chain[i]!;
      const model = candidate.model;

      if (opts.signal?.aborted) {
        throw new NyroError("cancelled", "Request was cancelled.", { component: "executor" });
      }

      opts.onAttempt?.({ modelId: model.id, attemptIndex: i, isFallback: i > 0 });
      this.bus.emit({
        type: "model.requested",
        modelId: model.id,
        providerId: model.providerId,
        conversationId: opts.conversationId,
      });

      const startedAt = new Date().toISOString();
      const t0 = Date.now();

      try {
        const { content, usage } = await this.runOne(model, opts);
        const latencyMs = Date.now() - t0;
        const costUsd =
          (usage.inputTokens / 1_000_000) * model.inputCostPer1m +
          (usage.outputTokens / 1_000_000) * model.outputCostPer1m;

        attempts.push({ modelId: model.id, providerId: model.providerId, startedAt, latencyMs, ok: true });

        await this.runs.record({
          conversationId: opts.conversationId,
          modelId: model.id,
          providerId: model.providerId,
          routingMode: decision.mode,
          attemptIndex: i,
          ok: true,
          errorCode: null,
          latencyMs,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          costUsd,
        });

        this.bus.emit({
          type: "model.completed",
          modelId: model.id,
          latencyMs,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          costUsd,
        });

        return { content, usage, model, costUsd, decision, attempts };
      } catch (err) {
        const e = NyroError.from(err, "executor");
        const latencyMs = Date.now() - t0;

        attempts.push({
          modelId: model.id,
          providerId: model.providerId,
          startedAt,
          latencyMs,
          ok: false,
          errorCode: e.code,
          errorMessage: e.message,
        });

        await this.runs.record({
          conversationId: opts.conversationId,
          modelId: model.id,
          providerId: model.providerId,
          routingMode: decision.mode,
          attemptIndex: i,
          ok: false,
          errorCode: e.code,
          latencyMs,
          inputTokens: 0,
          outputTokens: 0,
          costUsd: 0,
        });

        this.bus.emit({ type: "model.failed", modelId: model.id, errorCode: e.code, latencyMs });

        // A cancellation is the user's decision, not a failure to route around.
        if (e.code === "cancelled") throw e;
        if (!e.retryable) throw e;

        log.warn("attempt failed, trying next candidate", { modelId: model.id, code: e.code, attempt: i });
        lastError = e;
      }
    }

    throw new NyroError(
      lastError?.code ?? "internal",
      `All ${chain.length} candidate model(s) failed. Last error: ${lastError?.message ?? "unknown"}`,
      { component: "executor", detail: lastError?.detail },
    );
  }

  private async runOne(
    model: RegisteredModel,
    opts: ExecuteOptions,
  ): Promise<{ content: string; usage: TokenUsage }> {
    const adapter = await this.registry.adapterFor(model.providerId);
    const req = {
      modelIdentifier: model.modelIdentifier,
      messages: opts.messages,
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
      maxOutputTokens: opts.maxOutputTokens ?? model.maxOutputTokens,
    };

    if (!opts.onDelta) {
      const result = await adapter.chat(req, opts.signal);
      return { content: result.content, usage: result.usage };
    }

    let content = "";
    let usage: TokenUsage = { inputTokens: 0, outputTokens: 0 };

    for await (const chunk of adapter.stream(req, opts.signal) as AsyncIterable<ProviderChatChunk>) {
      if (chunk.type === "delta") {
        content += chunk.text;
        opts.onDelta(chunk.text);
      } else if (chunk.type === "usage") {
        usage = chunk.usage;
      } else if (chunk.type === "done" && chunk.finishReason === "cancelled") {
        throw new NyroError("cancelled", "Request was cancelled.", { component: "executor" });
      }
    }

    // Some providers omit usage entirely; report 0 rather than inventing a
    // number, so cost totals stay honest (spec §131).
    return { content, usage };
  }
}
