/**
 * Markdown parser tests.
 *
 * Two groups matter most: the safety properties (a model can emit anything,
 * and none of it may become markup or a dangerous URL), and the streaming
 * behaviour (output arrives a token at a time, so a half-written document must
 * still render sensibly).
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { parseMarkdown, parseInline, isSafeHref, type Block, type Inline } from "../src/markdown/parse.ts";

function text(children: Inline[]): string {
  return children
    .map((c) =>
      c.type === "text" ? c.value
      : c.type === "code" ? c.value
      : "children" in c ? text(c.children)
      : "",
    )
    .join("");
}

describe("code blocks", () => {
  test("parses a fenced block with a language", () => {
    const [b] = parseMarkdown("```ts\nconst x = 1;\n```") as [Block];
    assert.equal(b.type, "code");
    assert.equal((b as { language: string }).language, "ts");
    assert.equal((b as { value: string }).value, "const x = 1;");
    assert.equal((b as { complete: boolean }).complete, true);
  });

  test("a fence with no language is still a code block", () => {
    const [b] = parseMarkdown("```\nplain\n```") as [Block];
    assert.equal(b.type, "code");
    assert.equal((b as { language: string | null }).language, null);
  });

  test("an UNTERMINATED fence renders as code in progress, not as a swallowed rest", () => {
    // This is the streaming case: the closing fence has not arrived yet.
    const blocks = parseMarkdown("Here you go:\n\n```py\nprint(1)");
    assert.equal(blocks.length, 2);
    assert.equal(blocks[1]!.type, "code");
    assert.equal((blocks[1] as { complete: boolean }).complete, false);
    assert.equal((blocks[1] as { value: string }).value, "print(1)");
  });

  test("markdown inside a code block is NOT interpreted", () => {
    const [b] = parseMarkdown("```\n**not bold** and [not a link](http://x)\n```") as [Block];
    assert.match((b as { value: string }).value, /\*\*not bold\*\*/);
  });

  test("blank lines inside a code block are preserved", () => {
    const [b] = parseMarkdown("```\na\n\nb\n```") as [Block];
    assert.equal((b as { value: string }).value, "a\n\nb");
  });
});

describe("inline", () => {
  test("bold, italic and inline code", () => {
    const parsed = parseInline("a **b** c *d* e `f`");
    assert.ok(parsed.some((n) => n.type === "bold"));
    assert.ok(parsed.some((n) => n.type === "italic"));
    assert.ok(parsed.some((n) => n.type === "code"));
  });

  test("inline code contents are literal", () => {
    const parsed = parseInline("`**not bold**`");
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0]!.type, "code");
    assert.equal((parsed[0] as { value: string }).value, "**not bold**");
  });

  test("snake_case_identifiers are not mangled into italics", () => {
    // A coding assistant emits these constantly; turning them into italics
    // would corrupt the very output NYRO exists to produce.
    const parsed = parseInline("call some_long_function_name now");
    assert.equal(text(parsed), "call some_long_function_name now");
    assert.ok(!parsed.some((n) => n.type === "italic"));
  });

  test("an unmatched marker stays literal rather than eating the message", () => {
    assert.equal(text(parseInline("2 * 3 * 4 = 24")).length > 0, true);
    assert.equal(text(parseInline("a ** b")), "a ** b");
  });
});

describe("link safety", () => {
  test("http, https and mailto are allowed", () => {
    for (const href of ["http://x.test", "https://x.test/a?b=c", "mailto:a@b.test"]) {
      assert.equal(isSafeHref(href), true, href);
    }
  });

  test("every other scheme is refused", () => {
    for (const href of [
      "javascript:alert(1)",
      "JavaScript:alert(1)",
      " javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox",
      "file:///etc/passwd",
      "//evil.test",
    ]) {
      assert.equal(isSafeHref(href), false, `allowed a dangerous href: ${href}`);
    }
  });

  test("a refused link renders as literal text, not as a link and not dropped", () => {
    const parsed = parseInline("[click](javascript:alert(1))");
    assert.ok(!parsed.some((n) => n.type === "link"), "a javascript: URL became a link");
    assert.match(text(parsed), /click/);
  });

  test("a safe link keeps its href and label", () => {
    const parsed = parseInline("see [the docs](https://example.test/x)");
    const link = parsed.find((n) => n.type === "link") as { href: string; children: Inline[] };
    assert.equal(link.href, "https://example.test/x");
    assert.equal(text(link.children), "the docs");
  });
});

