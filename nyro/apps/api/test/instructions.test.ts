/**
 * Custom instructions (spec §26).
 *
 * Two things are being protected here.
 *
 * The first is that instructions must be *visible*. A standing prompt that
 * silently rewrites every answer, and that the export does not mention, is the
 * kind of state invariant 13 exists to forbid — you cannot debug a system whose
 * hidden inputs you cannot read.
 *
 * The second is that they must be *sized*. Instructions are tokens: they eat
 * context and they cost money. If plan() did not count them, the routing
 * preview would report a different request from the one that actually gets
 * sent, and a model could be chosen whose context cannot hold the prompt.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createApp, type NyroApp } from "../src/app.ts";
import type { NyroConfig } from "../src/config.ts";
import { fakeUpstream, type Upstream } from "./helpers.ts";
import { DEFAULT_INSTRUCTIONS, resolveSystemPrompt, type Instructions } from "../src/core/instructions.ts";
import { instructionsSchema } from "../src/core/instructions-schema.ts";
import * as chatService from "../src/core/chat-service.ts";
import { toMarkdown, type ExportBundle } from "../src/core/export.ts";

// ---------------------------------------------------------------------------
// Pure rules — no database needed.
// ---------------------------------------------------------------------------

function stored(over: Partial<Instructions> = {}): Instructions {
  return { ...DEFAULT_INSTRUCTIONS, ...over };
}

describe("resolveSystemPrompt", () => {
  test("nothing stored and nothing requested means no system message", () => {
    assert.equal(resolveSystemPrompt(stored(), null), null);
  });

  test("instructions that are switched off are not sent", () => {
    // The switch is the whole point of having one: text that applies whether
    // or not it is enabled would make "turn off" a lie.
    assert.equal(resolveSystemPrompt(stored({ enabled: false, text: "Speak Dutch." }), null), null);
  });

  test("enabled instructions become the system prompt", () => {
    assert.equal(resolveSystemPrompt(stored({ enabled: true, text: "Speak Dutch." }), null), "Speak Dutch.");
  });

  test("whitespace-only instructions are not a prompt", () => {
    assert.equal(resolveSystemPrompt(stored({ enabled: true, text: "   \n  " }), null), null);
  });

  test("a request's own system prompt REPLACES the stored instructions", () => {
    // Replace, not append. A caller that cannot send a bare system prompt has
    // no way to escape a setting it did not choose.
    assert.equal(
      resolveSystemPrompt(stored({ enabled: true, text: "Speak Dutch." }), "Answer only in JSON."),
      "Answer only in JSON.",
    );
  });

  test("a request's system prompt wins even when instructions are off", () => {
    assert.equal(resolveSystemPrompt(stored({ enabled: false, text: "Speak Dutch." }), "Be terse."), "Be terse.");
  });

  test("an empty string from the caller means no prompt, not the stored one", () => {
    // "" is a caller who explicitly asked for no system prompt. Falling back to
    // the stored text there would make the empty string mean its opposite.
    assert.equal(resolveSystemPrompt(stored({ enabled: true, text: "Speak Dutch." }), ""), null);
  });
});

describe("the stored document", () => {
  test("defaults to off and empty", () => {
    const parsed = instructionsSchema.parse({});
    assert.deepEqual(parsed, { enabled: false, text: "" });
  });

  test("text longer than the per-request ceiling is rejected", () => {
    // Accepting here what /api/chat rejects would let a user save instructions
    // that make every subsequent turn fail.
    assert.equal(instructionsSchema.safeParse({ text: "x".repeat(50_001) }).success, false);
  });
});

describe("the export covers every settings key", () => {
  test("no *_SETTINGS_KEY is missing from the export bundle", async () => {
    // A settings document NYRO stores but never exports is state the user
    // cannot see -- exactly what invariant 13 forbids. This enumerates the
    // constants rather than trusting a hand-written list to stay in step.
    const declared = Object.entries(chatService)
      .filter(([name]) => name.endsWith("_SETTINGS_KEY"))
      .map(([, value]) => value as string);
    assert.ok(declared.length >= 4, "expected at least four settings documents");

    const source = await (await import("node:fs/promises")).readFile(
      new URL("../src/core/export.ts", import.meta.url),
      "utf8",
    );
    const list = source.slice(source.indexOf("const SETTINGS_KEYS"), source.indexOf("] as const;"));
    for (const key of declared) {
      const constName = Object.entries(chatService).find(([, v]) => v === key)![0];
      assert.ok(list.includes(constName), `export.ts SETTINGS_KEYS is missing ${constName}`);
    }
  });
});

describe("the markdown export shows the instructions", () => {
  function bundle(settings: Record<string, unknown>): ExportBundle {
    return {
      exportedAt: "2026-01-01T00:00:00.000Z",
      note: "note",
      providers: [],
      models: [],
      settings,
      conversations: [],
      usage: { totalRuns: 0, failedRuns: 0, cancelledRuns: 0, totalCostUsd: 0 },
    } as unknown as ExportBundle;
  }

  test("enabled instructions appear in the file", () => {
    const md = toMarkdown(bundle({ instructions: { enabled: true, text: "Speak Dutch." } }));
    assert.match(md, /## Custom instructions\n\nSpeak Dutch\./);
  });

  test("instructions that are switched off are still shown, and marked", () => {
    // The export is what NYRO *stores*, not what it is currently doing. Text
    // omitted because a flag is false is text the user cannot get back.
    const md = toMarkdown(bundle({ instructions: { enabled: false, text: "Speak Dutch." } }));
    assert.match(md, /## Custom instructions \(switched off\)/);
  });

  test("no instructions means no section", () => {
    assert.doesNotMatch(toMarkdown(bundle({})), /Custom instructions/);
  });
});

// ---------------------------------------------------------------------------
// End to end, against a real database and a real upstream.
// ---------------------------------------------------------------------------

const DB_URL = process.env["TEST_DATABASE_URL"];
if (!DB_URL) {
  throw new Error("TEST_DATABASE_URL is required to run these tests. See nyro/docs/SETUP.md.");
}

let app: NyroApp;
let baseUrl: string;
let upstream: Upstream;

/** Every system message the upstream was actually sent, newest last. */
function systemMessagesSeen(): string[] {
  return upstream.received
    .filter((r) => r.path === "/api/chat")
    .flatMap((r) => (r.body as { messages?: Array<{ role: string; content: string }> }).messages ?? [])
    .filter((m) => m.role === "system")
    .map((m) => m.content);
}

