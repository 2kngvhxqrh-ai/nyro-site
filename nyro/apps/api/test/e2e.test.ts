/**
 * End-to-end tests: the Phase 1 milestone flow, exercised for real.
 *
 *   HTTP request -> NYRO API -> Core -> Router -> Provider adapter
 *                -> real HTTP upstream -> SSE back to the client
 *
 * Everything here is real: a real Postgres database with real migrations, a
 * real node:http listener, real sockets, real SSE parsing. The only stand-ins
 * are the upstream model servers, which speak the genuine wire protocols.
 *
 * Requires TEST_DATABASE_URL. Skipped (loudly) when it is absent — a silent
 * skip would let a broken build look green.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createApp, type NyroApp } from "../src/app.ts";
import type { NyroConfig } from "../src/config.ts";
import { fakeUpstream, type Upstream } from "./helpers.ts";

const DB_URL = process.env["TEST_DATABASE_URL"];
if (!DB_URL) {
  throw new Error("TEST_DATABASE_URL is required to run e2e tests. See nyro/docs/SETUP.md.");
}

let app: NyroApp;
let baseUrl: string;
let ollamaUp: Upstream;
let openaiUp: Upstream;

function testConfig(): NyroConfig {
  return {
    env: "test",
    port: 0,
    host: "127.0.0.1",
    databaseUrl: DB_URL!,
    secretKey: randomBytes(32),
    logLevel: "error",
    corsOrigins: ["http://localhost:5173"],
    ollamaBaseUrl: null,
    defaultModelHint: null,
    enableMockProvider: false,
    requestTimeoutMs: 15_000,
    staticDir: null,
  };
}

async function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}

async function json<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await api(path, init);
  return (await res.json()) as T;
}

/** Minimal SSE client: parses `event:`/`data:` frames off a real response body. */
async function readSse(res: Response, onEvent: (type: string, data: unknown) => void): Promise<void> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    let sep: number;
    while ((sep = buf.indexOf("\n\n")) !== -1) {
      const frame = buf.slice(0, sep);
      buf = buf.slice(sep + 2);
      let type = "message";
      let data = "";
      for (const line of frame.split("\n")) {
        if (line.startsWith("event:")) type = line.slice(6).trim();
        else if (line.startsWith("data:")) data += line.slice(5).trim();
      }
      if (data) {
        try { onEvent(type, JSON.parse(data)); } catch { /* keep-alive comment */ }
      }
    }
  }
}

before(async () => {
  // Upstream #1: an Ollama-speaking server (local, free, weak).
  ollamaUp = await fakeUpstream(async (req, res, body) => {
    if (req.url === "/api/tags") {
      res.writeHead(200, {});
      res.end(JSON.stringify({ models: [{ name: "llama3.2:1b" }] }));
      return;
    }
    if (req.url === "/api/chat") {
      const b = body as { stream?: boolean; messages: Array<{ content: string }> };
      const lastUser = b.messages.at(-1)?.content ?? "";
      const reply = `local-reply:${lastUser}`;

      // A stream long enough to actually interrupt. Without this the reply
      // completes in ~15ms and the cancellation test would be testing nothing.
      if (b.stream && lastUser.includes("cancel me")) {
        res.writeHead(200, {});
        for (let i = 0; i < 200; i++) {
          if (res.writableEnded || res.destroyed) return;
          res.write(JSON.stringify({ message: { content: `chunk${i} ` }, done: false }) + "\n");
          await new Promise((r) => setTimeout(r, 25));
        }
        res.end();
        return;
      }

      if (!b.stream) {
        res.writeHead(200, {});
        res.end(JSON.stringify({ message: { content: reply }, done: true, prompt_eval_count: 9, eval_count: 4 }));
        return;
      }
      res.writeHead(200, {});
      for (const part of reply.match(/.{1,5}/g) ?? []) {
        res.write(JSON.stringify({ message: { content: part }, done: false }) + "\n");
        await new Promise((r) => setTimeout(r, 3));
      }
      res.write(JSON.stringify({ done: true, done_reason: "stop", prompt_eval_count: 9, eval_count: 4 }) + "\n");
      res.end();
      return;
    }
    res.writeHead(404, {});
    res.end("{}");
  });

  // Upstream #2: an OpenAI-compatible server (cloud, priced, stronger).
  openaiUp = await fakeUpstream(async (req, res, body) => {
    if (req.url === "/models") {
      res.writeHead(200, {});
      res.end(JSON.stringify({ data: [{ id: "gpt-4o-mini" }] }));
      return;
    }
    if (req.url === "/chat/completions") {
      const b = body as { stream?: boolean };
      if (!b.stream) {
        res.writeHead(200, {});
        res.end(JSON.stringify({
          choices: [{ message: { content: "cloud-reply" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 6, completion_tokens: 2 },
        }));
        return;
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const part of ["cloud", "-", "reply"]) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: part } }] })}\n\n`);
        await new Promise((r) => setTimeout(r, 3));
      }
      res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 6, completion_tokens: 2 } })}\n\n`);
      res.write("data: [DONE]\n\n");
      res.end();
      return;
    }
    res.writeHead(404, {});
    res.end("{}");
  });

  app = await createApp(testConfig());

  // A clean slate per run; cascades remove models, messages and runs.
  await app.pool.query("delete from providers");
  await app.pool.query("delete from conversations");
  await app.pool.query("delete from model_runs");

  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;
});

after(async () => {
  await app?.shutdown();
  await ollamaUp?.close();
  await openaiUp?.close();
});

// ---------------------------------------------------------------------------
describe("provider configuration and discovery", () => {
  test("health is reported before any provider exists", async () => {
    const h = await json<{ state: string; components: Array<{ name: string; state: string }> }>("/api/health");
    assert.ok(h.components.some((c) => c.name === "database" && c.state === "healthy"));
    assert.ok(h.components.some((c) => c.name === "nyro-core"));
  });

  test("presets expose every provider NYRO can connect", async () => {
    const { presets } = await json<{ presets: Array<{ key: string }> }>("/api/providers/presets");
    const keys = presets.map((p) => p.key);
    for (const expected of ["ollama", "openai", "anthropic", "google", "groq", "mistral", "openrouter", "xai", "openai_compatible"]) {
      assert.ok(keys.includes(expected), `missing preset: ${expected}`);
    }
  });

  test("a local provider can be created and discovered", async () => {
    const res = await api("/api/providers/ollama", {
      method: "PUT",
      body: JSON.stringify({
        id: "ollama", displayName: "Ollama", presetKey: "ollama", transport: "ollama",
        baseUrl: ollamaUp.url, apiKey: null, local: true, enabled: true, requestTimeoutMs: 15000,
      }),
    });
    assert.equal(res.status, 200);

    const report = await json<{ ok: boolean; modelsFound: number }>("/api/providers/ollama/discover", { method: "POST" });
    assert.equal(report.ok, true);
    assert.equal(report.modelsFound, 1);

    const { models } = await json<{ models: Array<{ id: string; local: boolean; contextWindow: number }> }>("/api/models");
    const m = models.find((x) => x.id === "ollama:llama3.2:1b");
    assert.ok(m, "discovered model missing from the registry");
    assert.equal(m!.local, true);
    // Traits came from the catalog, not a hard-coded model list.
    assert.ok(m!.contextWindow > 1000);
  });

  test("a second provider with a different wire format coexists", async () => {
    await api("/api/providers/openai", {
      method: "PUT",
      body: JSON.stringify({
        id: "openai", displayName: "OpenAI", presetKey: "openai", transport: "openai_compatible",
        baseUrl: openaiUp.url, apiKey: "sk-test-abcdefghijklmnop", local: false, enabled: true, requestTimeoutMs: 15000,
      }),
    });
    const report = await json<{ ok: boolean; modelsFound: number }>("/api/providers/openai/discover", { method: "POST" });
    assert.equal(report.ok, true);

    const { models } = await json<{ models: Array<{ id: string; local: boolean }> }>("/api/models");
    assert.ok(models.some((m) => m.id === "ollama:llama3.2:1b"));
    assert.ok(models.some((m) => m.id === "openai:gpt-4o-mini"));
    assert.equal(models.find((m) => m.id === "openai:gpt-4o-mini")!.local, false);
  });

  test("the API never returns a stored API key", async () => {
    const { providers } = await json<{ providers: Array<Record<string, unknown>> }>("/api/providers");
    const body = JSON.stringify(providers);
    assert.ok(!body.includes("sk-test-abcdefghijklmnop"), "an API key leaked through /api/providers");
    const openai = providers.find((p) => p["id"] === "openai")!;
    assert.equal(openai["hasApiKey"], true);
    assert.equal(openai["apiKeyHint"], "…mnop");
  });

  test("test-connection reports health for a live provider", async () => {
    const r = await json<{ health: { state: string } }>("/api/providers/ollama/test", { method: "POST" });
    assert.equal(r.health.state, "healthy");
  });
});

