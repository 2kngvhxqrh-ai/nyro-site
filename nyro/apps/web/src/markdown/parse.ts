/**
 * A small, deliberate Markdown subset for chat output (spec §58).
 *
 * WHY NOT A LIBRARY: every Markdown renderer's safety rests on its HTML
 * sanitiser, and using one means trusting that sanitiser with text a language
 * model produced. This parser emits a token tree that the React renderer turns
 * into elements — there is no HTML string anywhere in the pipeline, so markup
 * in a model's output cannot become markup on the page. That property is
 * structural, not a filter that can be bypassed.
 *
 * WHAT IT SUPPORTS, and nothing else: fenced code blocks, headings, ordered
 * and unordered lists, blockquotes, horizontal rules, paragraphs; inline code,
 * bold, italic, and links. Tables, footnotes, HTML blocks and reference links
 * render as plain text rather than being half-supported.
 *
 * STREAMING: output arrives a token at a time, so the parser must behave
 * sensibly on a half-written document. An unterminated fence renders as a code
 * block in progress rather than swallowing the rest of the message.
 */

export type Inline =
  | { type: "text"; value: string }
  | { type: "code"; value: string }
  | { type: "bold"; children: Inline[] }
  | { type: "italic"; children: Inline[] }
  | { type: "link"; href: string; children: Inline[] };

export type Block =
  | { type: "paragraph"; children: Inline[] }
  | { type: "heading"; level: 1 | 2 | 3 | 4 | 5 | 6; children: Inline[] }
  | { type: "code"; language: string | null; value: string; complete: boolean }
  | { type: "list"; ordered: boolean; start: number; items: Inline[][] }
  | { type: "quote"; children: Block[] }
  | { type: "rule" };

/**
 * Only these schemes become links. A model can emit `javascript:` as easily as
 * anything else, and an anchor is the one element here that carries a URL.
 */
const SAFE_SCHEME = /^(https?:\/\/|mailto:)/i;

export function isSafeHref(href: string): boolean {
  return SAFE_SCHEME.test(href.trim());
}

// ---------------------------------------------------------------------------
// Inline
// ---------------------------------------------------------------------------

function pushText(out: Inline[], value: string): void {
  if (value.length === 0) return;
  const last = out[out.length - 1];
  // Merge adjacent text so the renderer emits fewer nodes.
  if (last && last.type === "text") last.value += value;
  else out.push({ type: "text", value });
}

export function parseInline(input: string): Inline[] {
  const out: Inline[] = [];
  let i = 0;
  let plain = "";

  const flush = (): void => {
    pushText(out, plain);
    plain = "";
  };

  while (i < input.length) {
    const rest = input.slice(i);

    // Inline code first: its contents are literal, so nothing inside is parsed.
    const code = /^`([^`\n]+)`/.exec(rest);
    if (code) {
      flush();
      out.push({ type: "code", value: code[1]! });
      i += code[0].length;
      continue;
    }

    const link = /^\[([^\]\n]*)\]\(([^)\s]+)\)/.exec(rest);
    if (link) {
      flush();
      const href = link[2]!;
      if (isSafeHref(href)) {
        out.push({ type: "link", href, children: parseInline(link[1]!) });
      } else {
        // Not a link we will follow, so show the source rather than silently
        // dropping the user's text.
        pushText(out, link[0]);
      }
      i += link[0].length;
      continue;
    }

    const bold = /^(\*\*|__)(?=\S)([\s\S]*?\S)\1/.exec(rest);
    if (bold) {
      flush();
      out.push({ type: "bold", children: parseInline(bold[2]!) });
      i += bold[0].length;
      continue;
    }

    // Underscore italics require non-word boundaries so snake_case_names survive.
    const italic = /^(\*)(?=\S)([\s\S]*?\S)\1/.exec(rest) ?? /^(_)(?=\S)([^_]*\S)\1(?!\w)/.exec(rest);
    if (italic) {
      flush();
      out.push({ type: "italic", children: parseInline(italic[2]!) });
      i += italic[0].length;
      continue;
    }

    plain += input[i];
    i += 1;
  }

  flush();
  return out;
}

// ---------------------------------------------------------------------------
// Blocks
// ---------------------------------------------------------------------------

const FENCE = /^\s{0,3}(```|~~~)\s*([A-Za-z0-9_+-]*)\s*$/;
const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/;
const RULE = /^\s{0,3}([-*_])\s*(?:\1\s*){2,}$/;
const UL_ITEM = /^\s{0,3}[-*+]\s+(.*)$/;
const OL_ITEM = /^\s{0,3}(\d{1,9})[.)]\s+(.*)$/;
const QUOTE = /^\s{0,3}>\s?(.*)$/;

export function parseMarkdown(input: string): Block[] {
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i]!;

    if (line.trim() === "") { i += 1; continue; }

    const fence = FENCE.exec(line);
    if (fence) {
      const marker = fence[1]!;
      const language = fence[2]! || null;
      const body: string[] = [];
      i += 1;
      let complete = false;
      while (i < lines.length) {
        const l = lines[i]!;
        if (l.trimStart().startsWith(marker)) { complete = true; i += 1; break; }
        body.push(l);
        i += 1;
      }
      blocks.push({ type: "code", language, value: body.join("\n"), complete });
      continue;
    }

    if (RULE.test(line)) { blocks.push({ type: "rule" }); i += 1; continue; }

    const heading = HEADING.exec(line);
    if (heading) {
      blocks.push({
        type: "heading",
        level: heading[1]!.length as 1 | 2 | 3 | 4 | 5 | 6,
        children: parseInline(heading[2]!.replace(/\s+#+\s*$/, "")),
      });
      i += 1;
      continue;
    }

    const quote = QUOTE.exec(line);
    if (quote) {
      const inner: string[] = [];
      while (i < lines.length) {
        const q = QUOTE.exec(lines[i]!);
        if (!q) break;
        inner.push(q[1]!);
        i += 1;
      }
      blocks.push({ type: "quote", children: parseMarkdown(inner.join("\n")) });
      continue;
    }

    if (UL_ITEM.test(line) || OL_ITEM.test(line)) {
      const ordered = OL_ITEM.test(line);
      const start = ordered ? Number.parseInt(OL_ITEM.exec(line)![1]!, 10) : 1;
      const items: Inline[][] = [];
      while (i < lines.length) {
        const l = lines[i]!;
        const m = ordered ? OL_ITEM.exec(l) : UL_ITEM.exec(l);
        if (!m) break;
        items.push(parseInline(ordered ? m[2]! : m[1]!));
        i += 1;
      }
      blocks.push({ type: "list", ordered, start, items });
      continue;
    }

    // Paragraph: consume until a blank line or a line that starts another block.
    const para: string[] = [];
    while (i < lines.length) {
      const l = lines[i]!;
      if (
        l.trim() === "" || FENCE.test(l) || HEADING.test(l) || RULE.test(l) ||
        UL_ITEM.test(l) || OL_ITEM.test(l) || QUOTE.test(l)
      ) break;
      para.push(l);
      i += 1;
    }
    blocks.push({ type: "paragraph", children: parseInline(para.join("\n")) });
  }

  return blocks;
}
