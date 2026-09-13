/**
 * The browser demo's core, exercised the way the page exercises it.
 *
 * This exists because of a bug that reached the published artifact: the chat
 * form omits `systemPrompt` entirely, and code added on the assumption that
 * every request carries it threw on `undefined.trim()`. The demo answered
 * nothing at all, and because the throw escaped the fetch interceptor there
 * was no error on screen either.
 *
 * So the rule these tests enforce is narrow and specific: **the request bodies
 * here must stay identical to the ones Chat.tsx builds**, field for field. A
 * test that sends a tidier body than the app does would have passed while the
 * app was broken.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { installBrowserNyro } from "../src/demo/in-browser-nyro.ts";

let realFetch: typeof globalThis.fetch;

before(() => {
  realFetch = globalThis.fetch;
  // The interceptor resolves relative URLs against location; Node has none.
  (globalThis as { location?: { href: string } }).location = { href: "http://demo.test/" };
  installBrowserNyro();
});

after(() => {
  globalThis.fetch = realFetch;
});

interface Frame { type: string; data: Record<string, unknown> }

async function stream(body: Record<string, unknown>): Promise<Frame[]> {
  const res = await fetch("/api/chat/stream", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  // Read once: an assert message that awaits res.text() consumes the body,
  // and the next read throws "body already read".
  const text = await res.text();
  assert.equal(res.status, 200, `stream returned ${res.status}: ${text}`);
  const frames: Frame[] = [];
  for (const chunk of text.split("\n\n")) {
    const type = /^event: (.+)$/m.exec(chunk)?.[1];
    const data = /^data: (.+)$/m.exec(chunk)?.[1];
    if (type && data) frames.push({ type, data: JSON.parse(data) as Record<string, unknown> });
  }
  return frames;
}

/**
 * EXACTLY the body Chat.tsx's send() builds — note the absence of
 * systemPrompt, temperature, maxCostUsd and requiredCapabilities. If the form
 * changes, change this to match; do not add fields it does not send.
 */
function sendBody(message: string, conversationId: string | null = null): Record<string, unknown> {
  return { message, conversationId, mode: "auto", privacy: "normal", modelId: null };
}

async function messagesOf(id: string): Promise<Array<{ role: string; content: string }>> {
  const res = await fetch(`/api/conversations/${id}/messages`);
  return ((await res.json()) as { messages: Array<{ role: string; content: string }> }).messages;
}

describe("a demo chat completes", () => {
  test("the body the chat form actually sends produces an answer", async () => {
    const frames = await stream(sendBody("demo core smoke"));
    const types = frames.map((f) => f.type);
    assert.ok(types.includes("routing"), `no routing event: ${types.join(",")}`);
    assert.ok(types.includes("delta"), `no delta events: ${types.join(",")}`);
    assert.ok(types.includes("done"), `no done event: ${types.join(",")}`);
    assert.ok(!types.includes("error"), `unexpected error event: ${JSON.stringify(frames.find((f) => f.type === "error"))}`);
  });

  test("done carries a conversation id, which is what unlocks retry and edit", async () => {
    // The UI gates Regenerate and Edit on having one. Without it those
    // controls silently never appear.
    const frames = await stream(sendBody("demo core conversation id"));
    const done = frames.find((f) => f.type === "done");
    assert.ok(typeof done?.data["conversationId"] === "string" && done.data["conversationId"].length > 0);
  });

  test("the turn is stored as one question and one answer", async () => {
    const frames = await stream(sendBody("demo core storage"));
    const id = String(frames.find((f) => f.type === "done")!.data["conversationId"]);
    const messages = await messagesOf(id);
    assert.deepEqual(messages.map((m) => m.role), ["user", "assistant"]);
    assert.equal(messages[0]!.content, "demo core storage");
  });
});