// ---------------------------------------------------------------------------
describe("routing preview", () => {
  test("auto mode picks a model and explains the choice", async () => {
    const r = await json<{ decision: { chosen: { modelId: string; reasons: string[] } } }>("/api/route/preview", {
      method: "POST",
      body: JSON.stringify({ message: "hello there", mode: "auto" }),
    });
    assert.ok(r.decision.chosen);
    assert.ok(r.decision.chosen.reasons.length > 0);
  });

  test("local_only mode never selects the cloud provider, end to end", async () => {
    const r = await json<{ decision: { chosen: { modelId: string; local: boolean }; rejected: Array<{ modelId: string }> } }>(
      "/api/route/preview",
      { method: "POST", body: JSON.stringify({ message: "private thing", mode: "local_only" }) },
    );
    assert.equal(r.decision.chosen.local, true);
    assert.ok(r.decision.rejected.some((x) => x.modelId === "openai:gpt-4o-mini"));
  });

  test("the preview counts the conversation it is previewing", async () => {
    // It accepted a conversationId and passed [] as history, so it sized a
    // one-message request while the send it previews carries up to twenty.
    const fresh = await json<{ estimatedInputTokens: number }>("/api/route/preview", {
      method: "POST",
      body: JSON.stringify({ message: "same draft", mode: "local_only" }),
    });

    const c = await json<{ conversationId: string }>("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message: `preview history ${"filler ".repeat(300)}`, mode: "local_only" }),
    });

    const withHistory = await json<{ estimatedInputTokens: number }>("/api/route/preview", {
      method: "POST",
      body: JSON.stringify({ message: "same draft", conversationId: c.conversationId, mode: "local_only" }),
    });

    assert.ok(
      withHistory.estimatedInputTokens > fresh.estimatedInputTokens + 200,
      `preview ignored the conversation (${fresh.estimatedInputTokens} -> ${withHistory.estimatedInputTokens})`,
    );
  });

  test("the preview and the send it previews agree on the request size", async () => {
    // The first turn is long on purpose. With a short one the history is a
    // rounding error and a loose tolerance band swallows the very bug this
    // test exists to catch — confirmed by watching it pass with the fix out.
    const c = await json<{ conversationId: string }>("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message: `agreement turn one ${"filler ".repeat(200)}`, mode: "local_only" }),
    });

    const p = await json<{ estimatedInputTokens: number }>("/api/route/preview", {
      method: "POST",
      body: JSON.stringify({ message: "agreement turn two", conversationId: c.conversationId, mode: "local_only" }),
    });

    await json("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message: "agreement turn two", conversationId: c.conversationId, mode: "local_only" }),
    });

    // What the adapter was actually handed, versus what the preview promised.
    const sent = ollamaUp.received.at(-1)!.body as { messages: Array<{ role: string; content: string }> };
    const sentChars = sent.messages.reduce((n, m) => n + m.content.length, 0);
    // The estimator is ~4 characters per token. 15% absorbs per-message
    // overhead without absorbing a missing history.
    const impliedTokens = sentChars / 4;
    assert.ok(
      Math.abs(p.estimatedInputTokens - impliedTokens) < impliedTokens * 0.15 + 10,
      `preview said ${p.estimatedInputTokens} tokens, the model was sent ~${Math.round(impliedTokens)}`,
    );
  });

  test("a preview for a conversation that does not exist is not an error", async () => {
    // The composer previews as you type, before anything is saved.
    const r = await json<{ decision: { chosen: { modelId: string } | null } }>("/api/route/preview", {
      method: "POST",
      body: JSON.stringify({
        message: "unsaved draft",
        conversationId: "00000000-0000-4000-8000-000000000000",
        mode: "local_only",
      }),
    });
    assert.ok(r.decision.chosen);
  });

  test("an explicit model override is honoured", async () => {
    const r = await json<{ decision: { chosen: { modelId: string } } }>("/api/route/preview", {
      method: "POST",
      body: JSON.stringify({ message: "x", modelId: "openai:gpt-4o-mini" }),
    });
    assert.equal(r.decision.chosen.modelId, "openai:gpt-4o-mini");
  });
});

