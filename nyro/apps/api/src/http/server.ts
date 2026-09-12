/**
 * NYRO API (spec §77, §78).
 *
 * The frontend talks only to this. It has no knowledge of Ollama, OpenAI, or
 * any other backend (spec §113) — the only model-shaped things it ever sees are
 * registry entries and routing decisions.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { z } from "zod";

import type { NyroConfig } from "../config.ts";
import { NyroError, httpStatusFor } from "../core/errors.ts";
import type { EventBus } from "../core/events.ts";
import { systemHealth } from "../core/health.ts";
import type { Registry } from "../core/registry.ts";
import type { ChatService } from "../core/chat-service.ts";
import { BUDGET_SETTINGS_KEY, LEARNING_SETTINGS_KEY, ROUTING_RULES_SETTINGS_KEY } from "../core/chat-service.ts";
import { routingRulesSchema, validateRuleTargets } from "../core/routing-rules.ts";
import { adjustmentFor, MIN_SAMPLES } from "../core/performance.ts";
import { budgetConfigSchema, evaluateBudget, DEFAULT_BUDGET } from "../core/budget.ts";
import type { ConversationRepo, ModelRepo, ProviderRepo, RunRepo, SettingsRepo } from "../db/repos.ts";
import type { Pool } from "../db/pool.ts";
import { PROVIDER_PRESETS, findPreset } from "../providers/presets.ts";
import { logger } from "../util/logger.ts";
import { HttpRouter, readJsonBody, sendJson, type RequestContext } from "./router.ts";
import { SseStream } from "./sse.ts";
import { serveStatic } from "./static.ts";
import {
  chatRequestSchema,
  createConversationSchema,
  updateModelSchema,
  upsertProviderSchema,
} from "./schemas.ts";
import { estimateMessagesTokens } from "../util/tokens.ts";

const log = logger("http");

export interface ServerDeps {
  config: NyroConfig;
  pool: Pool;
  providers: ProviderRepo;
  models: ModelRepo;
  conversations: ConversationRepo;
  runs: RunRepo;
  settings: SettingsRepo;
  registry: Registry;
  chat: ChatService;
  bus: EventBus;
}

function applyCors(res: ServerResponse, origin: string | undefined, allowed: string[]): void {
  // Explicit allow-list; no wildcard (spec §69). An unknown origin simply gets
  // no CORS header and the browser blocks it.
  if (origin && allowed.includes(origin)) {
    res.setHeader("access-control-allow-origin", origin);
    res.setHeader("vary", "origin");
    res.setHeader("access-control-allow-methods", "GET,POST,PUT,DELETE,OPTIONS");
    res.setHeader("access-control-allow-headers", "content-type");
    res.setHeader("access-control-max-age", "600");
  }
}

function errorResponse(res: ServerResponse, err: unknown, component: string): void {
  const e = NyroError.from(err, component);
  // detail may contain a provider's raw response; it goes to the log, never the client.
  if (e.code === "internal" || e.code === "db_error") {
    log.error("request failed", { code: e.code, component: e.component, message: e.message, detail: e.detail });
  } else {
    log.warn("request failed", { code: e.code, component: e.component, message: e.message });
  }
  if (!res.headersSent) sendJson(res, httpStatusFor(e.code), e.toPublic());
  else res.end();
}

function parseOr400<T extends z.ZodTypeAny>(schema: T, body: unknown): z.infer<T> {
  const parsed = schema.safeParse(body);
  if (!parsed.success) {
    const first = parsed.error.issues[0];
    throw new NyroError("bad_request", `Invalid request: ${first?.path.join(".") || "body"} — ${first?.message}`, {
      component: "http",
    });
  }
  return parsed.data;
}

export function buildRouter(deps: ServerDeps): HttpRouter {
  const r = new HttpRouter();

  // ---- Health -------------------------------------------------------------
  r.get("/api/health", async (ctx) => {
    // ?probe=true actively contacts every provider; default reads cached state
    // so a dashboard poll cannot hammer the providers.
    const probe = ctx.query.get("probe") === "true";
    const report = await systemHealth({
      pool: deps.pool,
      providers: deps.providers,
      registry: deps.registry,
      probe,
    });
    const status = report.state === "unreachable" ? 503 : 200;
    sendJson(ctx.res, status, report);
  });

  // ---- Providers ----------------------------------------------------------
  r.get("/api/providers", async (ctx) => {
    sendJson(ctx.res, 200, { providers: await deps.providers.listPublic() });
  });

  r.get("/api/providers/presets", (ctx) => {
    sendJson(ctx.res, 200, { presets: PROVIDER_PRESETS });
  });

  r.put("/api/providers/:id", async (ctx) => {
    const body = parseOr400(upsertProviderSchema, await readJsonBody(ctx.req));
    if (body.id !== ctx.params["id"]) {
      throw new NyroError("bad_request", "Provider id in the URL and body must match.", { component: "http" });
    }
    const preset = findPreset(body.presetKey);
    if (preset?.requiresApiKey && body.apiKey === undefined) {
      const current = await deps.providers.getPublic(body.id);
      if (!current?.hasApiKey) {
        throw new NyroError("bad_request", `${preset.displayName} requires an API key.`, { component: "http" });
      }
    }
    if (body.transport !== "mock" && body.baseUrl.trim() === "") {
      throw new NyroError("bad_request", "A base URL is required for this provider.", { component: "http" });
    }

    const saved = await deps.providers.upsert({
      id: body.id,
      displayName: body.displayName,
      presetKey: body.presetKey,
      transport: body.transport as never,
      baseUrl: body.baseUrl,
      ...(body.apiKey !== undefined ? { apiKey: body.apiKey } : {}),
      local: body.local,
      enabled: body.enabled,
      requestTimeoutMs: body.requestTimeoutMs,
      extra: body.extra,
    });
    deps.registry.invalidate(body.id);
    sendJson(ctx.res, 200, { provider: saved });
  });

  r.delete("/api/providers/:id", async (ctx) => {
    const id = ctx.params["id"]!;
    const deleted = await deps.providers.delete(id);
    deps.registry.invalidate(id);
    if (!deleted) throw new NyroError("model_not_found", `Provider "${id}" does not exist.`, { component: "http" });
    sendJson(ctx.res, 200, { deleted: true });
  });

  /** "Test connection" (spec §106). Probes without saving anything. */
  r.post("/api/providers/:id/test", async (ctx) => {
    const id = ctx.params["id"]!;
    const adapter = await deps.registry.adapterFor(id);
    const health = await adapter.healthCheck();
    await deps.providers.recordHealth(id, health.state, health.detail, health.latencyMs);
    sendJson(ctx.res, 200, { providerId: id, health });
  });

  /** Model discovery (spec §7, §8). */
  r.post("/api/providers/:id/discover", async (ctx) => {
    const report = await deps.registry.discoverProvider(ctx.params["id"]!);
    sendJson(ctx.res, 200, report);
  });

  r.post("/api/providers/discover", async (ctx) => {
    sendJson(ctx.res, 200, { reports: await deps.registry.discoverAll() });
  });

  // ---- Models -------------------------------------------------------------
  r.get("/api/models", async (ctx) => {
    const enabledOnly = ctx.query.get("enabledOnly") === "true";
    sendJson(ctx.res, 200, { models: await deps.models.list({ enabledOnly }) });
  });

  r.put("/api/models/:id", async (ctx) => {
    const body = parseOr400(updateModelSchema, await readJsonBody(ctx.req));
    const ok = await deps.models.setEnabled(ctx.params["id"]!, body.enabled);
    if (!ok) throw new NyroError("model_not_found", `Model "${ctx.params["id"]}" does not exist.`, { component: "http" });
    sendJson(ctx.res, 200, { model: await deps.models.get(ctx.params["id"]!) });
  });

  /**
   * Dry-run routing (spec §149 debug mode). Shows which model *would* be used
   * and what was rejected, without spending a token.
   */
  r.post("/api/route/preview", async (ctx) => {
    const body = parseOr400(chatRequestSchema, await readJsonBody(ctx.req));
    const { decision, messages, budget } = await deps.chat.plan(
      {
        conversationId: body.conversationId,
        message: body.message,
        mode: body.mode,
        privacy: body.privacy,
        modelId: body.modelId,
        providerId: body.providerId,
        systemPrompt: body.systemPrompt,
        temperature: body.temperature,
        maxCostUsd: body.maxCostUsd,
        requiredCapabilities: body.requiredCapabilities,
      },
      [],
    );
    sendJson(ctx.res, 200, {
      estimatedInputTokens: estimateMessagesTokens(messages),
      decision: serializeDecision(decision),
      budget: { action: budget.action, message: budget.message, breaches: budget.breaches },
    });
  });

  // ---- Conversations ------------------------------------------------------
  r.get("/api/conversations", async (ctx) => {
    sendJson(ctx.res, 200, { conversations: await deps.conversations.list() });
  });

  r.post("/api/conversations", async (ctx) => {
    const body = parseOr400(createConversationSchema, await readJsonBody(ctx.req));
    const id = await deps.conversations.create(body.title);
    sendJson(ctx.res, 201, { conversationId: id });
  });

  r.put("/api/conversations/:id", async (ctx) => {
    const id = ctx.params["id"]!;
    const body = parseOr400(z.object({ title: z.string().min(1).max(200) }), await readJsonBody(ctx.req));
    if (!(await deps.conversations.exists(id))) {
      throw new NyroError("model_not_found", "Conversation not found.", { component: "http" });
    }
    await deps.conversations.setTitle(id, body.title);
    sendJson(ctx.res, 200, { id, title: body.title });
  });

  r.delete("/api/conversations/:id", async (ctx) => {
    const deleted = await deps.conversations.delete(ctx.params["id"]!);
    if (!deleted) throw new NyroError("model_not_found", "Conversation not found.", { component: "http" });
    sendJson(ctx.res, 200, { deleted: true });
  });

  r.get("/api/conversations/:id/messages", async (ctx) => {
    const id = ctx.params["id"]!;
    if (!(await deps.conversations.exists(id))) {
      throw new NyroError("model_not_found", "Conversation not found.", { component: "http" });
    }
    sendJson(ctx.res, 200, { messages: await deps.conversations.messages(id) });
  });

  // ---- Chat ---------------------------------------------------------------
  r.post("/api/chat", async (ctx) => {
    const body = parseOr400(chatRequestSchema, await readJsonBody(ctx.req));
    const controller = new AbortController();
    ctx.req.on("aborted", () => controller.abort());

    let budgetNotice: { message: string | null; action: string } | null = null;
    const outcome = await deps.chat.send(
      toChatInput(body),
      { onBudget: (v) => { budgetNotice = { message: v.message, action: v.action }; } },
      controller.signal,
    );
    sendJson(ctx.res, 200, {
      budget: budgetNotice,
      conversationId: outcome.conversationId,
      content: outcome.content,
      model: publicModel(outcome),
      usage: outcome.usage,
      costUsd: outcome.costUsd,
      decision: serializeDecision(outcome.decision),
      attempts: outcome.attempts,
    });
  });

  r.post("/api/chat/stream", async (ctx) => {
    const body = parseOr400(chatRequestSchema, await readJsonBody(ctx.req));
    const controller = new AbortController();

    // Closing the EventSource cancels the upstream provider call (spec §37, §83).
    const onClose = () => controller.abort();
    ctx.req.on("aborted", onClose);
    ctx.res.on("close", onClose);

    const sse = new SseStream(ctx.res);
    const t0 = Date.now();

    try {
      const outcome = await deps.chat.send(
        toChatInput(body),
        {
          onBudget: (verdict) => sse.send({ type: "budget", data: { message: verdict.message, action: verdict.action, breaches: verdict.breaches } }),
          onRouted: (decision) => sse.send({ type: "routing", data: serializeDecision(decision) }),
          onAttempt: (info) => sse.send({ type: "attempt", data: info }),
          onDelta: (text) => sse.send({ type: "delta", data: { text } }),
        },
        controller.signal,
      );

      sse.send({
        type: "usage",
        data: { ...outcome.usage, costUsd: outcome.costUsd },
      });
      sse.send({
        type: "done",
        data: { conversationId: outcome.conversationId, modelId: outcome.model.id, latencyMs: Date.now() - t0 },
      });
    } catch (err) {
      const e = NyroError.from(err, "http:chat-stream");
      if (e.code !== "cancelled") {
        log.warn("stream failed", { code: e.code, message: e.message });
      }
      // Headers are already sent, so the error travels as an SSE event, not a status code.
      sse.send({ type: "error", data: e.toPublic().error });
    } finally {
      sse.close();
    }
  });

  // ---- Budget (spec §66) --------------------------------------------------
  r.get("/api/budget", async (ctx) => {
    const config = await deps.chat.budgetConfig();
    const spend = await deps.runs.spend();
    // Reported against a normal request, which is the case a limit actually
    // constrains; a local-only request is never blocked by cost.
    const verdict = evaluateBudget(config, spend, { privacy: "normal", mode: "auto" });
    sendJson(ctx.res, 200, {
      config,
      spend,
      status: {
        action: verdict.action,
        message: verdict.message,
        breaches: verdict.breaches,
      },
      remaining: {
        dayUsd: config.dailyUsd === null ? null : Math.max(0, config.dailyUsd - spend.dayUsd),
        weekUsd: config.weeklyUsd === null ? null : Math.max(0, config.weeklyUsd - spend.weekUsd),
        monthUsd: config.monthlyUsd === null ? null : Math.max(0, config.monthlyUsd - spend.monthUsd),
      },
    });
  });

  r.put("/api/budget", async (ctx) => {
    const body = parseOr400(budgetConfigSchema, await readJsonBody(ctx.req));
    // Only known providers can carry a cap, so a typo cannot create a limit
    // that silently never applies.
    const known = new Set((await deps.providers.listPublic()).map((p) => p.id));
    for (const id of Object.keys(body.perProviderMonthlyUsd)) {
      if (!known.has(id)) {
        throw new NyroError("bad_request", `Unknown provider "${id}" in perProviderMonthlyUsd.`, { component: "http" });
      }
    }
    await deps.settings.set(BUDGET_SETTINGS_KEY, body);
    sendJson(ctx.res, 200, { config: body });
  });

  r.delete("/api/budget", async (ctx) => {
    await deps.settings.set(BUDGET_SETTINGS_KEY, DEFAULT_BUDGET);
    sendJson(ctx.res, 200, { config: DEFAULT_BUDGET });
  });

  // ---- Routing rules (spec §10) -------------------------------------------
  r.get("/api/routing-rules", async (ctx) => {
    sendJson(ctx.res, 200, await deps.chat.routingRules());
  });

  r.put("/api/routing-rules", async (ctx) => {
    const body = parseOr400(routingRulesSchema, await readJsonBody(ctx.req));
    // Targets are checked against the live registry, so a rule cannot be saved
    // pointing at something that does not exist and then silently never fire.
    const models = new Set((await deps.models.list()).map((m) => m.id));
    const providers = new Set((await deps.providers.listPublic()).map((p) => p.id));
    const problem = validateRuleTargets(body.rules, models, providers);
    if (problem) throw new NyroError("bad_request", problem, { component: "http" });

    await deps.settings.set(ROUTING_RULES_SETTINGS_KEY, body);
    sendJson(ctx.res, 200, body);
  });

  // ---- Measured performance (spec §13, §102) ------------------------------
  r.get("/api/performance", async (ctx) => {
    const rows = await deps.runs.performance();
    sendJson(ctx.res, 200, {
      enabled: await deps.chat.measuredRoutingEnabled(),
      minSamples: MIN_SAMPLES,
      models: rows.map((row) => {
        const adj = adjustmentFor(row);
        return {
          modelId: row.modelId,
          medianTokensPerSecond: Number(row.medianTokensPerSecond.toFixed(2)),
          successRate: Number(row.successRate.toFixed(3)),
          samples: row.samples,
          // Null until there is enough evidence, so the UI can say "measuring"
          // rather than showing a figure NYRO is not yet acting on.
          measuredSpeedScore: adj ? adj.speed : null,
          inUse: adj !== null,
        };
      }),
    });
  });

  r.put("/api/performance", async (ctx) => {
    const body = parseOr400(z.object({ enabled: z.boolean() }), await readJsonBody(ctx.req));
    await deps.settings.set(LEARNING_SETTINGS_KEY, body);
    sendJson(ctx.res, 200, body);
  });

  // ---- Stats --------------------------------------------------------------
  r.get("/api/stats", async (ctx) => {
    const hours = Number.parseInt(ctx.query.get("hours") ?? "24", 10);
    sendJson(ctx.res, 200, await deps.runs.stats(Number.isFinite(hours) && hours > 0 ? hours : 24));
  });

  return r;
}

