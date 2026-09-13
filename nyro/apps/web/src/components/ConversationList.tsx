/**
 * Saved conversations (spec §63, §139).
 *
 * NYRO has persisted every conversation since Phase 1 and the UI had no way to
 * reach them — a system that quietly keeps your history and never shows it is
 * worse than one that does not keep it, because you cannot tell.
 *
 * Deleting is immediate and irreversible, so it asks first. It also says what
 * deletion does NOT do: run history and cost stay, because removing a chat
 * should not rewrite what you have spent.
 */
import { useEffect, useRef, useState } from "react";
import { api, NyroApiError, type Conversation, type SearchHit } from "../api.ts";
import { Button } from "./ui.tsx";

function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  const mins = Math.round(diffMs / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(iso).toLocaleDateString();
}

/**
 * Renders a ts_headline snippet.
 *
 * Postgres marks matches with <b> tags, which is the one place this UI has
 * server-produced markup. Rather than trusting it into the DOM, the string is
 * split on those exact tags and rebuilt as React elements — so the message
 * content itself can never be interpreted as HTML, whatever a model or a user
 * typed into it.
 */
function Snippet({ html }: { html: string }) {
  const parts = html.split(/(<b>|<\/b>)/);
  let bold = false;
  return (
    <>
      {parts.map((part, i) => {
        if (part === "<b>") { bold = true; return null; }
        if (part === "</b>") { bold = false; return null; }
        if (part === "") return null;
        return bold
          ? <mark key={i} className="bg-accent/25 text-accent">{part}</mark>
          : <span key={i}>{part}</span>;
      })}
    </>
  );
}

