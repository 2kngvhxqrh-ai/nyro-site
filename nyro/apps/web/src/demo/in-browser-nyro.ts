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
import {
  DEFAULT_INSTRUCTIONS,
  estimateMessagesTokens,
  resolveSystemPrompt,
  route,
  type Capability,
  type ChatMessage,
  type Instructions,
  type RegisteredModel,
  type RoutingDecision,
} from "./core-imports.ts";
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
  message: string; regenerate?: boolean; editLast?: boolean; conversationId: string | null; mode: string; privacy: string;
  modelId: string | null; providerId: string | null;
  // Optional because the demo has no validator between the UI and here: the
  // chat form omits this field entirely, and typing it as required let a
  // `undefined` reach code that expected `null`.
  systemPrompt?: string | null;
  temperature: number | null; maxCostUsd: number | null; requiredCapabilities: Capability[];
}

/**
 * The demo's standing instructions. In-memory and per page load, like its
 * conversations — there is no database here, and pretending the setting
 * survives a refresh would be a lie about what this page is.
 */
let instructions: Instructions = { ...DEFAULT_INSTRUCTIONS };

function plan(body: ChatBody, history: ChatMessage[]): { decision: RoutingDecision; estimatedInputTokens: number } {
  const messages: ChatMessage[] = [];
  const systemPrompt = resolveSystemPrompt(instructions, body.systemPrompt);
  if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
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

  // Mirrors the real service: drop the trailing answer and reuse the stored
  // question, so the demo cannot duplicate it either.
  let effective = body;
  if (body.regenerate) {
    if (stored.at(-1)?.role === "assistant") stored.pop();
    const lastUser = stored.at(-1);
    if (!lastUser || lastUser.role !== "user") {
      return jsonResponse(400, {
        error: { code: "bad_request", message: "Nothing to regenerate in this conversation.", component: "browser-demo", retryable: false, timestamp: new Date().toISOString() },
      });
    }
    effective = { ...body, message: lastUser.content };
  }

  // An edit rewinds the same way but rewrites the question, so the demo shows
  // the same transcript the server would produce.
  if (body.editLast) {
    if (stored.at(-1)?.role === "assistant") stored.pop();
    const lastUser = stored.at(-1);
    if (!lastUser || lastUser.role !== "user") {
      return jsonResponse(400, {
        error: { code: "bad_request", message: "Nothing to edit in this conversation.", component: "browser-demo", retryable: false, timestamp: new Date().toISOString() },
      });
    }
    lastUser.content = body.message;
    if (stored[0] === lastUser) {
      const meta = conversationMeta.get(conversationId);
      if (meta) meta.title = body.message.replace(/\s+/g, " ").trim().slice(0, 60);
    }
  }

  const rewound = body.regenerate === true || body.editLast === true;
  const historySource = rewound ? stored.slice(0, -1) : stored;
  const history: ChatMessage[] = historySource.slice(-20).map((m) => ({ role: m.role as ChatMessage["role"], content: m.content }));
  const { decision, estimatedInputTokens } = plan(effective, history);

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

      if (!rewound) {
        stored.push({ id: uuid(), role: "user", content: body.message, modelId: null, createdAt: new Date().toISOString() });
      }

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

        const run = simulate(model, effective.message, estimatedInputTokens);
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
    // Mirrors the real API: a patch, so an omitted field is left alone.
    models = models.map((m) =>
      m.id === id
        ? {
            ...m,
            ...(body["enabled"] !== undefined ? { enabled: Boolean(body["enabled"]) } : {}),
            ...(body["displayName"] !== undefined ? { displayName: String(body["displayName"]) } : {}),
            ...(body["inputCostPer1m"] !== undefined ? { inputCostPer1m: Number(body["inputCostPer1m"]) } : {}),
            ...(body["outputCostPer1m"] !== undefined ? { outputCostPer1m: Number(body["outputCostPer1m"]) } : {}),
            ...(body["contextWindow"] !== undefined ? { contextWindow: Number(body["contextWindow"]) } : {}),
          }
        : m,
    );
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

  if (path === "/api/instructions" && method === "GET") {
    return jsonResponse(200, instructions);
  }
  if (path === "/api/instructions" && method === "PUT") {
    instructions = {
      enabled: Boolean(body["enabled"]),
      text: String(body["text"] ?? "").slice(0, 50_000),
    };
    return jsonResponse(200, instructions);
  }
  if (path === "/api/instructions" && method === "DELETE") {
    instructions = { ...DEFAULT_INSTRUCTIONS };
    return jsonResponse(200, instructions);
  }

  if (path.startsWith("/api/conversations/") && path.endsWith("/messages") && method === "GET") {
    // The demo's sidebar is hidden, so nothing in the page called this until
    // the demo core grew its own tests. The data was always here; only the
    // route was missing, which made the demo's API quietly narrower than the
    // real one it is supposed to stand in for.
    const id = path.slice("/api/conversations/".length, -"/messages".length);
    const stored = conversations.get(decodeURIComponent(id));
    if (!stored) return errorResponse(404, "not_found", `Conversation "${id}" does not exist.`);
    return jsonResponse(200, { messages: stored });
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

  if (path.startsWith("/api/models/") && path.endsWith("/reset")) {
    return errorResponse(409, "config_error", "Correcting a model needs the real NYRO API.");
  }

  if (path === "/api/search") {
    // No database to search in the demo, and inventing hits would be a lie.
    return jsonResponse(200, { query: url.searchParams.get("q") ?? "", results: [] });
  }

  if (path.startsWith("/api/export")) {
    // The demo has no database and the artifact sandbox blocks downloads
    // anyway, so it says so rather than producing an empty file.
    return errorResponse(409, "config_error", "Export needs the real NYRO API and your own database.");
  }

  if (path === "/api/performance" && method === "GET") {
    // The demo's runs are simulated, so it reports no measurements rather than
    // presenting made-up throughput figures as observations.
    return jsonResponse(200, { enabled: true, minSamples: 5, models: [] });
  }
  if (path === "/api/performance" && method === "PUT") {
    return errorResponse(409, "config_error", "Changing measured routing needs the real NYRO API.");
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
    try {
      if (url.pathname === "/api/chat/stream") {
        // Inside the try, deliberately. This branch used to sit outside it, so
        // a throw here rejected the caller's fetch instead of becoming an
        // error the UI could show -- the demo simply stopped answering, with
        // nothing on screen to say why.
        return streamChat(JSON.parse(String(init?.body ?? "{}")) as ChatBody, signal);
      }
      return await handle(url, init);
    } catch (err) {
      return errorResponse(500, "internal", err instanceof Error ? err.message : String(err));
    }
  };
}
