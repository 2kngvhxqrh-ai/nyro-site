/**
 * Renders the parsed Markdown tree as React elements (spec §58).
 *
 * There is no HTML string in this file and no `dangerouslySetInnerHTML`.
 * Everything a model produced arrives as a text node, so markup in its output
 * cannot become markup on the page — a structural property, not a filter.
 */
import { useState } from "react";
import type { Block, Inline } from "../markdown/parse.ts";
import { parseMarkdown } from "../markdown/parse.ts";

function InlineNodes({ nodes }: { nodes: Inline[] }) {
  return (
    <>
      {nodes.map((node, i) => {
        switch (node.type) {
          case "text":
            return <span key={i}>{node.value}</span>;
          case "code":
            return (
              <code key={i} className="rounded border border-line bg-sunk px-1 py-0.5 text-[0.9em] text-ink">
                {node.value}
              </code>
            );
          case "bold":
            return <strong key={i} className="font-semibold text-ink"><InlineNodes nodes={node.children} /></strong>;
          case "italic":
            return <em key={i}><InlineNodes nodes={node.children} /></em>;
          case "link":
            return (
              <a
                key={i}
                href={node.href}
                target="_blank"
                // noreferrer as well as noopener: the destination should not
                // learn where the link was clicked from.
                rel="noopener noreferrer"
                className="text-accent underline underline-offset-2"
              >
                <InlineNodes nodes={node.children} />
              </a>
            );
        }
      })}
    </>
  );
}

function CodeBlock({ language, value, complete }: { language: string | null; value: string; complete: boolean }) {
  const [copied, setCopied] = useState(false);

  async function copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 1400);
    } catch {
      // Clipboard access can be denied; the code is still selectable by hand,
      // so this is not worth an error message.
    }
  }

  return (
    <div className="my-2 overflow-hidden rounded border border-line bg-sunk">
      <div className="flex items-center justify-between border-b border-line px-2.5 py-1">
        <span className="text-[10px] uppercase tracking-wider text-dim">
          {language ?? "code"}
          {/* Says the block is still arriving, rather than looking truncated. */}
          {!complete ? <span className="ml-2 text-wait">writing…</span> : null}
        </span>
        <button
          type="button"
          onClick={() => void copy()}
          className="rounded border border-line px-1.5 py-0.5 text-[10px] text-dim transition hover:text-ink"
        >
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      {/* Long lines scroll inside the block instead of widening the page. */}
      <pre className="overflow-x-auto px-3 py-2 text-[12.5px] leading-relaxed text-ink">
        <code>{value}</code>
      </pre>
    </div>
  );
}

function Blocks({ blocks }: { blocks: Block[] }) {
  return (
    <>
      {blocks.map((block, i) => {
        switch (block.type) {
          case "paragraph":
            return (
              <p key={i} className="mb-2 whitespace-pre-wrap last:mb-0">
                <InlineNodes nodes={block.children} />
              </p>
            );
          case "heading": {
            const size =
              block.level <= 2 ? "text-[15px]" : block.level === 3 ? "text-[14px]" : "text-[13px]";
            return (
              <p key={i} className={`mb-1.5 mt-3 font-semibold text-ink first:mt-0 ${size}`}>
                <InlineNodes nodes={block.children} />
              </p>
            );
          }
          case "code":
            return <CodeBlock key={i} language={block.language} value={block.value} complete={block.complete} />;
          case "list":
            return block.ordered ? (
              <ol key={i} start={block.start} className="mb-2 list-decimal space-y-0.5 pl-5 last:mb-0">
                {block.items.map((item, j) => <li key={j}><InlineNodes nodes={item} /></li>)}
              </ol>
            ) : (
              <ul key={i} className="mb-2 list-disc space-y-0.5 pl-5 last:mb-0">
                {block.items.map((item, j) => <li key={j}><InlineNodes nodes={item} /></li>)}
              </ul>
            );
          case "quote":
            return (
              <blockquote key={i} className="mb-2 border-l-2 border-line pl-3 text-dim last:mb-0">
                <Blocks blocks={block.children} />
              </blockquote>
            );
          case "rule":
            return <hr key={i} className="my-3 border-line" />;
        }
      })}
    </>
  );
}

export function Markdown({ source }: { source: string }) {
  return (
    <div className="text-sm text-ink">
      <Blocks blocks={parseMarkdown(source)} />
    </div>
  );
}
