/**
 * In-browser NYRO core (demo mode).
 *
 * Implements the same HTTP surface the real UI already calls, so the React app
 * runs completely unmodified — it cannot tell the difference, which is the
 * point: the UI genuinely has no provider knowledge (spec §113).
 *
 * REAL here:  the router (bundled from apps/api/src/core/router.ts), model
 *             traits, token estimation, the fallback walk, privacy
 *             enforcement, cost arithmetic, error taxonomy, SSE event order.
 * FAKE here:  model replies (nothing is inferred), persistence (memory, not
 *             Postgres), and discovery (a browser cannot reach a provider).
 *
 * Every fake part is labelled in the UI. Nothing leaves the page.
 */
import { estimateMessagesTokens, route, type Capability, type ChatMessage, type RegisteredModel, type RoutingDecision } from "./core-imports.ts";
import { seedModels, SEED_PROVIDERS } from "./seed.ts";
import { shouldFail, simulate } from "./simulated-provider.ts";

// ---------------------------------------------------------------------------
// In-memory state (the demo's stand-in for Postgres)
// ---------------------------------------------------------------------------

let models: RegisteredModel[] = seedModels();
const conversations = new Map<string, Array<{ id: string; role: string; content: string; modelId: string | null; createdAt: string }>>();
const conversationMeta = new Map<string, { title: string; createdAt: string; updatedAt: string }>();

interface Run {
  modelId: string; ok: boolean; errorCode: string | null; latencyMs: number;
  inputTokens: number; outputTokens: number; costUsd: number;
}
const runs: Run[] = [];

function uuid(): string {
  return crypto.randomUUID();
}

function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function errorResponse(status: number, code: string, message: string): Response {
  return jsonResponse(status, {
    error: { code, message, component: "browser-demo", retryable: false, timestamp: new Date().toISOString() },
  });
}

// ---------------------------------------------------------------------------
// Routing + execution, mirroring core/chat-service.ts and core/executor.ts
// ---------------------------------------------------------------------------

/** Same keyword pass as the server, and — critically — still only PREFERENCES. */
function inferPreferred(message: string): Capability[] {
  const caps = new Set<Capability>();
  if (/\b(code|function|refactor|debug|typescript|python|sql|stack ?trace|compile)\b/i.test(message)) caps.add("coding");
  if (/\b(analyse|analyze|why|explain|compare|trade-?off|design|architect|prove)\b/i.test(message)) caps.add("reasoning");
  return [...caps];
}

interface ChatBody {
  message: string; conversationId: string | null; mode: string; privacy: string;
  modelId: string | null; providerId: string | null; systemPrompt: string | null;
  temperature: number | null; maxCostUsd: number | null; requiredCapabilities: Capability[];
}

function plan(body: ChatBody, history: ChatMessage[]): { decision: RoutingDecision; estimatedInputTokens: number } {
  const messages: ChatMessage[] = [];
  if (body.systemPrompt) messages.push({ role: "system", content: body.systemPrompt });
  messages.push(...history);
  messages.push({ role: "user", content: body.message });

  const estimatedInputTokens = estimateMessagesTokens(messages);

  const decision = route(models.filter((m) => m.enabled), {
    mode: body.mode as never,
    requestedModelId: body.modelId,
    requestedProviderId: body.providerId,
    requiredCapabilities: [...new Set<Capability>(["chat", ...(body.requiredCapabilities ?? [])])],
    preferredCapabilities: inferPreferred(body.message),
    privacy: body.privacy as never,
    estimatedInputTokens,
    estimatedOutputTokens: 800,
    maxCostUsd: body.maxCostUsd,
  });

  return { decision, estimatedInputTokens };
}