export function ConversationList({
  conversations,
  total,
  activeId,
  busy,
  onOpen,
  onNew,
  onChanged,
}: {
  conversations: Conversation[];
  /** How many exist. The list is one page, so it can be fewer than this. */
  total: number;
  activeId: string | null;
  /** True while a response is streaming; switching mid-stream would strand it. */
  busy: boolean;
  onOpen: (id: string) => void;
  onNew: () => void;
  onChanged: () => void;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [hits, setHits] = useState<SearchHit[] | null>(null);
  const [searching, setSearching] = useState(false);
  const searchSeq = useRef(0);

  // Debounced so typing does not fire a query per keystroke. The sequence
  // number drops results from a query the user has already moved past —
  // otherwise a slow early request can overwrite a fast later one.
  useEffect(() => {
    const q = query.trim();
    if (q.length === 0) { setHits(null); setSearching(false); return; }
    setSearching(true);
    const seq = ++searchSeq.current;
    const timer = setTimeout(() => {
      void api.search(q)
        .then((r) => { if (seq === searchSeq.current) { setHits(r); setSearching(false); } })
        .catch(() => { if (seq === searchSeq.current) { setHits([]); setSearching(false); } });
    }, 220);
    return () => clearTimeout(timer);
  }, [query]);

  async function act(fn: () => Promise<unknown>): Promise<void> {
    setErr(null);
    try {
      await fn();
      onChanged();
    } catch (e) {
      setErr(e instanceof NyroApiError ? e.message : String(e));
    }
  }

  return (
    // h-full is what makes the scroll region below work. `flex-1
    // overflow-y-auto` only scrolls inside a bounded box; with the aside's
    // height left to its content it simply grew, and at phone width — where
    // the wrapper caps it at 40vh — the list painted straight over the chat
    // column underneath.
    <aside className="flex h-full min-h-0 flex-col overflow-hidden rounded border border-line bg-panel">
      <header className="flex items-center justify-between border-b border-line px-3 py-2.5">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-dim">
          Conversations
        </h2>
        <Button onClick={onNew} disabled={busy}>+ New</Button>
      </header>

      <div className="border-b border-line p-2">
        <input
          id="conversation-search"
          className="w-full rounded border border-line bg-sunk px-2 py-1.5 text-xs text-ink outline-none placeholder:text-dim focus:border-accent"
          placeholder="Search conversations…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Escape") setQuery(""); }}
        />
      </div>

      {err ? <p className="border-b border-line px-3 py-2 text-[11px] text-stop">{err}</p> : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {hits !== null ? (
          hits.length === 0 ? (
            <p className="prose-sans px-3 py-4 text-[11.5px] leading-relaxed text-dim">
              {searching ? "Searching…" : `Nothing matches "${query.trim()}".`}
            </p>
          ) : (
            <ul>
              {hits.map((h) => (
                <li key={h.id} className={`border-b border-line/50 ${h.id === activeId ? "bg-accent/10" : ""}`}>
                  <button
                    type="button"
                    onClick={() => onOpen(h.id)}
                    disabled={busy}
                    className="w-full px-2 py-2 text-left disabled:cursor-not-allowed disabled:opacity-50"
                  >
                    <span className={`block truncate text-xs ${h.id === activeId ? "text-accent" : "text-ink"}`}>
                      {h.title}
                    </span>
                    {h.snippet ? (
                      <span className="prose-sans mt-1 block text-[11px] leading-snug text-dim">
                        <Snippet html={h.snippet} />
                      </span>
                    ) : (
                      <span className="mt-0.5 block text-[10px] text-dim">title match</span>
                    )}
                    <span className="mt-1 block text-[10px] text-dim">
                      {h.matches > 0 ? `${h.matches} matching message${h.matches === 1 ? "" : "s"} · ` : ""}
                      {relativeTime(h.updatedAt)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )
        ) : conversations.length === 0 ? (
          <p className="prose-sans px-3 py-4 text-[11.5px] leading-relaxed text-dim">
            Nothing saved yet. Every conversation is stored locally in your own Postgres and will appear here.
          </p>
        ) : (
          <ul>
            {conversations.map((c) => {
              const active = c.id === activeId;
              return (
                <li key={c.id} className={`border-b border-line/50 ${active ? "bg-accent/10" : ""}`}>
                  {renaming === c.id ? (
                    <form
                      className="flex gap-1 p-2"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const title = draft.trim();
                        if (title.length === 0) return;
                        setRenaming(null);
                        void act(() => api.renameConversation(c.id, title));
                      }}
                    >
                      <input
                        autoFocus
                        className="w-full rounded border border-accent bg-sunk px-2 py-1 text-xs text-ink outline-none"
                        value={draft}
                        onChange={(e) => setDraft(e.target.value)}
                        onKeyDown={(e) => { if (e.key === "Escape") setRenaming(null); }}
                      />
                      <button type="submit" className="rounded border border-line px-2 text-[11px] text-body">
                        Save
                      </button>
                    </form>
                  ) : confirmDelete === c.id ? (
                    <div className="p-2">
                      <p className="prose-sans mb-1.5 text-[11px] leading-relaxed text-stop">
                        Delete this conversation? Its messages go with it. Your spend and speed measurements stay.
                      </p>
                      <div className="flex gap-1.5">
                        <Button
                          variant="danger"
                          onClick={() => {
                            setConfirmDelete(null);
                            void act(() => api.deleteConversation(c.id));
                          }}
                        >
                          Delete
                        </Button>
                        <Button onClick={() => setConfirmDelete(null)}>Keep</Button>
                      </div>
                    </div>
                  ) : (
                    <div className="group flex items-start gap-1 px-2 py-2">
                      <button
                        type="button"
                        onClick={() => onOpen(c.id)}
                        disabled={busy}
                        className="min-w-0 flex-1 text-left disabled:cursor-not-allowed disabled:opacity-50"
                        title={busy ? "Finish or stop the current response first" : c.title}
                      >
                        <span className={`block truncate text-xs ${active ? "text-accent" : "text-ink"}`}>
                          {c.title}
                        </span>
                        <span className="mt-0.5 block text-[10px] text-dim">
                          {c.messageCount} message{c.messageCount === 1 ? "" : "s"} · {relativeTime(c.updatedAt)}
                        </span>
                      </button>
                      {/* Visible on focus as well as hover, so keyboard users can reach them. */}
                      <span className="flex shrink-0 gap-1 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100">
                        <button
                          type="button"
                          onClick={() => { setRenaming(c.id); setDraft(c.title); }}
                          className="rounded border border-line px-1.5 py-0.5 text-[10px] text-dim hover:text-ink"
                        >
                          Rename
                        </button>
                        <button
                          type="button"
                          onClick={() => setConfirmDelete(c.id)}
                          className="rounded border border-line px-1.5 py-0.5 text-[10px] text-dim hover:text-stop"
                        >
                          Delete
                        </button>
                      </span>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {hits !== null ? (
        <footer className="border-t border-line px-3 py-2">
          <button
            type="button"
            onClick={() => setQuery("")}
            className="text-[11px] text-dim underline-offset-2 hover:text-ink hover:underline"
          >
            Clear search
          </button>
        </footer>
      ) : null}

      {hits === null && total > conversations.length ? (
        <p className="prose-sans shrink-0 border-t border-line px-3 py-2 text-[10px] leading-relaxed text-dim">
          Showing the {conversations.length} most recent of {total.toLocaleString()}. The rest are still stored — search
          finds them, and they are all in your export.
        </p>
      ) : null}
    </aside>
  );
}
