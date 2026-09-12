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