function serializeDecision(decision: RoutingDecision) {
  const first = decision.candidates[0];
  return {
    mode: decision.mode,
    chosen: first
      ? {
          modelId: first.model.id,
          displayName: first.model.displayName,
          providerId: first.model.providerId,
          local: first.model.local,
          estimatedCostUsd: first.estimatedCostUsd,
          reasons: first.reasons,
        }
      : null,
    fallbacks: decision.candidates.slice(1, 3).map((c) => ({
      modelId: c.model.id,
      displayName: c.model.displayName,
      providerId: c.model.providerId,
      local: c.model.local,
    })),
    rejected: decision.rejected,
  };
}

function sse(type: string, data: unknown): string {
  return `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
}

function streamChat(body: ChatBody, signal: AbortSignal | null): Response {
  const conversationId = body.conversationId ?? uuid();
  if (!conversations.has(conversationId)) {
    conversations.set(conversationId, []);
    const now = new Date().toISOString();
    const t = body.message.replace(/\s+/g, " ").trim();
    conversationMeta.set(conversationId, {
      title: t.length <= 60 ? t : `${t.slice(0, 57)}…`,
      createdAt: now,
      updatedAt: now,
    });
  }

  const stored = conversations.get(conversationId)!;
  const history: ChatMessage[] = stored.slice(-20).map((m) => ({ role: m.role as ChatMessage["role"], content: m.content }));
  const { decision, estimatedInputTokens } = plan(body, history);

  const encoder = new TextEncoder();
  const t0 = Date.now();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const push = (s: string) => controller.enqueue(encoder.encode(s));
      let cancelled = false;
      const onAbort = () => { cancelled = true; };
      signal?.addEventListener("abort", onAbort);

      push(sse("routing", serializeDecision(decision)));

      if (decision.candidates.length === 0) {
        push(sse("error", {
          code: "no_eligible_model",
          message:
            "No configured model can serve this request. A provider may be unreachable, or the request's privacy setting may exclude every available model.",
          component: "browser-demo",
          retryable: false,
          timestamp: new Date().toISOString(),
        }));
        controller.close();
        return;
      }

      stored.push({ id: uuid(), role: "user", content: body.message, modelId: null, createdAt: new Date().toISOString() });

      // The same bounded fallback walk the real executor performs.
      const chain = decision.candidates.slice(0, 3);
      for (let i = 0; i < chain.length; i++) {
        const candidate = chain[i]!;
        const model = candidate.model;
        push(sse("attempt", { modelId: model.id, attemptIndex: i, isFallback: i > 0 }));

        const attemptStart = Date.now();

        // "/fail" makes the primary fail so the fallback chain is observable.
        if (shouldFail(body.message) && i === 0) {
          await new Promise((r) => setTimeout(r, 250));
          runs.push({ modelId: model.id, ok: false, errorCode: "provider_unreachable", latencyMs: Date.now() - attemptStart, inputTokens: 0, outputTokens: 0, costUsd: 0 });
          continue;
        }

        const run = simulate(model, body.message, estimatedInputTokens);
        let emitted = "";
        const words = run.text.split(/(\s+)/).filter((w) => w.length > 0);

        for (const w of words) {
          if (cancelled) {
            runs.push({ modelId: model.id, ok: false, errorCode: "cancelled", latencyMs: Date.now() - attemptStart, inputTokens: 0, outputTokens: 0, costUsd: 0 });
            signal?.removeEventListener("abort", onAbort);
            controller.close();
            return;
          }
          await new Promise((r) => setTimeout(r, run.delayMs));
          emitted += w;
          push(sse("delta", { text: w }));
        }

        const costUsd =
          (run.inputTokens / 1_000_000) * model.inputCostPer1m +
          (run.outputTokens / 1_000_000) * model.outputCostPer1m;
        const latencyMs = Date.now() - attemptStart;

        runs.push({ modelId: model.id, ok: true, errorCode: null, latencyMs, inputTokens: run.inputTokens, outputTokens: run.outputTokens, costUsd });
        stored.push({ id: uuid(), role: "assistant", content: emitted, modelId: model.id, createdAt: new Date().toISOString() });
        conversationMeta.get(conversationId)!.updatedAt = new Date().toISOString();

        push(sse("usage", { inputTokens: run.inputTokens, outputTokens: run.outputTokens, costUsd }));
        push(sse("done", { conversationId, modelId: model.id, latencyMs: Date.now() - t0 }));
        signal?.removeEventListener("abort", onAbort);
        controller.close();
        return;
      }

      push(sse("error", {
        code: "provider_unreachable",
        message: `All ${chain.length} candidate model(s) failed.`,
        component: "browser-demo",
        retryable: true,
        timestamp: new Date().toISOString(),
      }));
      signal?.removeEventListener("abort", onAbort);
      controller.close();
    },
  });

  return new Response(stream, { status: 200, headers: { "content-type": "text/event-stream" } });
}

// ---------------------------------------------------------------------------
// Route table
// ---------------------------------------------------------------------------

async function handle(url: URL, init: RequestInit | undefined): Promise<Response> {
  const method = (init?.method ?? "GET").toUpperCase();
  const path = url.pathname;
  const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};

  if (path === "/api/health") {
    const components = [
      { name: "nyro-core", state: "healthy", detail: "running in your browser (demo mode)", latencyMs: null },
      { name: "database", state: "unknown", detail: "not present — this demo keeps state in memory only", latencyMs: null },
      ...SEED_PROVIDERS.map((p) => ({
        name: `provider:${p.id}`,
        state: p.health,
        detail: `${p.detail} — simulated, no network call was made`,
        latencyMs: null,
      })),
    ];
    return jsonResponse(200, { state: "degraded", checkedAt: new Date().toISOString(), components });
  }

  if (path === "/api/providers") {
    return jsonResponse(200, {
      providers: SEED_PROVIDERS.map((p) => ({
        id: p.id,
        displayName: p.displayName,
        presetKey: p.id,
        transport: p.transport,
        baseUrl: "(demo — not configured)",
        hasApiKey: !p.local,
        apiKeyHint: p.local ? null : "…demo",
        local: p.local,
        enabled: true,
        health: { state: p.health, detail: p.detail, latencyMs: null, checkedAt: new Date().toISOString() },
      })),
    });
  }

  if (path === "/api/providers/presets") {
    const { PROVIDER_PRESETS } = await import("./core-imports.ts");
    return jsonResponse(200, { presets: PROVIDER_PRESETS });
  }

  if (path === "/api/models" && method === "GET") {
    return jsonResponse(200, { models: models.map((m) => ({ ...m, traitsSource: "catalog" })) });
  }

  if (path.startsWith("/api/models/") && method === "PUT") {
    const id = decodeURIComponent(path.slice("/api/models/".length));
    const enabled = Boolean(body["enabled"]);
    models = models.map((m) => (m.id === id ? { ...m, enabled } : m));
    const found = models.find((m) => m.id === id);
    if (!found) return errorResponse(404, "model_not_found", `Model "${id}" does not exist.`);
    return jsonResponse(200, { model: { ...found, traitsSource: "catalog" } });
  }

  if (path === "/api/route/preview" && method === "POST") {
    const { decision, estimatedInputTokens } = plan(body as unknown as ChatBody, []);
    return jsonResponse(200, { estimatedInputTokens, decision: serializeDecision(decision) });
  }

  if (path === "/api/conversations" && method === "GET") {
    const list = [...conversationMeta.entries()].map(([id, meta]) => ({
      id, title: meta.title, createdAt: meta.createdAt, updatedAt: meta.updatedAt,
      messageCount: conversations.get(id)?.length ?? 0,
    }));
    return jsonResponse(200, { conversations: list });
  }

  if (path === "/api/budget" && method === "GET") {
    // The demo has no real spend, so it reports zeros rather than inventing
    // numbers that would look like the user's own money.
    const zero = { dayUsd: 0, weekUsd: 0, monthUsd: 0, perProviderMonthUsd: {} };
    return jsonResponse(200, {
      config: {
        dailyUsd: null, weeklyUsd: null, monthlyUsd: null, perRequestUsd: null,
        perProviderMonthlyUsd: {}, onExceeded: "local_only",
      },
      spend: zero,
      status: { action: "allow", message: null, breaches: [] },
      remaining: { dayUsd: null, weekUsd: null, monthUsd: null },
    });
  }

  if (path === "/api/budget" && (method === "PUT" || method === "DELETE")) {
    return errorResponse(409, "config_error", "Saving spending limits needs the real NYRO API. This page has no backend.");
  }

  if (path === "/api/routing-rules" && method === "GET") {
    return jsonResponse(200, { rules: [] });
  }
  if (path === "/api/routing-rules" && method === "PUT") {
    return errorResponse(409, "config_error", "Saving routing rules needs the real NYRO API. This page has no backend.");
  }

  if (path === "/api/stats") {
    const ok = runs.filter((r) => r.ok);
    const failed = runs.filter((r) => !r.ok && r.errorCode !== "cancelled");
    const cancelled = runs.filter((r) => r.errorCode === "cancelled");
    const perModelMap = new Map<string, Run[]>();
    for (const r of runs) {
      const arr = perModelMap.get(r.modelId) ?? [];
      arr.push(r);
      perModelMap.set(r.modelId, arr);
    }
    return jsonResponse(200, {
      totalRuns: runs.length,
      failedRuns: failed.length,
      cancelledRuns: cancelled.length,
      totalCostUsd: runs.reduce((s, r) => s + r.costUsd, 0),
      avgLatencyMs: ok.length === 0 ? 0 : Math.round(ok.reduce((s, r) => s + r.latencyMs, 0) / ok.length),
      perModel: [...perModelMap.entries()].map(([modelId, rs]) => {
        const okRuns = rs.filter((r) => r.ok);
        return {
          modelId,
          runs: rs.length,
          failures: rs.filter((r) => !r.ok && r.errorCode !== "cancelled").length,
          cancelled: rs.filter((r) => r.errorCode === "cancelled").length,
          avgLatencyMs: okRuns.length === 0 ? 0 : Math.round(okRuns.reduce((s, r) => s + r.latencyMs, 0) / okRuns.length),
          costUsd: rs.reduce((s, r) => s + r.costUsd, 0),
        };
      }).sort((a, b) => b.runs - a.runs),
    });
  }

  // Writes that need a real backend are refused honestly rather than faked.
  if (method === "PUT" && path.startsWith("/api/providers/")) {
    return errorResponse(409, "config_error", "Adding providers needs the real NYRO API. This page has no backend — run NYRO locally to connect a provider.");
  }
  if (method === "DELETE" && path.startsWith("/api/providers/")) {
    return errorResponse(409, "config_error", "Removing providers needs the real NYRO API.");
  }
  if (path.endsWith("/test") || path.endsWith("/discover") || path === "/api/providers/discover") {
    return errorResponse(409, "config_error", "Testing and discovery make real network calls, which this page cannot do. Run NYRO locally to use them.");
  }

  return errorResponse(404, "bad_request", `No route for ${method} ${path}`);
}

/**
 * Installs the interceptor. Only `/api/*` is intercepted; everything else
 * (fonts, assets) goes to the network untouched.
 */
export function installBrowserNyro(): void {
  const realFetch = globalThis.fetch.bind(globalThis);

  globalThis.fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const raw = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, globalThis.location.href);

    if (!url.pathname.startsWith("/api/")) return realFetch(input as RequestInfo, init);

    const signal = init?.signal ?? null;
    if (url.pathname === "/api/chat/stream") {
      return streamChat(JSON.parse(String(init?.body ?? "{}")) as ChatBody, signal);
    }
    try {
      return await handle(url, init);
    } catch (err) {
      return errorResponse(500, "internal", err instanceof Error ? err.message : String(err));
    }
  };
}