describe("the demo mirrors the server's rewinds", () => {
  test("a regenerate replaces the answer without duplicating the question", async () => {
    const first = await stream(sendBody("demo core regenerate"));
    const id = String(first.find((f) => f.type === "done")!.data["conversationId"]);

    await stream({ ...sendBody("", id), regenerate: true });

    const messages = await messagesOf(id);
    assert.deepEqual(messages.map((m) => m.role), ["user", "assistant"]);
    assert.equal(messages[0]!.content, "demo core regenerate", "the question changed on a regenerate");
  });

  test("an edit rewrites the question in place", async () => {
    const first = await stream(sendBody("demo core typo qeustion"));
    const id = String(first.find((f) => f.type === "done")!.data["conversationId"]);

    await stream({ ...sendBody("demo core fixed question", id), editLast: true });

    const messages = await messagesOf(id);
    assert.deepEqual(messages.map((m) => m.role), ["user", "assistant"]);
    assert.equal(messages[0]!.content, "demo core fixed question");
  });
});

describe("custom instructions in the demo", () => {
  test("save, apply and clear, without breaking a plain request", async () => {
    await fetch("/api/instructions", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ enabled: true, text: "Answer in five words." }),
    });
    const saved = (await (await fetch("/api/instructions")).json()) as { enabled: boolean; text: string };
    assert.deepEqual(saved, { enabled: true, text: "Answer in five words." });

    // The regression: a request with instructions set and no systemPrompt field.
    const frames = await stream(sendBody("demo core with instructions"));
    assert.ok(frames.some((f) => f.type === "done"), "a request with instructions set produced no answer");

    await fetch("/api/instructions", { method: "DELETE" });
    assert.deepEqual(await (await fetch("/api/instructions")).json(), { enabled: false, text: "" });
  });
});

describe("the routing preview", () => {
  async function preview(body: Record<string, unknown>): Promise<{
    estimatedInputTokens: number;
    decision: { chosen: { modelId: string; local: boolean } | null; rejected: Array<{ modelId: string }> };
    budget: { message: string | null };
  }> {
    const res = await fetch("/api/route/preview", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    assert.equal(res.status, 200);
    return (await res.json()) as never;
  }

  /** EXACTLY the body Chat.tsx's preview effect builds. */
  function previewBody(message: string, conversationId: string | null = null): Record<string, unknown> {
    return { message, conversationId, mode: "auto", privacy: "normal", modelId: null };
  }

  test("returns a decision, a size and a budget field the strip reads", async () => {
    const p = await preview(previewBody("preview smoke"));
    assert.ok(p.decision.chosen, "no model chosen");
    assert.ok(p.estimatedInputTokens > 0);
    // The composer strip reads budget.message; an absent budget object would
    // throw in the browser rather than render nothing.
    assert.equal(p.budget.message, null);
  });

  test("local_only excludes the cloud models and says why", async () => {
    const p = await preview({ ...previewBody("private draft"), privacy: "local_only" });
    assert.equal(p.decision.chosen?.local, true);
    assert.ok(p.decision.rejected.length > 0, "nothing was reported as excluded");
  });

  test("it counts the conversation it is previewing", async () => {
    const bare = await preview(previewBody("same draft"));
    const first = await stream(sendBody(`preview history ${"filler ".repeat(300)}`));
    const id = String(first.find((f) => f.type === "done")!.data["conversationId"]);
    const withHistory = await preview(previewBody("same draft", id));
    assert.ok(
      withHistory.estimatedInputTokens > bare.estimatedInputTokens + 200,
      `preview ignored the conversation (${bare.estimatedInputTokens} -> ${withHistory.estimatedInputTokens})`,
    );
  });

  test("previewing sends nothing", async () => {
    const first = await stream(sendBody("preview sends nothing"));
    const id = String(first.find((f) => f.type === "done")!.data["conversationId"]);
    await preview(previewBody("a draft nobody submitted", id));
    const messages = await messagesOf(id);
    assert.deepEqual(messages.map((m) => m.role), ["user", "assistant"]);
  });
});

describe("a failure inside the demo is visible", () => {
  test("a malformed body becomes an error response, not a rejected fetch", async () => {
    // Before this, a throw in the stream branch escaped the interceptor and
    // the page just stopped, with nothing to show the user.
    const res = await fetch("/api/chat/stream", { method: "POST", body: "not json" });
    assert.equal(res.status, 500);
    const body = (await res.json()) as { error: { code: string } };
    assert.equal(body.error.code, "internal");
  });
});