describe("raw HTML is never markup", () => {
  test("a script tag survives as text in a paragraph", () => {
    const blocks = parseMarkdown("<script>alert(1)</script>");
    assert.equal(blocks[0]!.type, "paragraph");
    // It stays in the tree as TEXT. The renderer emits text nodes, so it can
    // never become an element.
    assert.match(text((blocks[0] as { children: Inline[] }).children), /<script>alert\(1\)<\/script>/);
  });

  test("an img with onerror is text too", () => {
    const blocks = parseMarkdown('<img src=x onerror="alert(1)">');
    assert.match(text((blocks[0] as { children: Inline[] }).children), /onerror/);
  });
});

describe("block structure", () => {
  test("headings at each level", () => {
    for (let n = 1; n <= 6; n++) {
      const [b] = parseMarkdown(`${"#".repeat(n)} Title`) as [Block];
      assert.equal(b.type, "heading");
      assert.equal((b as { level: number }).level, n);
    }
  });

  test("seven hashes is a paragraph, not a heading", () => {
    assert.equal(parseMarkdown("####### too many")[0]!.type, "paragraph");
  });

  test("unordered and ordered lists", () => {
    const ul = parseMarkdown("- one\n- two\n- three")[0] as { type: string; ordered: boolean; items: unknown[] };
    assert.equal(ul.type, "list");
    assert.equal(ul.ordered, false);
    assert.equal(ul.items.length, 3);

    const ol = parseMarkdown("3. three\n4. four")[0] as { ordered: boolean; start: number; items: unknown[] };
    assert.equal(ol.ordered, true);
    assert.equal(ol.start, 3, "an ordered list must keep the number the author used");
    assert.equal(ol.items.length, 2);
  });

  test("blockquotes nest their contents as blocks", () => {
    const q = parseMarkdown("> quoted **text**\n> more")[0] as { type: string; children: Block[] };
    assert.equal(q.type, "quote");
    assert.equal(q.children[0]!.type, "paragraph");
  });

  test("horizontal rules", () => {
    for (const r of ["---", "***", "___", "- - -"]) {
      assert.equal(parseMarkdown(r)[0]!.type, "rule", r);
    }
  });

  test("a paragraph ends where the next block starts", () => {
    const blocks = parseMarkdown("some text\n- a list item");
    assert.equal(blocks.length, 2);
    assert.equal(blocks[0]!.type, "paragraph");
    assert.equal(blocks[1]!.type, "list");
  });

  test("empty input produces no blocks", () => {
    assert.deepEqual(parseMarkdown(""), []);
    assert.deepEqual(parseMarkdown("   \n\n  "), []);
  });
});

describe("streaming: every prefix of a document parses without throwing", () => {
  const doc = [
    "# Answer",
    "",
    "Use `map` like this:",
    "",
    "```ts",
    "const xs = [1, 2].map((n) => n * 2);",
    "```",
    "",
    "- **fast**",
    "- [docs](https://example.test)",
    "",
    "> note",
  ].join("\n");

  test("no prefix throws, and the full document parses", () => {
    for (let n = 0; n <= doc.length; n++) {
      assert.doesNotThrow(() => parseMarkdown(doc.slice(0, n)), `threw at prefix length ${n}`);
    }
    const blocks = parseMarkdown(doc);
    assert.deepEqual(
      blocks.map((b) => b.type),
      ["heading", "paragraph", "code", "list", "quote"],
    );
  });
});
