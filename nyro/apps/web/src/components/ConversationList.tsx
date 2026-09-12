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
import { useState } from "react";
import { api, NyroApiError, type Conversation } from "../api.ts";
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

export function ConversationList({
  conversations,
  activeId,
  busy,
  onOpen,
  onNew,
  onChanged,
}: {
  conversations: Conversation[];
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
    <aside className="flex min-h-0 flex-col rounded border border-line bg-panel">
      <header className="flex items-center justify-between border-b border-line px-3 py-2.5">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-dim">
          Conversations
        </h2>
        <Button onClick={onNew} disabled={busy}>+ New</Button>
      </header>

      {err ? <p className="border-b border-line px-3 py-2 text-[11px] text-stop">{err}</p> : null}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {conversations.length === 0 ? (
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
    </aside>
  );
}