function toChatInput(body: z.infer<typeof chatRequestSchema>) {
  return {
    conversationId: body.conversationId,
    message: body.message,
    mode: body.mode,
    privacy: body.privacy,
    modelId: body.modelId,
    providerId: body.providerId,
    systemPrompt: body.systemPrompt,
    temperature: body.temperature,
    maxCostUsd: body.maxCostUsd,
    requiredCapabilities: body.requiredCapabilities,
  };
}

function publicModel(outcome: { model: { id: string; displayName: string; providerId: string; local: boolean } }) {
  return {
    id: outcome.model.id,
    displayName: outcome.model.displayName,
    providerId: outcome.model.providerId,
    local: outcome.model.local,
  };
}

/** Flattens the decision for the wire — the UI needs ids and reasons, not whole model rows. */
function serializeDecision(decision: {
  mode: string;
  candidates: Array<{ model: { id: string; displayName: string; providerId: string; local: boolean }; score: number; estimatedCostUsd: number; reasons: string[] }>;
  rejected: Array<{ modelId: string; reason: string }>;
}) {
  return {
    mode: decision.mode,
    chosen: decision.candidates[0]
      ? {
          modelId: decision.candidates[0].model.id,
          displayName: decision.candidates[0].model.displayName,
          providerId: decision.candidates[0].model.providerId,
          local: decision.candidates[0].model.local,
          estimatedCostUsd: decision.candidates[0].estimatedCostUsd,
          reasons: decision.candidates[0].reasons,
        }
      : null,
    // providerId/local are included so the UI can label a turn by the model
    // that ACTUALLY ran after a fallback, rather than the one first chosen.
    fallbacks: decision.candidates.slice(1, 3).map((c) => ({
      modelId: c.model.id,
      displayName: c.model.displayName,
      providerId: c.model.providerId,
      local: c.model.local,
    })),
    rejected: decision.rejected,
  };
}

