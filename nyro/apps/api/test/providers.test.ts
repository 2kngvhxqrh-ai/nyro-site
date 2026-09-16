/**
 * Provider adapter tests against real HTTP servers speaking each wire protocol.
 *
 * SCOPE: proves our request shaping, stream framing, usage extraction, error
 * mapping and cancellation. Does NOT prove any vendor's live API behaviour.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { OllamaProvider } from "../src/providers/ollama.ts";
import { OpenAICompatibleProvider } from "../src/providers/openai-compatible.ts";
import { AnthropicProvider } from "../src/providers/anthropic.ts";
import { MockProvider } from "../src/providers/mock.ts";
import { createProvider, SUPPORTED_TRANSPORTS } from "../src/providers/index.ts";
import { NyroError } from "../src/core/errors.ts";
import type { ProviderConfig } from "../src/providers/provider.ts";
import type { ProviderChatChunk } from "../src/core/types.ts";
import { collect, fakeUpstream, writeSse } from "./helpers.ts";

function cfg(over: Partial<ProviderConfig>): ProviderConfig {
  return {
    id: "test",
    displayName: "Test",
    transport: "ollama",
    baseUrl: "http://127.0.0.1:1",
    apiKey: null,
    local: false,
    requestTimeoutMs: 5_000,
    extra: {},
    ...over,
  };
}

const MSG = [{ role: "user" as const, content: "hello" }];

function textOf(chunks: ProviderChatChunk[]): string {
  return chunks.filter((c) => c.type === "delta").map((c) => (c as { text: string }).text).join("");
}

// ---------------------------------------------------------------------------
describe("OllamaProvider (native NDJSON API)", () => {
  test("lists models from /api/tags", async () => {
    const up = await fakeUpstream((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ models: [{ name: "llama3.2:1b" }, { name: "qwen2.5-coder:7b" }] }));
    });
    try {
      const p = new OllamaProvider(cfg({ baseUrl: up.url, local: true }));
      const models = await p.listModels();
      assert.deepEqual(models.map((m) => m.modelIdentifier), ["llama3.2:1b", "qwen2.5-coder:7b"]);
      assert.equal(up.received[0]!.path, "/api/tags");
    } finally {
      await up.close();
    }
  });

  test("streams NDJSON deltas and extracts usage from the final frame", async () => {
    const up = await fakeUpstream(async (_req, res) => {
      res.writeHead(200, { "content-type": "application/x-ndjson" });
      // Split across writes so chunk-boundary handling is genuinely exercised.
      res.write(JSON.stringify({ message: { content: "Hel" }, done: false }) + "\n");
      await new Promise((r) => setTimeout(r, 2));
      res.write(JSON.stringify({ message: { content: "lo " }, done: false }) + "\n");
      res.write(JSON.stringify({ message: { content: "world" }, done: false }) + "\n");
      res.write(JSON.stringify({ message: { content: "" }, done: true, done_reason: "stop", prompt_eval_count: 11, eval_count: 3 }) + "\n");
      res.end();
    });
    try {
      const p = new OllamaProvider(cfg({ baseUrl: up.url, local: true }));
      const chunks = await collect(p.stream({ modelIdentifier: "llama3.2:1b", messages: MSG }));
      assert.equal(textOf(chunks), "Hello world");
      const usage = chunks.find((c) => c.type === "usage") as { usage: { inputTokens: number; outputTokens: number } };
      assert.deepEqual(usage.usage, { inputTokens: 11, outputTokens: 3 });
      assert.equal((chunks.at(-1) as { finishReason: string }).finishReason, "stop");
    } finally {
      await up.close();
    }
  });

  test("a JSON line split across two TCP writes is reassembled", async () => {
    const up = await fakeUpstream(async (_req, res) => {
      res.writeHead(200, {});
      const frame = JSON.stringify({ message: { content: "split-ok" }, done: false }) + "\n";
      res.write(frame.slice(0, 12));
      await new Promise((r) => setTimeout(r, 5));
      res.write(frame.slice(12));
      res.write(JSON.stringify({ done: true, done_reason: "stop" }) + "\n");
      res.end();
    });
    try {
      const p = new OllamaProvider(cfg({ baseUrl: up.url, local: true }));
      const chunks = await collect(p.stream({ modelIdentifier: "m", messages: MSG }));
      assert.equal(textOf(chunks), "split-ok");
    } finally {
      await up.close();
    }
  });

  test("non-streaming chat returns content and usage", async () => {
    const up = await fakeUpstream((_req, res) => {
      res.writeHead(200, {});
      res.end(JSON.stringify({ message: { content: "42" }, done: true, prompt_eval_count: 5, eval_count: 1 }));
    });
    try {
      const p = new OllamaProvider(cfg({ baseUrl: up.url, local: true }));
      const r = await p.chat({ modelIdentifier: "m", messages: MSG });
      assert.equal(r.content, "42");
      assert.equal(r.usage.inputTokens, 5);
      assert.equal(up.received[0]!.body && (up.received[0]!.body as { stream: boolean }).stream, false);
    } finally {
      await up.close();
    }
  });

  test("healthCheck reports unreachable when nothing is listening", async () => {
    const p = new OllamaProvider(cfg({ baseUrl: "http://127.0.0.1:1", local: true, requestTimeoutMs: 1500 }));
    const h = await p.healthCheck();
    assert.equal(h.state, "unreachable");
    // The detail must not leak anything beyond the origin.
    assert.ok(h.detail.includes("127.0.0.1:1"));
  });

  test("healthCheck reports degraded when reachable with zero models", async () => {
    const up = await fakeUpstream((_req, res) => {
      res.writeHead(200, {});
      res.end(JSON.stringify({ models: [] }));
    });
    try {
      const p = new OllamaProvider(cfg({ baseUrl: up.url, local: true }));
      const h = await p.healthCheck();
      assert.equal(h.state, "degraded");
    } finally {
      await up.close();
    }
  });
});

// ---------------------------------------------------------------------------
describe("OpenAICompatibleProvider (SSE)", () => {
  test("streams SSE deltas, reads usage, and sends a Bearer token", async () => {
    const up = await fakeUpstream(async (_req, res) => {
      await writeSse(res, [
        `data: ${JSON.stringify({ choices: [{ delta: { content: "Hel" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: { content: "lo" } }] })}\n\n`,
        `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 7, completion_tokens: 2 } })}\n\n`,
        "data: [DONE]\n\n",
      ]);
    });
    try {
      const p = new OpenAICompatibleProvider(cfg({ baseUrl: up.url, transport: "openai_compatible", apiKey: "sk-test-key-abcdef123456" }));
      const chunks = await collect(p.stream({ modelIdentifier: "gpt-4o-mini", messages: MSG }));
      assert.equal(textOf(chunks), "Hello");
      const usage = chunks.find((c) => c.type === "usage") as { usage: { inputTokens: number } };
      assert.equal(usage.usage.inputTokens, 7);
      assert.equal(up.received[0]!.headers["authorization"], "Bearer sk-test-key-abcdef123456");
    } finally {
      await up.close();
    }
  });

  test("ignores SSE comment and event: lines", async () => {
    const up = await fakeUpstream(async (_req, res) => {
      await writeSse(res, [
        ": keep-alive\n\n",
        "event: ping\n\n",
        `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`,
        "data: [DONE]\n\n",
      ]);
    });
    try {
      const p = new OpenAICompatibleProvider(cfg({ baseUrl: up.url, transport: "openai_compatible" }));
      const chunks = await collect(p.stream({ modelIdentifier: "m", messages: MSG }));
      assert.equal(textOf(chunks), "ok");
    } finally {
      await up.close();
    }
  });

  test("maps HTTP 401 to provider_auth", async () => {
    const up = await fakeUpstream((_req, res) => {
      res.writeHead(401, {});
      res.end(JSON.stringify({ error: "bad key" }));
    });
    try {
      const p = new OpenAICompatibleProvider(cfg({ baseUrl: up.url, transport: "openai_compatible", apiKey: "nope" }));
      await assert.rejects(
        () => p.chat({ modelIdentifier: "m", messages: MSG }),
        (e: unknown) => e instanceof NyroError && e.code === "provider_auth",
      );
    } finally {
      await up.close();
    }
  });

  test("maps HTTP 429 to provider_rate_limited and marks it retryable", async () => {
    const up = await fakeUpstream((_req, res) => { res.writeHead(429, {}); res.end("slow down"); });
    try {
      const p = new OpenAICompatibleProvider(cfg({ baseUrl: up.url, transport: "openai_compatible" }));
      await assert.rejects(
        () => p.chat({ modelIdentifier: "m", messages: MSG }),
        (e: unknown) => e instanceof NyroError && e.code === "provider_rate_limited" && e.retryable,
      );
    } finally {
      await up.close();
    }
  });

  test("lists models from /models", async () => {
    const up = await fakeUpstream((_req, res) => {
      res.writeHead(200, {});
      res.end(JSON.stringify({ data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini", context_length: 128000 }] }));
    });
    try {
      const p = new OpenAICompatibleProvider(cfg({ baseUrl: up.url, transport: "openai_compatible" }));
      const models = await p.listModels();
      assert.equal(models.length, 2);
      assert.equal(models[1]!.contextWindow, 128000);
    } finally {
      await up.close();
    }
  });

  test("cancellation stops the stream promptly", async () => {
    const up = await fakeUpstream(async (_req, res) => {
      res.writeHead(200, { "content-type": "text/event-stream" });
      // Never finishes on its own — only cancellation ends this.
      for (let i = 0; i < 200; i++) {
        res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "x" } }] })}\n\n`);
        await new Promise((r) => setTimeout(r, 10));
        if (res.writableEnded || res.destroyed) return;
      }
      res.end();
    });
    try {
      const p = new OpenAICompatibleProvider(cfg({ baseUrl: up.url, transport: "openai_compatible", requestTimeoutMs: 30_000 }));
      const ac = new AbortController();
      let count = 0;
      const seen: ProviderChatChunk[] = [];
      for await (const chunk of p.stream({ modelIdentifier: "m", messages: MSG }, ac.signal)) {
        seen.push(chunk);
        if (chunk.type === "delta") {
          count++;
          if (count === 3) ac.abort();
        }
      }
      assert.ok(count < 50, `stream should have stopped early, got ${count} deltas`);
      // Cancellation must be a clean terminal state, not a thrown error.
      assert.equal((seen.at(-1) as { type: string; finishReason?: string }).type, "done");
      assert.equal((seen.at(-1) as { finishReason: string }).finishReason, "cancelled");
    } finally {
      await up.close();
    }
  });
});

// ---------------------------------------------------------------------------
describe("AnthropicProvider (typed SSE, different wire shape)", () => {
  test("sends the system prompt as a top-level field, not a message", async () => {
    const up = await fakeUpstream((_req, res) => {
      res.writeHead(200, {});
      res.end(JSON.stringify({ content: [{ type: "text", text: "hi" }], usage: { input_tokens: 3, output_tokens: 1 }, stop_reason: "end_turn" }));
    });
    try {
      const p = new AnthropicProvider(cfg({ baseUrl: up.url, transport: "anthropic", apiKey: "sk-ant-abc123456789012345" }));
      await p.chat({
        modelIdentifier: "claude-sonnet",
        messages: [{ role: "system", content: "Be terse." }, { role: "user", content: "hello" }],
      });
      const body = up.received[0]!.body as { system?: string; messages: Array<{ role: string }>; max_tokens: number };
      assert.equal(body.system, "Be terse.");
      assert.ok(!body.messages.some((m) => m.role === "system"), "system must not remain in the messages array");
      assert.ok(typeof body.max_tokens === "number", "Anthropic requires max_tokens");
    } finally {
      await up.close();
    }
  });

  test("uses x-api-key and anthropic-version headers, not Bearer auth", async () => {
    const up = await fakeUpstream((_req, res) => {
      res.writeHead(200, {});
      res.end(JSON.stringify({ content: [{ type: "text", text: "x" }], usage: {}, stop_reason: "end_turn" }));
    });
    try {
      const p = new AnthropicProvider(cfg({ baseUrl: up.url, transport: "anthropic", apiKey: "sk-ant-key-000111222333" }));
      await p.chat({ modelIdentifier: "m", messages: MSG });
      const h = up.received[0]!.headers;
      assert.equal(h["x-api-key"], "sk-ant-key-000111222333");
      assert.equal(h["anthropic-version"], "2023-06-01");
      assert.equal(h["authorization"], undefined);
    } finally {
      await up.close();
    }
  });

  test("assembles typed SSE events and merges usage from two different events", async () => {
    const up = await fakeUpstream(async (_req, res) => {
      await writeSse(res, [
        `data: ${JSON.stringify({ type: "message_start", message: { usage: { input_tokens: 12, output_tokens: 0 } } })}\n\n`,
        `data: ${JSON.stringify({ type: "content_block_delta", delta: { text: "Hel" } })}\n\n`,
        `data: ${JSON.stringify({ type: "content_block_delta", delta: { text: "lo" } })}\n\n`,
        `data: ${JSON.stringify({ type: "message_delta", delta: { stop_reason: "end_turn" }, usage: { output_tokens: 5 } })}\n\n`,
        `data: ${JSON.stringify({ type: "message_stop" })}\n\n`,
      ]);
    });
    try {
      const p = new AnthropicProvider(cfg({ baseUrl: up.url, transport: "anthropic", apiKey: "k" }));
      const chunks = await collect(p.stream({ modelIdentifier: "m", messages: MSG }));
      assert.equal(textOf(chunks), "Hello");
      const usage = chunks.find((c) => c.type === "usage") as { usage: { inputTokens: number; outputTokens: number } };
      // input_tokens came from message_start, output_tokens from message_delta.
      assert.deepEqual(usage.usage, { inputTokens: 12, outputTokens: 5 });
    } finally {
      await up.close();
    }
  });

  test("concatenates multiple text blocks in a non-streaming response", async () => {
    const up = await fakeUpstream((_req, res) => {
      res.writeHead(200, {});
      res.end(JSON.stringify({
        content: [{ type: "text", text: "a" }, { type: "thinking", text: "IGNORED" }, { type: "text", text: "b" }],
        usage: { input_tokens: 1, output_tokens: 2 },
        stop_reason: "max_tokens",
      }));
    });
    try {
      const p = new AnthropicProvider(cfg({ baseUrl: up.url, transport: "anthropic", apiKey: "k" }));
      const r = await p.chat({ modelIdentifier: "m", messages: MSG });
      assert.equal(r.content, "ab");
      assert.equal(r.finishReason, "length");
    } finally {
      await up.close();
    }
  });
});

// ---------------------------------------------------------------------------
describe("provider factory and the abstraction contract", () => {
  test("every supported transport is constructible through one factory call", () => {
    for (const transport of SUPPORTED_TRANSPORTS) {
      const p = createProvider(cfg({ transport, baseUrl: "http://127.0.0.1:1" }));
      assert.equal(p.transport, transport);
      assert.equal(typeof p.chat, "function");
      assert.equal(typeof p.stream, "function");
      assert.equal(typeof p.healthCheck, "function");
      assert.equal(typeof p.supports, "function");
    }
  });

  test("an unknown transport is a config error, not a crash", () => {
    assert.throws(
      () => createProvider(cfg({ transport: "nope" as never })),
      (e: unknown) => e instanceof NyroError && e.code === "config_error",
    );
  });

  test("cost estimation is consistent across adapters", () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 };
    for (const transport of SUPPORTED_TRANSPORTS) {
      const p = createProvider(cfg({ transport }));
      assert.equal(p.estimateCost(usage, 3, 15).totalCostUsd, 18);
    }
  });

  test("all streaming transports end a cancelled stream the same way", async () => {
    // Cancellation semantics must not depend on which provider is in use —
    // otherwise the executor's "cancelled is final" rule holds only sometimes.
    const cases: Array<{ transport: "ollama" | "openai_compatible" | "anthropic"; frame: string }> = [
      { transport: "ollama", frame: JSON.stringify({ message: { content: "x" }, done: false }) + "\n" },
      { transport: "openai_compatible", frame: `data: ${JSON.stringify({ choices: [{ delta: { content: "x" } }] })}\n\n` },
      { transport: "anthropic", frame: `data: ${JSON.stringify({ type: "content_block_delta", delta: { text: "x" } })}\n\n` },
    ];

    for (const c of cases) {
      const up = await fakeUpstream(async (_req, res) => {
        res.writeHead(200, {});
        for (let i = 0; i < 200; i++) {
          if (res.writableEnded || res.destroyed) return;
          res.write(c.frame);
          await new Promise((r) => setTimeout(r, 10));
        }
        res.end();
      });
      try {
        const p = createProvider(cfg({ transport: c.transport, baseUrl: up.url, apiKey: "k", requestTimeoutMs: 30_000 }));
        const ac = new AbortController();
        let deltas = 0;
        let last: ProviderChatChunk | undefined;
        for await (const chunk of p.stream({ modelIdentifier: "m", messages: MSG }, ac.signal)) {
          last = chunk;
          if (chunk.type === "delta" && ++deltas === 2) ac.abort();
        }
        assert.equal(last?.type, "done", `${c.transport}: expected a done chunk`);
        assert.equal((last as { finishReason: string }).finishReason, "cancelled", `${c.transport}: wrong finish reason`);
      } finally {
        await up.close();
      }
    }
  });

  test("the mock provider is labelled a mock in its output and health detail", async () => {
    const p = new MockProvider(cfg({ transport: "mock" }));
    const r = await p.chat({ modelIdentifier: "nyro-mock-echo", messages: MSG });
    assert.ok(r.content.includes("mock"), "mock output must announce itself");
    const h = await p.healthCheck();
    assert.ok(h.detail.includes("not a real model"));
  });
});