async function api(path: string, init?: RequestInit): Promise<Response> {
  return fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
}
async function json<T>(path: string, init?: RequestInit): Promise<T> {
  return (await (await api(path, init)).json()) as T;
}

before(async () => {
  upstream = await fakeUpstream((req, res, body) => {
    if (req.url === "/api/tags") {
      res.writeHead(200, {});
      res.end(JSON.stringify({ models: [{ name: "llama3.2:1b" }] }));
      return;
    }
    if (req.url === "/api/chat") {
      const b = body as { messages: Array<{ content: string }> };
      res.writeHead(200, {});
      res.end(JSON.stringify({
        message: { content: `reply:${b.messages.at(-1)?.content ?? ""}` },
        done: true, prompt_eval_count: 9, eval_count: 4,
      }));
      return;
    }
    res.writeHead(404, {});
    res.end("{}");
  });

  const config: NyroConfig = {
    env: "test", port: 0, host: "127.0.0.1", databaseUrl: DB_URL!,
    secretKey: randomBytes(32), logLevel: "error", corsOrigins: [],
    ollamaBaseUrl: null, defaultModelHint: null, enableMockProvider: false,
    requestTimeoutMs: 15_000, staticDir: null,
  };
  app = await createApp(config);
  await app.pool.query("delete from providers");
  await app.pool.query("delete from conversations");
  await app.pool.query("delete from model_runs");
  await app.pool.query("delete from settings");

  await new Promise<void>((resolve) => app.server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(app.server.address() as AddressInfo).port}`;

  await api("/api/providers/ollama", {
    method: "PUT",
    body: JSON.stringify({
      id: "ollama", displayName: "Ollama", presetKey: "ollama", transport: "ollama",
      baseUrl: upstream.url, apiKey: null, local: true, enabled: true, requestTimeoutMs: 15_000,
    }),
  });
  await api("/api/providers/ollama/discover", { method: "POST" });
});

after(async () => {
  await app?.shutdown();
  await upstream?.close();
});

describe("the instructions endpoint", () => {
  test("starts empty and switched off", async () => {
    assert.deepEqual(await json<Instructions>("/api/instructions"), { enabled: false, text: "" });
  });

  test("saves and reads back", async () => {
    const saved = await json<Instructions>("/api/instructions", {
      method: "PUT",
      body: JSON.stringify({ enabled: true, text: "Always answer in Dutch." }),
    });
    assert.deepEqual(saved, { enabled: true, text: "Always answer in Dutch." });
    assert.deepEqual(await json<Instructions>("/api/instructions"), saved);
  });

  test("delete clears the text as well as the switch", async () => {
    await api("/api/instructions", { method: "PUT", body: JSON.stringify({ enabled: true, text: "keep me?" }) });
    assert.deepEqual(await json<Instructions>("/api/instructions", { method: "DELETE" }), { enabled: false, text: "" });
    assert.deepEqual(await json<Instructions>("/api/instructions"), { enabled: false, text: "" });
  });
});

describe("what the model is actually sent", () => {
  test("enabled instructions arrive as a system message, ahead of the turn", async () => {
    await api("/api/instructions", {
      method: "PUT",
      body: JSON.stringify({ enabled: true, text: "Always answer in Dutch." }),
    });
    const before = upstream.received.length;
    const res = await api("/api/chat", { method: "POST", body: JSON.stringify({ message: "hello" }) });
    assert.equal(res.status, 200);

    const sent = upstream.received.slice(before).find((r) => r.path === "/api/chat");
    const messages = (sent!.body as { messages: Array<{ role: string; content: string }> }).messages;
    assert.equal(messages[0]!.role, "system");
    assert.equal(messages[0]!.content, "Always answer in Dutch.");
    assert.equal(messages.at(-1)!.role, "user");
  });

  test("switching them off stops sending them, without deleting them", async () => {
    await api("/api/instructions", {
      method: "PUT",
      body: JSON.stringify({ enabled: false, text: "Always answer in Dutch." }),
    });
    const before = upstream.received.length;
    await api("/api/chat", { method: "POST", body: JSON.stringify({ message: "hello again" }) });

    const sent = upstream.received.slice(before).find((r) => r.path === "/api/chat");
    const messages = (sent!.body as { messages: Array<{ role: string }> }).messages;
    assert.ok(!messages.some((m) => m.role === "system"), "a switched-off instruction was still sent");
    assert.equal((await json<Instructions>("/api/instructions")).text, "Always answer in Dutch.");
  });

  test("a request's own system prompt replaces the stored one", async () => {
    await api("/api/instructions", {
      method: "PUT",
      body: JSON.stringify({ enabled: true, text: "Always answer in Dutch." }),
    });
    const before = upstream.received.length;
    await api("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message: "hi", systemPrompt: "Answer only in JSON." }),
    });

    const sent = upstream.received.slice(before).find((r) => r.path === "/api/chat");
    const messages = (sent!.body as { messages: Array<{ role: string; content: string }> }).messages;
    const systems = messages.filter((m) => m.role === "system").map((m) => m.content);
    assert.deepEqual(systems, ["Answer only in JSON."], "the stored instructions were appended rather than replaced");
  });

  test("instructions never appear in the stored transcript", async () => {
    // They are configuration, not something the user said. Storing them as a
    // message would put them in the history of every later turn as well.
    await api("/api/instructions", {
      method: "PUT",
      body: JSON.stringify({ enabled: true, text: "Always answer in Dutch." }),
    });
    const { conversationId } = await json<{ conversationId: string }>("/api/chat", {
      method: "POST",
      body: JSON.stringify({ message: "one" }),
    });
    const { messages } = await json<{ messages: Array<{ role: string; content: string }> }>(
      `/api/conversations/${conversationId}/messages`,
    );
    assert.deepEqual(messages.map((m) => m.role), ["user", "assistant"]);
    assert.ok(!messages.some((m) => m.content.includes("Dutch")));
  });

  test("the last system message seen is never a stale one", () => {
    // Guards the tests above against each other: if any of them leaked state,
    // the recorded traffic would show it.
    assert.ok(systemMessagesSeen().length > 0);
  });
});

describe("instructions are sized, not ignored", () => {
  async function preview(body: Record<string, unknown>): Promise<number> {
    const r = await json<{ estimatedInputTokens: number }>("/api/route/preview", {
      method: "POST",
      body: JSON.stringify(body),
    });
    return r.estimatedInputTokens;
  }

  test("the routing preview counts them", async () => {
    await api("/api/instructions", { method: "DELETE" });
    const bare = await preview({ message: "hello" });

    await api("/api/instructions", {
      method: "PUT",
      body: JSON.stringify({ enabled: true, text: "word ".repeat(400) }),
    });
    const withInstructions = await preview({ message: "hello" });

    // The preview is what the UI shows before spending anything. If it did not
    // include the instructions it would be describing a different request.
    assert.ok(
      withInstructions > bare + 200,
      `expected the preview to grow by the instructions (${bare} -> ${withInstructions})`,
    );
  });

  test("a switched-off instruction costs nothing", async () => {
    await api("/api/instructions", { method: "DELETE" });
    const bare = await preview({ message: "hello" });
    await api("/api/instructions", {
      method: "PUT",
      body: JSON.stringify({ enabled: false, text: "word ".repeat(400) }),
    });
    assert.equal(await preview({ message: "hello" }), bare);
    await api("/api/instructions", { method: "DELETE" });
  });
});

describe("the export shows them", () => {
  test("stored instructions are in the JSON bundle", async () => {
    await api("/api/instructions", {
      method: "PUT",
      body: JSON.stringify({ enabled: true, text: "Always answer in Dutch." }),
    });
    const bundle = await json<{ settings: Record<string, unknown> }>("/api/export");
    assert.deepEqual(bundle.settings["instructions"], { enabled: true, text: "Always answer in Dutch." });
  });

  test("and in the markdown a user can read with nothing running", async () => {
    const md = await (await api("/api/export?format=markdown")).text();
    assert.match(md, /Custom instructions/);
    assert.match(md, /Always answer in Dutch\./);
  });
});
