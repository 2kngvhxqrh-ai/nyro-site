/**
 * Export tests (spec §108, §109).
 *
 * One of these matters far more than the rest: an export is a file that ends
 * up in cloud storage, an email, or a git repo. If a decrypted API key ever
 * reaches it, every protection in util/crypto.ts is undone by a single click.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { toMarkdown, EXPORT_FORMAT_VERSION, type ExportBundle } from "../src/core/export.ts";

function bundle(over: Partial<ExportBundle> = {}): ExportBundle {
  return {
    nyroExportVersion: EXPORT_FORMAT_VERSION,
    exportedAt: "2026-01-01T00:00:00.000Z",
    note: "This export contains no API keys.",
    providers: [],
    models: [],
    settings: {},
    conversations: [],
    usage: { totalRuns: 0, failedRuns: 0, cancelledRuns: 0, totalCostUsd: 0 },
    ...over,
  };
}

describe("markdown rendering", () => {
  test("renders a conversation as readable prose", () => {
    const md = toMarkdown(bundle({
      conversations: [{
        id: "c1", title: "How routing works", createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z",
        messages: [
          { role: "user", content: "Which model did you use?", modelId: null, createdAt: "2026-01-01T00:00:00.000Z", finishReason: null },
          { role: "assistant", content: "The local one.", modelId: "ollama:llama3.2:1b", createdAt: "2026-01-01T00:00:01.000Z", finishReason: null },
        ],
      }],
    }));
    assert.match(md, /## How routing works/);
    assert.match(md, /\*\*You\*\*/);
    assert.match(md, /Which model did you use\?/);
    // The model that answered is attributed, so the file is self-describing.
    assert.match(md, /\*\*NYRO \(ollama:llama3\.2:1b\)\*\*/);
    assert.match(md, /The local one\./);
  });

  test("message content is reproduced verbatim, including markdown", () => {
    const content = "Here is code:\n\n```ts\nconst x = 1;\n```\n\nAnd **bold** text.";
    const md = toMarkdown(bundle({
      conversations: [{
        id: "c1", title: "t", createdAt: "x", updatedAt: "y",
        messages: [{ role: "assistant", content, modelId: null, createdAt: "z", finishReason: null }],
      }],
    }));
    assert.ok(md.includes(content), "content was altered on the way out");
  });

  test("an empty export says so rather than producing a confusing blank file", () => {
    assert.match(toMarkdown(bundle()), /No conversations yet/);
  });

  test("the no-keys note is in the file itself", () => {
    assert.match(toMarkdown(bundle()), /no API keys/i);
  });

  test("an assistant message with no model is still attributed", () => {
    const md = toMarkdown(bundle({
      conversations: [{
        id: "c1", title: "t", createdAt: "x", updatedAt: "y",
        messages: [{ role: "assistant", content: "hi", modelId: null, createdAt: "z", finishReason: null }],
      }],
    }));
    assert.match(md, /\*\*NYRO\*\*/);
  });
});

describe("the bundle shape carries a version", () => {
  test("so a future importer can tell what it is reading", () => {
    assert.equal(bundle().nyroExportVersion, EXPORT_FORMAT_VERSION);
    assert.ok(EXPORT_FORMAT_VERSION >= 1);
  });
});