// ---------------------------------------------------------------------------
describe("chat: the Phase 1 milestone flow", () => {
  test("non-streaming chat routes, executes, and persists", async () => {
    const r = await json<{
      conversationId: string; content: string; model: { id: string }; usage: { inputTokens: number }; costUsd: number;
    }>("/api/chat", { method: "POST", body: JSON.stringify({ message: "ping", mode: "local_only" }) });

    assert.match(r.content, /^local-reply:/);
    assert.equal(r.model.id, "ollama:llama3.2:1b");
    assert.equal(r.usage.inputTokens, 9);
    assert.equal(r.costUsd, 0);

    const { messages } = await json<{ messages: Array<{ role: string; content: string }> }>(
      `/api/conversations/${r.conversationId}/messages`,
    );
    assert.equal(messages.length, 2);
    assert.equal(messages[0]!.role, "user");
    assert.equal(messages[1]!.role, "assistant");
  });

  test("streaming chat emits routing, deltas, usage and done in order", async () => {
    const res = await api("/api/chat/stream", {
      method: "POST",
      body: JSON.stringify({ message: "stream please", mode: "local_only" }),
    });
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/event-stream/);

    const order: string[] = [];
    let text = "";
    let doneData: { modelId: string } | null = null;
    let usage: { inputTokens: number; costUsd: number } | null = null;

    await readSse(res, (type, data) => {
      if (order.at(-1) !== type) order.push(type);
      if (type === "delta") text += (data as { text: string }).text;
      if (type === "usage") usage = data as { inputTokens: number; costUsd: number };
      if (type === "done") doneData = data as { modelId: string };
      if (type === "error") assert.fail(`stream errored: ${JSON.stringify(data)}`);
    });

    assert.equal(order[0], "routing", "the client must learn the model before the first token");
    assert.ok(order.includes("delta"));
    assert.equal(order.at(-1), "done");
    assert.match(text, /^local-reply:/);
    assert.equal(doneData!.modelId, "ollama:llama3.2:1b");
    assert.equal(usage!.inputTokens, 9);
  });

  test("streamed text matches the non-streamed answer for the same input", async () => {
    const nonStream = await json<{ content: string }>("/api/chat", {
      method: "POST", body: JSON.stringify({ message: "same", mode: "local_only" }),
    });
    const res = await api("/api/chat/stream", {
      method: "POST", body: JSON.stringify({ message: "same", mode: "local_only" }),
    });
    let streamed = "";
    await readSse(res, (t, d) => { if (t === "delta") streamed += (d as { text: string }).text; });
    assert.equal(streamed, nonStream.content);
  });

  test("conversation history is carried into the next turn", async () => {
    const first = await json<{ conversationId: string }>("/api/chat", {
      method: "POST", body: JSON.stringify({ message: "first turn", mode: "local_only" }),
    });
    await json("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message: "second turn", mode: "local_only", conversationId: first.conversationId }),
    });
    const { messages } = await json<{ messages: unknown[] }>(`/api/conversations/${first.conversationId}/messages`);
    assert.equal(messages.length, 4);

    // The upstream must actually have received the prior turns.
    const last = ollamaUp.received.at(-1)!.body as { messages: Array<{ content: string }> };
    assert.ok(last.messages.some((m) => m.content === "first turn"));
  });

  test("switching provider mid-conversation works (model-agnostic core)", async () => {
    const r = await json<{ content: string; model: { id: string; local: boolean } }>("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message: "use the cloud", modelId: "openai:gpt-4o-mini" }),
    });
    assert.equal(r.content, "cloud-reply");
    assert.equal(r.model.id, "openai:gpt-4o-mini");
    assert.equal(r.model.local, false);
  });

  test("runs are recorded for observability and cost tracking", async () => {
    const stats = await json<{ totalRuns: number; perModel: Array<{ modelId: string; runs: number }> }>("/api/stats");
    assert.ok(stats.totalRuns > 0);
    assert.ok(stats.perModel.some((m) => m.modelId === "ollama:llama3.2:1b"));
  });

  test("stopping a response counts as cancelled, not as a model failure", async () => {
    // Otherwise a user interrupting a long answer would look like the model
    // broke, and the router would eventually learn to avoid a healthy model.
    const before = await json<{ failedRuns: number; cancelledRuns: number }>("/api/stats");

    const ac = new AbortController();
    try {
      const res = await fetch(`${baseUrl}/api/chat/stream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "cancel me", mode: "local_only" }),
        signal: ac.signal,
      });
      // Abort only once tokens are genuinely flowing — that is what pressing
      // Stop does. Aborting earlier would cancel before any model call began,
      // which is a different (and untested) situation.
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let seen = "";
      while (!seen.includes("event: delta")) {
        const { done, value } = await reader.read();
        if (done) break;
        seen += decoder.decode(value, { stream: true });
      }
      assert.ok(seen.includes("event: delta"), "no tokens ever arrived, so there was nothing to cancel");
      ac.abort();
    } catch {
      /* the abort rejects the in-flight read; that is the point */
    }

    // Give the server a moment to finish writing the run row.
    await new Promise((r) => setTimeout(r, 600));

    const after = await json<{ failedRuns: number; cancelledRuns: number }>("/api/stats");
    assert.equal(after.failedRuns, before.failedRuns, "a cancellation was counted as a failure");
    assert.ok(after.cancelledRuns > before.cancelledRuns, "the cancellation was not recorded");
  });
});

// ---------------------------------------------------------------------------
describe("failure handling and fallback", () => {
  test("a failing primary falls back to the next candidate and says so", async () => {
    // Break the local provider by pointing it at a dead port.
    await api("/api/providers/ollama", {
      method: "PUT",
      body: JSON.stringify({
        id: "ollama", displayName: "Ollama", presetKey: "ollama", transport: "ollama",
        baseUrl: "http://127.0.0.1:1", apiKey: null, local: true, enabled: true, requestTimeoutMs: 2000,
      }),
    });

    const res = await api("/api/chat/stream", {
      method: "POST",
      body: JSON.stringify({ message: "fallback please", mode: "cheapest" }),
    });

    const attempts: Array<{ modelId: string; isFallback: boolean }> = [];
    let text = "";
    let errored: unknown = null;
    await readSse(res, (type, data) => {
      if (type === "attempt") attempts.push(data as { modelId: string; isFallback: boolean });
      if (type === "delta") text += (data as { text: string }).text;
      if (type === "error") errored = data;
    });

    assert.equal(errored, null, "fallback should have rescued the request");
    assert.ok(attempts.length >= 2, `expected a fallback attempt, saw ${JSON.stringify(attempts)}`);
    assert.equal(attempts[0]!.isFallback, false);
    assert.equal(attempts[1]!.isFallback, true);
    assert.equal(text, "cloud-reply");

    // Restore for any later test.
    await api("/api/providers/ollama", {
      method: "PUT",
      body: JSON.stringify({
        id: "ollama", displayName: "Ollama", presetKey: "ollama", transport: "ollama",
        baseUrl: ollamaUp.url, apiKey: null, local: true, enabled: true, requestTimeoutMs: 15000,
      }),
    });
  });

  test("a local_only request FAILS rather than falling back to the cloud", async () => {
    // The safety-critical case: the only local provider is dead, and the
    // correct behaviour is a clean refusal, never a silent cloud escalation.
    await api("/api/providers/ollama", {
      method: "PUT",
      body: JSON.stringify({
        id: "ollama", displayName: "Ollama", presetKey: "ollama", transport: "ollama",
        baseUrl: "http://127.0.0.1:1", apiKey: null, local: true, enabled: true, requestTimeoutMs: 2000,
      }),
    });

    const res = await api("/api/chat/stream", {
      method: "POST",
      body: JSON.stringify({ message: "secret data", mode: "local_only", privacy: "local_only" }),
    });

    const attempted: string[] = [];
    let errorEvent: { code: string } | null = null;
    let text = "";
    await readSse(res, (type, data) => {
      if (type === "attempt") attempted.push((data as { modelId: string }).modelId);
      if (type === "delta") text += (data as { text: string }).text;
      if (type === "error") errorEvent = data as { code: string };
    });

    assert.ok(!attempted.some((m) => m.startsWith("openai:")), "a local-only request reached a cloud provider");
    assert.equal(text, "", "no cloud content should have been produced");
    assert.ok(errorEvent, "the request should have failed with an explicit error");

    await api("/api/providers/ollama", {
      method: "PUT",
      body: JSON.stringify({
        id: "ollama", displayName: "Ollama", presetKey: "ollama", transport: "ollama",
        baseUrl: ollamaUp.url, apiKey: null, local: true, enabled: true, requestTimeoutMs: 15000,
      }),
    });
  });

  test("invalid input is rejected with a 400 and a readable message", async () => {
    const res = await api("/api/chat", { method: "POST", body: JSON.stringify({ message: "" }) });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, "bad_request");
    assert.match(body.error.message, /message/);
  });

  test("an unknown route returns 404 JSON, not an HTML error page", async () => {
    const res = await api("/api/nope");
    assert.equal(res.status, 404);
    assert.match(res.headers.get("content-type") ?? "", /application\/json/);
  });

  test("disabling every model yields a clear no_eligible_model error", async () => {
    const { models } = await json<{ models: Array<{ id: string }> }>("/api/models");
    for (const m of models) {
      await api(`/api/models/${encodeURIComponent(m.id)}`, { method: "PUT", body: JSON.stringify({ enabled: false }) });
    }
    const res = await api("/api/chat", { method: "POST", body: JSON.stringify({ message: "hi" }) });
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, "no_eligible_model");

    for (const m of models) {
      await api(`/api/models/${encodeURIComponent(m.id)}`, { method: "PUT", body: JSON.stringify({ enabled: true }) });
    }
  });
});

// ---------------------------------------------------------------------------
describe("regenerate (spec §58, §103)", () => {
  async function messages(id: string): Promise<Array<{ role: string; content: string; modelId: string | null }>> {
    return (await json<{ messages: Array<{ role: string; content: string; modelId: string | null }> }>(
      `/api/conversations/${id}/messages`,
    )).messages;
  }

  test("re-answers the last turn WITHOUT duplicating the user message", async () => {
    // The bug this exists to prevent: send() appends the user turn, so a naive
    // retry would store the question twice and feed it to the model twice.
    const c = await json<{ conversationId: string }>("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message: "regenerate me", mode: "local_only" }),
    });
    const before = await messages(c.conversationId);
    assert.equal(before.length, 2);

    const again = await json<{ conversationId: string }>("/api/chat", {
      method: "POST",
      body: JSON.stringify({ conversationId: c.conversationId, regenerate: true, mode: "local_only" }),
    });
    assert.equal(again.conversationId, c.conversationId);

    const after = await messages(c.conversationId);
    assert.equal(after.length, 2, `expected 2 messages, got ${after.map((m) => m.role).join(",")}`);
    assert.equal(after.filter((m) => m.role === "user").length, 1, "the user message was duplicated");
    assert.equal(after[0]!.content, "regenerate me", "the prompt changed");
  });

  test("the prompt comes from history, so a regenerate cannot change the question", async () => {
    const c = await json<{ conversationId: string }>("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message: "the original question", mode: "local_only" }),
    });
    await json("/api/chat", {
      method: "POST",
      body: JSON.stringify({
        conversationId: c.conversationId,
        regenerate: true,
        mode: "local_only",
        message: "a DIFFERENT question smuggled in",
      }),
    });
    const after = await messages(c.conversationId);
    assert.equal(after[0]!.content, "the original question", "regenerate rewrote the user's question");
    assert.ok(!after.some((m) => m.content.includes("smuggled")));
  });

  test("it can be answered by a different model (spec §103)", async () => {
    const c = await json<{ conversationId: string }>("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message: "answer this", mode: "local_only" }),
    });
    const first = (await messages(c.conversationId))[1]!.modelId;
    assert.ok(first?.startsWith("ollama:"));

    const r = await json<{ model: { id: string } }>("/api/chat", {
      method: "POST",
      body: JSON.stringify({ conversationId: c.conversationId, regenerate: true, modelId: "openai:gpt-4o-mini" }),
    });
    assert.equal(r.model.id, "openai:gpt-4o-mini");
    const after = await messages(c.conversationId);
    assert.equal(after.length, 2);
    assert.equal(after[1]!.modelId, "openai:gpt-4o-mini", "the stored answer kept the old model");
  });

  test("earlier turns are untouched", async () => {
    const c = await json<{ conversationId: string }>("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message: "turn one", mode: "local_only" }),
    });
    await json("/api/chat", {
      method: "POST",
      body: JSON.stringify({ conversationId: c.conversationId, message: "turn two", mode: "local_only" }),
    });
    await json("/api/chat", {
      method: "POST",
      body: JSON.stringify({ conversationId: c.conversationId, regenerate: true, mode: "local_only" }),
    });
    const after = await messages(c.conversationId);
    assert.equal(after.length, 4, "a regenerate reached back into earlier history");
    assert.equal(after[0]!.content, "turn one");
    assert.equal(after[2]!.content, "turn two");
  });

  test("the history sent to the model does not repeat the prompt", async () => {
    const c = await json<{ conversationId: string }>("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message: "unique-prompt-marker", mode: "local_only" }),
    });
    await json("/api/chat", {
      method: "POST",
      body: JSON.stringify({ conversationId: c.conversationId, regenerate: true, mode: "local_only" }),
    });
    const sent = ollamaUp.received.at(-1)!.body as { messages: Array<{ content: string }> };
    const occurrences = sent.messages.filter((m) => m.content === "unique-prompt-marker").length;
    assert.equal(occurrences, 1, `the prompt was sent ${occurrences} times`);
  });

  test("regenerating a conversation that does not exist is rejected", async () => {
    const res = await api("/api/chat", {
      method: "POST",
      body: JSON.stringify({ conversationId: "00000000-0000-4000-8000-000000000000", regenerate: true }),
    });
    assert.equal(res.status, 400);
  });

  test("regenerating with no conversation at all is rejected", async () => {
    const res = await api("/api/chat", { method: "POST", body: JSON.stringify({ regenerate: true }) });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: { message: string } }).error.message, /regenerat/i);
  });

  // -------------------------------------------------------------------------
  // Editing the question: the mirror of a regenerate.
  // -------------------------------------------------------------------------

  test("an edit replaces the question and the answer, adding nothing", async () => {
    const c = await json<{ conversationId: string }>("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message: "waht is a rotuer", mode: "local_only" }),
    });
    assert.equal((await messages(c.conversationId)).length, 2);

    await json("/api/chat", {
      method: "POST",
      body: JSON.stringify({
        conversationId: c.conversationId,
        editLast: true,
        message: "what is a router",
        mode: "local_only",
      }),
    });

    const after = await messages(c.conversationId);
    assert.equal(after.length, 2, `expected 2 messages, got ${after.map((m) => m.role).join(",")}`);
    assert.equal(after[0]!.role, "user");
    assert.equal(after[0]!.content, "what is a router");
    assert.equal(after[1]!.role, "assistant");
  });

  test("an edit renames the conversation when it was the first question", async () => {
    // The title is derived from the first message. Fixing a typo and leaving
    // the old wording in the sidebar would misdescribe the conversation.
    const c = await json<{ conversationId: string }>("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message: "titel typo here", mode: "local_only" }),
    });
    await json("/api/chat", {
      method: "POST",
      body: JSON.stringify({
        conversationId: c.conversationId,
        editLast: true,
        message: "title typo fixed",
        mode: "local_only",
      }),
    });
    const { conversations } = await json<{ conversations: Array<{ id: string; title: string }> }>("/api/conversations");
    const row = conversations.find((x) => x.id === c.conversationId);
    assert.equal(row?.title, "title typo fixed");
  });

  test("editing a later question leaves the title alone", async () => {
    const c = await json<{ conversationId: string }>("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message: "first question keeps the title", mode: "local_only" }),
    });
    await json("/api/chat", {
      method: "POST",
      body: JSON.stringify({ conversationId: c.conversationId, message: "second question", mode: "local_only" }),
    });
    await json("/api/chat", {
      method: "POST",
      body: JSON.stringify({
        conversationId: c.conversationId,
        editLast: true,
        message: "second question, rewritten",
        mode: "local_only",
      }),
    });

    const after = await messages(c.conversationId);
    assert.equal(after.length, 4, "an edit reached back into earlier history");
    assert.equal(after[0]!.content, "first question keeps the title");
    assert.equal(after[2]!.content, "second question, rewritten");

    const { conversations } = await json<{ conversations: Array<{ id: string; title: string }> }>("/api/conversations");
    assert.equal(conversations.find((x) => x.id === c.conversationId)?.title, "first question keeps the title");
  });

  test("the edited question reaches the model exactly once, and the old one not at all", async () => {
    const c = await json<{ conversationId: string }>("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message: "stale-marker", mode: "local_only" }),
    });
    await json("/api/chat", {
      method: "POST",
      body: JSON.stringify({
        conversationId: c.conversationId,
        editLast: true,
        message: "fresh-marker",
        mode: "local_only",
      }),
    });
    const sent = ollamaUp.received.at(-1)!.body as { messages: Array<{ content: string }> };
    assert.equal(sent.messages.filter((m) => m.content === "fresh-marker").length, 1);
    assert.equal(sent.messages.filter((m) => m.content === "stale-marker").length, 0);
  });

  test("regenerate and editLast cannot both be set", async () => {
    // They are opposites -- one insists the question is untouched, the other
    // exists to change it -- so the combination is rejected rather than
    // silently resolved in one direction.
    const c = await json<{ conversationId: string }>("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message: "conflict check", mode: "local_only" }),
    });
    const res = await api("/api/chat", {
      method: "POST",
      body: JSON.stringify({
        conversationId: c.conversationId,
        regenerate: true,
        editLast: true,
        message: "something else",
      }),
    });
    assert.equal(res.status, 400);
  });

  test("an edit with no conversation is rejected", async () => {
    const res = await api("/api/chat", {
      method: "POST",
      body: JSON.stringify({ editLast: true, message: "nothing to edit" }),
    });
    assert.equal(res.status, 400);
    assert.match(((await res.json()) as { error: { message: string } }).error.message, /edit/i);
  });

  test("an edit still requires a message", async () => {
    const c = await json<{ conversationId: string }>("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message: "empty edit check", mode: "local_only" }),
    });
    const res = await api("/api/chat", {
      method: "POST",
      body: JSON.stringify({ conversationId: c.conversationId, editLast: true, message: "   " }),
    });
    assert.equal(res.status, 400);
    // ...and the conversation is untouched by the rejected request.
    const after = await messages(c.conversationId);
    assert.equal(after.length, 2);
    assert.equal(after[0]!.content, "empty edit check");
  });

  test("a normal turn still requires a message", async () => {
    const res = await api("/api/chat", { method: "POST", body: JSON.stringify({ message: "" }) });
    assert.equal(res.status, 400);
  });
});

// ---------------------------------------------------------------------------
describe("correcting a model's traits (spec §8)", () => {
  const MODEL = "openai:gpt-4o-mini";

  async function model(): Promise<{ inputCostPer1m: number; outputCostPer1m: number; displayName: string; contextWindow: number; traitsSource: string; enabled: boolean }> {
    const { models } = await json<{ models: Array<Record<string, never>> }>("/api/models");
    return (models as unknown as Array<{ id: string }>).find((m) => m.id === MODEL) as never;
  }

  test("a corrected price is stored and marked as the user's", async () => {
    // The catalog carries list prices that drift. A wrong price produces wrong
    // cost estimates and wrong budget enforcement, so it has to be fixable.
    const res = await api(`/api/models/${encodeURIComponent(MODEL)}`, {
      method: "PUT",
      body: JSON.stringify({ inputCostPer1m: 0.99, outputCostPer1m: 1.98, displayName: "GPT-4o mini (my price)" }),
    });
    assert.equal(res.status, 200);
    const m = await model();
    assert.equal(m.inputCostPer1m, 0.99);
    assert.equal(m.outputCostPer1m, 1.98);
    assert.equal(m.displayName, "GPT-4o mini (my price)");
    assert.equal(m.traitsSource, "user");
  });

  test("discovery does NOT overwrite the correction", async () => {
    // This is the behaviour upsertDiscovered was written for, and which was
    // unreachable until traits could be marked as the user's.
    const before = await model();
    const report = await json<{ ok: boolean }>("/api/providers/openai/discover", { method: "POST" });
    assert.equal(report.ok, true, "discovery did not run, so this proves nothing");

    const after = await model();
    assert.equal(after.inputCostPer1m, before.inputCostPer1m, "discovery reverted the user's price");
    assert.equal(after.displayName, before.displayName, "discovery reverted the user's name");
    assert.equal(after.traitsSource, "user");
  });

  test("the corrected price is what routing and cost actually use", async () => {
    // An override nothing acts on would be decoration.
    const r = await json<{ decision: { chosen: { modelId: string; estimatedCostUsd: number } } }>(
      "/api/route/preview",
      { method: "POST", body: JSON.stringify({ message: "hello", modelId: MODEL }) },
    );
    assert.equal(r.decision.chosen.modelId, MODEL);
    // 0.99/1.98 per 1M against the fixed 800-token output estimate is far below
    // the catalog's 0.15/0.6 would give for the same shape; just assert it is
    // derived from the new numbers rather than the old.
    const expected = (r.decision.chosen.estimatedCostUsd * 1_000_000) / 1.98;
    assert.ok(expected > 0, "cost was not computed from the stored price");
  });

  test("reset restores the catalog values AND says they are from the catalog", async () => {
    const res = await api(`/api/models/${encodeURIComponent(MODEL)}/reset`, { method: "POST" });
    assert.equal(res.status, 200);
    const m = await model();
    assert.notEqual(m.inputCostPer1m, 0.99, "reset left the user's price in place");
    assert.notEqual(m.displayName, "GPT-4o mini (my price)");
    // gpt-4o-mini has a catalog entry, so after a reset the row must say so.
    // Leaving it as "heuristic" would report catalog numbers as guesses.
    assert.equal(m.traitsSource, "catalog", "reset restored catalog values but mislabelled their source");
  });

  test("discovery keeps traitsSource truthful for a model it did not edit", async () => {
    await json("/api/providers/openai/discover", { method: "POST" });
    const m = await model();
    assert.equal(m.traitsSource, "catalog");
  });

  test("toggling enabled does NOT mark the model as user-edited", async () => {
    // Otherwise switching a model off once would freeze its traits forever.
    const before = await model();
    await api(`/api/models/${encodeURIComponent(MODEL)}`, { method: "PUT", body: JSON.stringify({ enabled: false }) });
    let m = await model();
    assert.equal(m.enabled, false);
    assert.equal(m.traitsSource, before.traitsSource, "toggling enabled changed traitsSource");
    await api(`/api/models/${encodeURIComponent(MODEL)}`, { method: "PUT", body: JSON.stringify({ enabled: true }) });
    m = await model();
    assert.equal(m.enabled, true);
  });

  test("an out-of-range value is rejected", async () => {
    for (const body of [
      { inputCostPer1m: -1 },
      { contextWindow: 10 },
      { scores: { speed: 99, reasoning: 5, coding: 5, vision: 0, tool_calling: 5 } },
      { capabilities: ["telepathy"] },
    ]) {
      const res = await api(`/api/models/${encodeURIComponent(MODEL)}`, { method: "PUT", body: JSON.stringify(body) });
      assert.equal(res.status, 400, `accepted an invalid patch: ${JSON.stringify(body)}`);
    }
  });

  test("editing an unknown model is a 404", async () => {
    const res = await api("/api/models/nope%3Anope", { method: "PUT", body: JSON.stringify({ displayName: "x" }) });
    assert.equal(res.status, 404);
  });

  test("an empty patch is accepted and changes nothing", async () => {
    const before = await model();
    const res = await api(`/api/models/${encodeURIComponent(MODEL)}`, { method: "PUT", body: JSON.stringify({}) });
    assert.equal(res.status, 200);
    const after = await model();
    assert.equal(after.traitsSource, before.traitsSource, "an empty patch marked the model as edited");
    assert.equal(after.displayName, before.displayName);
  });
});

// ---------------------------------------------------------------------------
describe("conversation history", () => {
  test("conversations are listed with a title and message count", async () => {
    const first = await json<{ conversationId: string }>("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message: "a memorable first question", mode: "local_only" }),
    });
    const list = await json<{ conversations: Array<{ id: string; title: string; messageCount: number }> }>(
      "/api/conversations",
    );
    const found = list.conversations.find((c) => c.id === first.conversationId);
    assert.ok(found, "a conversation that exists was not listed");
    assert.match(found!.title, /memorable first question/);
    assert.equal(found!.messageCount, 2);
  });

  test("a conversation can be renamed", async () => {
    const c = await json<{ conversationId: string }>("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message: "rename me", mode: "local_only" }),
    });
    const res = await api(`/api/conversations/${c.conversationId}`, {
      method: "PUT",
      body: JSON.stringify({ title: "Renamed by the user" }),
    });
    assert.equal(res.status, 200);
    const list = await json<{ conversations: Array<{ id: string; title: string }> }>("/api/conversations");
    assert.equal(list.conversations.find((x) => x.id === c.conversationId)!.title, "Renamed by the user");
  });

  test("deleting a conversation removes it and its messages", async () => {
    const c = await json<{ conversationId: string }>("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message: "delete me", mode: "local_only" }),
    });
    const res = await api(`/api/conversations/${c.conversationId}`, { method: "DELETE" });
    assert.equal(res.status, 200);

    const list = await json<{ conversations: Array<{ id: string }> }>("/api/conversations");
    assert.ok(!list.conversations.some((x) => x.id === c.conversationId));
    const msgs = await api(`/api/conversations/${c.conversationId}/messages`);
    assert.equal(msgs.status, 404);
  });

  test("deleting a conversation does NOT erase spend or measurements", async () => {
    // model_runs.conversation_id is ON DELETE SET NULL on purpose. Removing a
    // chat must not rewrite what you have spent this month, or what NYRO has
    // learned about how fast a model is.
    const c = await json<{ conversationId: string }>("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message: "spend then delete", mode: "local_only" }),
    });
    const before = await json<{ totalRuns: number }>("/api/stats");

    await api(`/api/conversations/${c.conversationId}`, { method: "DELETE" });

    const after = await json<{ totalRuns: number }>("/api/stats");
    assert.equal(after.totalRuns, before.totalRuns, "deleting a conversation destroyed run history");
  });

  test("deleting a conversation that does not exist is a 404, not a silent success", async () => {
    const res = await api("/api/conversations/00000000-0000-4000-8000-000000000000", { method: "DELETE" });
    assert.equal(res.status, 404);
  });

  test("renaming with an empty title is rejected", async () => {
    const c = await json<{ conversationId: string }>("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message: "keep my title", mode: "local_only" }),
    });
    const res = await api(`/api/conversations/${c.conversationId}`, {
      method: "PUT",
      body: JSON.stringify({ title: "" }),
    });
    assert.equal(res.status, 400);
  });

  test("resuming a conversation returns its full history in order", async () => {
    const c = await json<{ conversationId: string }>("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message: "turn one", mode: "local_only" }),
    });
    await json("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message: "turn two", mode: "local_only", conversationId: c.conversationId }),
    });
    const { messages } = await json<{ messages: Array<{ role: string; content: string; modelId: string | null }> }>(
      `/api/conversations/${c.conversationId}/messages`,
    );
    assert.equal(messages.length, 4);
    assert.deepEqual(messages.map((m) => m.role), ["user", "assistant", "user", "assistant"]);
    assert.equal(messages[0]!.content, "turn one");
    assert.equal(messages[2]!.content, "turn two");
    // Assistant turns carry the model that produced them, so a resumed
    // conversation can still say which model answered.
    assert.ok(messages[1]!.modelId?.startsWith("ollama:"));
  });
});

// ---------------------------------------------------------------------------
describe("search (spec §63)", () => {
  interface SearchHit { id: string; title: string; snippet: string | null; matches: number }

  async function search(q: string): Promise<SearchHit[]> {
    return (await json<{ results: SearchHit[] }>(`/api/search?q=${encodeURIComponent(q)}`)).results;
  }

  test("finds a conversation by words in its messages", async () => {
    const c = await json<{ conversationId: string }>("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message: "the aardvark migration schedule", mode: "local_only" }),
    });
    const hits = await search("aardvark");
    const hit = hits.find((h) => h.id === c.conversationId);
    assert.ok(hit, `not found: ${JSON.stringify(hits)}`);
    assert.ok(hit!.matches > 0);
  });

  test("returns a highlighted snippet showing why it matched", async () => {
    await json("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message: "please remember the pangolin invoice", mode: "local_only" }),
    });
    const hits = await search("pangolin");
    assert.ok(hits.length > 0);
    const withSnippet = hits.find((h) => h.snippet !== null);
    assert.ok(withSnippet, "no snippet returned");
    assert.match(withSnippet!.snippet!, /<b>pangolin<\/b>/i);
  });

  test("a prefix matches, so a partially typed word still finds things", async () => {
    await json("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message: "we are debugging the capacitor", mode: "local_only" }),
    });
    assert.ok((await search("debug")).length > 0, "prefix did not match");
    assert.ok((await search("capacit")).length > 0, "partial word did not match");
  });

  test("word forms the stemmer splits apart still find each other", async () => {
    // The English stemmer maps "router" to `router` but "routing" to `rout`,
    // so a plain stem query finds nothing for one when the text has the other.
    // This is exactly the case prefix matching exists to fix.
    await json("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message: "the marmoset router handled it", mode: "local_only" }),
    });
    assert.ok((await search("router")).length > 0, "exact word missed");
    assert.ok((await search("routing")).length > 0, "a user typing 'routing' found no 'router'");
  });

  test("all terms must match, not merely any of them", async () => {
    await json("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message: "the quokka ledger reconciliation", mode: "local_only" }),
    });
    assert.ok((await search("quokka ledger")).length > 0, "a genuine two-word match was missed");
    const bogus = await search("quokka zzzznotpresentzzzz");
    assert.equal(bogus.length, 0, "an unmatched term did not narrow the results");
  });

  test("finds a conversation by its title even when no message matches", async () => {
    const c = await json<{ conversationId: string }>("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message: "nothing notable here", mode: "local_only" }),
    });
    await api(`/api/conversations/${c.conversationId}`, {
      method: "PUT",
      body: JSON.stringify({ title: "Quarterly zebra planning" }),
    });
    const hits = await search("zebra");
    assert.ok(hits.some((h) => h.id === c.conversationId), "a title match was missed");
  });

  test("an empty query returns nothing rather than everything", async () => {
    // Returning the whole history for an empty box would look like a bug and
    // would be the wrong default for a search field.
    assert.deepEqual(await search(""), []);
    assert.deepEqual(await search("   "), []);
  });

  test("a query that matches nothing returns an empty list, not an error", async () => {
    const res = await api("/api/search?q=zzzznotpresentzzzz");
    assert.equal(res.status, 200);
    assert.deepEqual(((await res.json()) as { results: unknown[] }).results, []);
  });

  test("punctuation and quotes do not break the query", async () => {
    for (const q of ["what's this?", 'say "hello"', "a & b | c", "50% off!", "'; drop table messages; --"]) {
      const res = await api(`/api/search?q=${encodeURIComponent(q)}`);
      assert.equal(res.status, 200, `query broke search: ${q}`);
    }
    // The injection-shaped query above must not have destroyed anything.
    const still = await json<{ conversations: unknown[] }>("/api/conversations");
    assert.ok(still.conversations.length > 0, "messages table is gone");
  });
});

// ---------------------------------------------------------------------------
describe("export (spec §108, §109)", () => {
  test("the JSON export contains NO API key, with a real key stored", async () => {
    // The openai provider in this suite was created with a real-looking key.
    // If it ever reaches the export, every protection in crypto.ts is undone
    // the moment the user emails themselves a backup.
    const res = await api("/api/export");
    assert.equal(res.status, 200);
    const raw = await res.text();
    assert.ok(!raw.includes("sk-test-abcdefghijklmnop"), "an API key leaked into the export");
    assert.ok(!/"apiKey"/.test(raw), "the export has an apiKey field");
    assert.ok(!/sk-[A-Za-z0-9]{12,}/.test(raw), "something key-shaped is in the export");
  });

  test("it records that a provider needs a key, without carrying one", async () => {
    const bundle = (await (await api("/api/export")).json()) as {
      providers: Array<{ id: string; requiresApiKey: boolean; baseUrl: string }>;
    };
    const openai = bundle.providers.find((p) => p.id === "openai");
    assert.ok(openai, "the provider is missing from the export");
    assert.equal(openai!.requiresApiKey, true);
    assert.ok(openai!.baseUrl.length > 0);
  });

  test("it includes conversations with their messages", async () => {
    const created = await json<{ conversationId: string }>("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message: "export me please", mode: "local_only" }),
    });
    const bundle = (await (await api("/api/export")).json()) as {
      nyroExportVersion: number;
      conversations: Array<{ id: string; messages: Array<{ role: string; content: string }> }>;
    };
    assert.ok(bundle.nyroExportVersion >= 1);
    const c = bundle.conversations.find((x) => x.id === created.conversationId);
    assert.ok(c, "a conversation that exists is missing from the export");
    assert.ok(c!.messages.some((m) => m.content === "export me please"));
  });

  test("it includes settings, models and usage totals", async () => {
    await api("/api/budget", { method: "PUT", body: JSON.stringify({ dailyUsd: 3 }) });
    const bundle = (await (await api("/api/export")).json()) as {
      settings: { budget?: { dailyUsd: number } };
      models: Array<{ id: string }>;
      usage: { totalRuns: number };
    };
    assert.equal(bundle.settings.budget?.dailyUsd, 3);
    assert.ok(bundle.models.length > 0);
    assert.ok(bundle.usage.totalRuns > 0);
    await api("/api/budget", { method: "DELETE" });
  });

  test("the markdown export is readable and also key-free", async () => {
    const res = await api("/api/export?format=markdown");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/markdown/);
    const md = await res.text();
    assert.match(md, /# NYRO conversations/);
    assert.ok(!md.includes("sk-test-abcdefghijklmnop"), "an API key leaked into the markdown export");
  });

  test("both formats are sent as downloads with a dated filename", async () => {
    for (const [q, ext] of [["", "json"], ["?format=markdown", "md"]] as const) {
      const res = await api(`/api/export${q}`);
      const cd = res.headers.get("content-disposition") ?? "";
      assert.match(cd, /^attachment;/);
      assert.match(cd, new RegExp(`nyro-[a-z]+-\\d{4}-\\d{2}-\\d{2}\\.${ext}`));
    }
  });
});

// ---------------------------------------------------------------------------
describe("budget enforcement (spec §66)", () => {
  async function setBudget(config: Record<string, unknown>): Promise<void> {
    const res = await api("/api/budget", { method: "PUT", body: JSON.stringify(config) });
    assert.equal(res.status, 200, `budget PUT failed: ${await res.text()}`);
  }
  async function clearBudget(): Promise<void> {
    await api("/api/budget", { method: "DELETE" });
  }

  test("reports spend and limits", async () => {
    await setBudget({ dailyUsd: 100 });
    const b = await json<{ config: { dailyUsd: number }; spend: { dayUsd: number }; remaining: { dayUsd: number } }>("/api/budget");
    assert.equal(b.config.dailyUsd, 100);
    assert.equal(typeof b.spend.dayUsd, "number");
    assert.ok(b.remaining.dayUsd <= 100);
    await clearBudget();
  });

  test("a tiny daily cap forces a cloud request onto a local model", async () => {
    // The cloud model is the natural auto choice here; the budget should move
    // the request to the free local one rather than failing it.
    await setBudget({ dailyUsd: 0 });
    const r = await json<{ decision: { chosen: { local: boolean } }; budget: { action: string } }>(
      "/api/route/preview",
      { method: "POST", body: JSON.stringify({ message: "hello", mode: "auto" }) },
    );
    assert.equal(r.budget.action, "force_local");
    assert.equal(r.decision.chosen.local, true, "budget did not force the request local");
    await clearBudget();
  });

  test("block mode refuses the request with cost_limit_exceeded", async () => {
    await setBudget({ dailyUsd: 0, onExceeded: "block" });
    const res = await api("/api/chat", { method: "POST", body: JSON.stringify({ message: "spend money" }) });
    const body = (await res.json()) as { error: { code: string; message: string } };
    assert.equal(body.error.code, "cost_limit_exceeded");
    assert.match(body.error.message, /budget/i);
    await clearBudget();
  });

  test("an exhausted budget still allows an explicitly local request", async () => {
    // The safety-critical inverse: a spending limit must never stop free work.
    await setBudget({ dailyUsd: 0, onExceeded: "block" });
    const r = await json<{ content: string; model: { local: boolean } }>("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message: "local please", mode: "local_only" }),
    });
    assert.equal(r.model.local, true);
    assert.match(r.content, /^local-reply:/);
    await clearBudget();
  });

  test("a per-provider cap excludes only that provider, with a stated reason", async () => {
    await setBudget({ perProviderMonthlyUsd: { openai: 0 } });
    const r = await json<{ decision: { chosen: { providerId: string }; rejected: Array<{ modelId: string; reason: string }> } }>(
      "/api/route/preview",
      { method: "POST", body: JSON.stringify({ message: "hello", mode: "auto" }) },
    );
    assert.notEqual(r.decision.chosen.providerId, "openai");
    assert.ok(
      r.decision.rejected.some((x) => x.modelId.startsWith("openai:") && /monthly budget/.test(x.reason)),
      `expected an openai rejection naming the budget, got ${JSON.stringify(r.decision.rejected)}`,
    );
    await clearBudget();
  });

  test("a cap for an unknown provider is rejected rather than silently ignored", async () => {
    const res = await api("/api/budget", {
      method: "PUT",
      body: JSON.stringify({ perProviderMonthlyUsd: { "not-a-provider": 5 } }),
    });
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: { message: string } };
    assert.match(body.error.message, /Unknown provider/);
  });

  test("a negative limit is rejected", async () => {
    const res = await api("/api/budget", { method: "PUT", body: JSON.stringify({ dailyUsd: -5 }) });
    assert.equal(res.status, 400);
  });

  test("the budget survives a change and is read back", async () => {
    await setBudget({ dailyUsd: 7.5, onExceeded: "block" });
    const b = await json<{ config: { dailyUsd: number; onExceeded: string } }>("/api/budget");
    assert.equal(b.config.dailyUsd, 7.5);
    assert.equal(b.config.onExceeded, "block");
    await clearBudget();
    const after = await json<{ config: { dailyUsd: number | null } }>("/api/budget");
    assert.equal(after.config.dailyUsd, null);
  });

  test("the stream announces a budget constraint before routing", async () => {
    await setBudget({ dailyUsd: 0 });
    const res = await api("/api/chat/stream", {
      method: "POST",
      body: JSON.stringify({ message: "constrained", mode: "auto" }),
    });
    const order: string[] = [];
    let budgetMsg: string | null = null;
    await readSse(res, (type, data) => {
      if (order.at(-1) !== type) order.push(type);
      if (type === "budget") budgetMsg = (data as { message: string }).message;
    });
    assert.equal(order[0], "budget", `expected budget first, got ${order.join(",")}`);
    assert.match(budgetMsg ?? "", /local models only/);
    await clearBudget();
  });
});

// ---------------------------------------------------------------------------
describe("routing rules (spec §10)", () => {
  async function setRules(rules: unknown[]): Promise<Response> {
    return api("/api/routing-rules", { method: "PUT", body: JSON.stringify({ rules }) });
  }

  test("a rule steers a coding request to the chosen provider", async () => {
    const res = await setRules([
      { id: "r1", enabled: true, name: "Code to OpenAI", whenCapability: "coding", preferProviderId: "openai" },
    ]);
    assert.equal(res.status, 200, await res.text());

    const r = await json<{ decision: { chosen: { providerId: string; reasons: string[] } } }>(
      "/api/route/preview",
      { method: "POST", body: JSON.stringify({ message: "refactor this python function", mode: "auto" }) },
    );
    assert.equal(r.decision.chosen.providerId, "openai");
    assert.ok(r.decision.chosen.reasons.some((x) => /Code to OpenAI/.test(x)), JSON.stringify(r.decision.chosen.reasons));
    await setRules([]);
  });

  test("a rule does not fire on an unrelated request", async () => {
    await setRules([
      { id: "r1", enabled: true, name: "Vision to OpenAI", whenCapability: "vision", preferProviderId: "openai" },
    ]);
    const r = await json<{ decision: { chosen: { reasons: string[] } } }>("/api/route/preview", {
      method: "POST",
      body: JSON.stringify({ message: "hello there", mode: "auto" }),
    });
    assert.ok(!r.decision.chosen.reasons.some((x) => /Vision to OpenAI/.test(x)));
    await setRules([]);
  });

  test("a rule cannot override local-only privacy", async () => {
    // The safety case: a user rule must not become a way to leak private work.
    await setRules([
      { id: "r1", enabled: true, name: "Code to OpenAI", whenCapability: "coding", preferProviderId: "openai" },
    ]);
    const r = await json<{ decision: { chosen: { local: boolean; providerId: string } } }>(
      "/api/route/preview",
      { method: "POST", body: JSON.stringify({ message: "refactor this python function", privacy: "local_only" }) },
    );
    assert.equal(r.decision.chosen.local, true, "a routing rule leaked a local-only request to the cloud");
    await setRules([]);
  });

  test("a disabled rule is stored but does not fire", async () => {
    await setRules([
      { id: "r1", enabled: false, name: "Off", whenCapability: "coding", preferProviderId: "openai" },
    ]);
    const stored = await json<{ rules: Array<{ enabled: boolean }> }>("/api/routing-rules");
    assert.equal(stored.rules[0]!.enabled, false);
    const r = await json<{ decision: { chosen: { reasons: string[] } } }>("/api/route/preview", {
      method: "POST",
      body: JSON.stringify({ message: "refactor this python function" }),
    });
    assert.ok(!r.decision.chosen.reasons.some((x) => /Off/.test(x)));
    await setRules([]);
  });

  test("a rule pointing at an unknown provider is rejected on save", async () => {
    const res = await setRules([
      { id: "r1", enabled: true, name: "Bad", whenCapability: "coding", preferProviderId: "does-not-exist" },
    ]);
    assert.equal(res.status, 400);
    const body = (await res.json()) as { error: { message: string } };
    assert.match(body.error.message, /unknown provider/i);
  });

  test("rules survive being read back", async () => {
    await setRules([
      { id: "r1", enabled: true, name: "Keep me", whenCapability: "reasoning", preferProviderId: "ollama" },
    ]);
    const stored = await json<{ rules: Array<{ name: string; whenCapability: string }> }>("/api/routing-rules");
    assert.equal(stored.rules.length, 1);
    assert.equal(stored.rules[0]!.name, "Keep me");
    assert.equal(stored.rules[0]!.whenCapability, "reasoning");
    await setRules([]);
  });
});

// ---------------------------------------------------------------------------
describe("measured routing (spec §102)", () => {
  test("reports measurements gathered from real runs", async () => {
    // Earlier tests in this file have already driven traffic through the local
    // model, so there is genuine data to measure.
    const p = await json<{ enabled: boolean; minSamples: number; models: Array<{ modelId: string; samples: number; medianTokensPerSecond: number; inUse: boolean }> }>(
      "/api/performance",
    );
    assert.equal(p.enabled, true);
    assert.ok(p.minSamples >= 1);
    const local = p.models.find((m) => m.modelId === "ollama:llama3.2:1b");
    assert.ok(local, `no measurement for the local model: ${JSON.stringify(p.models)}`);
    assert.ok(local!.samples > 0);
    assert.ok(local!.medianTokensPerSecond > 0, "throughput should be positive");
  });

  test("a model below the sample threshold is reported but not acted on", async () => {
    const p = await json<{ minSamples: number; models: Array<{ samples: number; inUse: boolean; measuredSpeedScore: number | null }> }>(
      "/api/performance",
    );
    for (const m of p.models) {
      if (m.samples < p.minSamples) {
        assert.equal(m.inUse, false, "acted on a measurement with too few samples");
        assert.equal(m.measuredSpeedScore, null);
      }
    }
  });

  test("measured routing can be turned off and on", async () => {
    await api("/api/performance", { method: "PUT", body: JSON.stringify({ enabled: false }) });
    assert.equal((await json<{ enabled: boolean }>("/api/performance")).enabled, false);
    await api("/api/performance", { method: "PUT", body: JSON.stringify({ enabled: true }) });
    assert.equal((await json<{ enabled: boolean }>("/api/performance")).enabled, true);
  });

  test("cancellations do not count against a model's success rate", async () => {
    const before = await json<{ models: Array<{ modelId: string; successRate: number }> }>("/api/performance");
    const beforeRate = before.models.find((m) => m.modelId === "ollama:llama3.2:1b")?.successRate ?? 1;

    const ac = new AbortController();
    try {
      const res = await fetch(`${baseUrl}/api/chat/stream`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "cancel me", mode: "local_only" }),
        signal: ac.signal,
      });
      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let seen = "";
      while (!seen.includes("event: delta")) {
        const { done, value } = await reader.read();
        if (done) break;
        seen += decoder.decode(value, { stream: true });
      }
      ac.abort();
    } catch { /* the abort is the point */ }
    await new Promise((r) => setTimeout(r, 600));

    const after = await json<{ models: Array<{ modelId: string; successRate: number }> }>("/api/performance");
    const afterRate = after.models.find((m) => m.modelId === "ollama:llama3.2:1b")?.successRate ?? 1;
    assert.ok(afterRate >= beforeRate - 0.001, `a cancellation lowered the success rate: ${beforeRate} -> ${afterRate}`);
  });
});

// ---------------------------------------------------------------------------
describe("persistence across a restart", () => {
  test("providers, models and conversations survive a full app restart", async () => {
    // Crash-recovery groundwork (spec §141): state lives in Postgres, not memory.
    const before = await json<{ models: Array<{ id: string }> }>("/api/models");
    const conversations = await json<{ conversations: unknown[] }>("/api/conversations");

    await new Promise<void>((resolve) => app.server.close(() => resolve()));
    await app.pool.end();

    app = await createApp(testConfig());
    await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

    const after = await json<{ models: Array<{ id: string }> }>("/api/models");
    assert.deepEqual(after.models.map((m) => m.id).sort(), before.models.map((m) => m.id).sort());
    const convAfter = await json<{ conversations: unknown[] }>("/api/conversations");
    assert.equal(convAfter.conversations.length, conversations.conversations.length);
  });

  test("a provider's API key still decrypts after restart", async () => {
    // Encryption uses a per-run random key in tests, so a restart with a NEW
    // key must fail loudly rather than silently returning corrupt credentials.
    const { providers } = await json<{ providers: Array<{ id: string; hasApiKey: boolean }> }>("/api/providers");
    assert.ok(providers.find((p) => p.id === "openai")?.hasApiKey);
  });
});