export function createHttpServer(deps: ServerDeps): Server {
  const router = buildRouter(deps);

  return createServer((req: IncomingMessage, res: ServerResponse) => {
    const origin = req.headers.origin;
    applyCors(res, origin, deps.config.corsOrigins);

    if (req.method === "OPTIONS") {
      res.writeHead(204);
      res.end();
      return;
    }

    let url: URL;
    try {
      url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    } catch {
      sendJson(res, 400, { error: { code: "bad_request", message: "Malformed request URL." } });
      return;
    }

    const match = router.match(req.method ?? "GET", url.pathname);
    if (!match) {
      // An unmatched /api path is a genuine 404. Anything else may be the web
      // UI, when this process is also serving it.
      const isApi = url.pathname.startsWith("/api/");
      if (!isApi && deps.config.staticDir && (req.method === "GET" || req.method === "HEAD")) {
        serveStatic(deps.config.staticDir, url.pathname, res)
          .then((result) => {
            if (!result.served) {
              sendJson(res, 404, { error: { code: "bad_request", message: "Not found" } });
            }
          })
          .catch((err) => errorResponse(res, err, "http:static"));
        return;
      }
      sendJson(res, 404, { error: { code: "bad_request", message: `No route for ${req.method} ${url.pathname}` } });
      return;
    }

    const ctx: RequestContext = { req, res, params: match.params, query: url.searchParams, url };
    const started = Date.now();

    Promise.resolve(match.handler(ctx))
      .then(() => {
        log.debug("request", { method: req.method, path: url.pathname, ms: Date.now() - started });
      })
      .catch((err) => errorResponse(res, err, "http"));
  });
}
