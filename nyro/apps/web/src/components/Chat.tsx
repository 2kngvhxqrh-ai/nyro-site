/**
 * Chat view (spec §58, §59, §60).
 *
 * Shows the routing decision before the first token arrives, streams the
 * answer, surfaces a fallback honestly when one happens, and has a Stop button
 * that actually cancels the upstream model call.
 *
 * What it deliberately does NOT show: any hidden reasoning. The "reasons" here
 * are the router's own short operational notes (spec §81).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { api, streamChat, type ApiError, type Conversation, type Decision, type Instructions, type Model, type RoutePreview } from "../api.ts";
import { ConversationList } from "./ConversationList.tsx";
import { Markdown } from "./Markdown.tsx";
import { Badge, Button, Dot, Empty, formatCost, inputClass, Panel } from "./ui.tsx";

/** Enough of the instructions to recognise them, without reprinting an essay. */
function firstLineOf(text: string): string {
  const flat = text.trim().replace(/\s+/g, " ");
  return flat.length > 120 ? `${flat.slice(0, 120)}…` : flat;
}

type Turn =
  | { kind: "user"; text: string }
  | {
      kind: "assistant";
      text: string;
      decision: Decision | null;
      attempts: Array<{ modelId: string; isFallback: boolean }>;
      usage: { inputTokens: number; outputTokens: number; costUsd: number } | null;
      /** Set when a spending limit constrained this request (spec §66). */
      budget: { message: string | null; action: string } | null;
      /** True for a turn loaded from history rather than streamed just now. */
      restored?: boolean;
      /** The user pressed Stop part-way through this answer. */
      stopped?: boolean;
      latencyMs: number | null;
      error: ApiError | null;
      streaming: boolean;
    };

const MODES = ["auto", "cheapest", "fastest", "best", "local_only", "cloud_only"] as const;

export function Chat({
  models,
  onActivity,
  initialTurns = [],
  showHistory = true,
}: {
  models: Model[];
  onActivity: () => void;
  /**
   * The browser demo keeps conversations in memory only, so a history sidebar
   * there would promise persistence it does not have.
   */
  showHistory?: boolean;
  /**
   * Seeds the transcript so the page opens showing what it does rather than an
   * empty box. Used only by the browser demo; the real app starts empty
   * because a real conversation should not begin with content nobody sent.
   */
  initialTurns?: Turn[];
}) {
  const [turns, setTurns] = useState<Turn[]>(initialTurns);

  // initialTurns can arrive after first render (the demo seed is imported
  // lazily), and useState only reads its argument once. Adopt it when it
  // shows up, but never clobber a conversation the user has already started.
  useEffect(() => {
    if (initialTurns.length > 0) {
      setTurns((prev) => (prev.length === 0 ? initialTurns : prev));
    }
  }, [initialTurns]);
  const [input, setInput] = useState("");
  const [mode, setMode] = useState<string>("auto");
  const [pinnedModel, setPinnedModel] = useState<string>("");
  const [privacy, setPrivacy] = useState<string>("normal");
  // Standing instructions are invisible by design -- they never appear in the
  // transcript -- so the request panel says when one is shaping every answer.
  // A system that quietly rewrites its own behaviour and never tells you is
  // the hardest kind to debug.
  const [instructions, setInstructions] = useState<Instructions | null>(null);

  /**
   * Where the message being typed WOULD go (spec §149).
   *
   * /api/route/preview has existed since Phase 1 and nothing called it, so the
   * one thing that makes a router legible — seeing the decision before you
   * spend a token — was invisible. It re-runs on the draft and on every
   * routing control, which is what makes "switch privacy to local_only and
   * watch the cloud models drop out" something you can see rather than read.
   */
  const [preview, setPreview] = useState<RoutePreview | null>(null);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns]);

  useEffect(() => {
    void api.instructions().then(setInstructions).catch(() => setInstructions(null));
  }, []);

  useEffect(() => {
    const draft = input.trim();
    // Nothing to route, and no preview while a real request is in flight —
    // a stale "would go to" beside a running answer is worse than none.
    if (draft.length === 0 || busy) { setPreview(null); return; }

    let cancelled = false;
    // Long enough that typing does not become a request per keystroke, short
    // enough that the answer arrives before you reach for Send.
    const timer = setTimeout(() => {
      api
        .previewRoute({
          message: draft,
          conversationId,
          mode,
          privacy,
          modelId: pinnedModel === "" ? null : pinnedModel,
        })
        .then((p) => { if (!cancelled) setPreview(p); })
        .catch(() => { if (!cancelled) setPreview(null); });
    }, 400);

    return () => { cancelled = true; clearTimeout(timer); };
  }, [input, busy, conversationId, mode, privacy, pinnedModel]);


  // Leaving the page mid-stream must cancel the server-side model call too.
  useEffect(() => () => abortRef.current?.abort(), []);

  const refreshConversations = useCallback(async () => {
    if (!showHistory) return;
    try {
      setConversations(await api.conversations());
    } catch {
      setConversations([]);
    }
  }, [showHistory]);

  useEffect(() => { void refreshConversations(); }, [refreshConversations]);

  /**
   * Loads a saved conversation into the transcript.
   *
   * Stored turns carry no routing decision — that was a property of the request
   * at the time, not of the message — so they render without one rather than
   * with an invented one.
   */
  async function openConversation(id: string): Promise<void> {
    if (busy) return;
    setLoadingHistory(true);
    try {
      const stored = await api.messages(id);
      setTurns(
        stored.map((m) =>
          m.role === "user"
            ? ({ kind: "user", text: m.content } as Turn)
            : ({
                kind: "assistant",
                text: m.content,
                decision: null,
                attempts: m.modelId ? [{ modelId: m.modelId, isFallback: false }] : [],
                usage: null,
                budget: null,
                latencyMs: null,
                error: null,
                streaming: false,
                restored: true,
                stopped: m.finishReason === "cancelled",
              } as Turn),
        ),
      );
      setConversationId(id);
    } catch {
      /* the list will refresh and drop it if it is gone */
      void refreshConversations();
    } finally {
      setLoadingHistory(false);
    }
  }

  function startNew(): void {
    if (busy) return;
    setTurns([]);
    setConversationId(null);
  }

  function patchLast(fn: (t: Extract<Turn, { kind: "assistant" }>) => void): void {
    setTurns((prev) => {
      const next = [...prev];
      const last = next.at(-1);
      if (last?.kind === "assistant") {
        const copy = { ...last };
        fn(copy);
        next[next.length - 1] = copy;
      }
      return next;
    });
  }

  function blankAssistantTurn(): Turn {
    return {
      kind: "assistant", text: "", decision: null, attempts: [], usage: null,
      budget: null, latencyMs: null, error: null, streaming: true,
    };
  }

  /**
   * Re-answer the last turn (spec §58, §103).
   *
   * The prompt is NOT resent: the server takes it from the stored conversation,
   * which is what stops a regenerate from duplicating the question or quietly
   * changing it. `overrideModel` is how "use another model" works.
   */
  async function regenerate(overrideModel?: string): Promise<void> {
    if (busy || !conversationId) return;

    setBusy(true);
    // Drop the answer being replaced; the question above it stays.
    setTurns((prev) => {
      const next = [...prev];
      if (next.at(-1)?.kind === "assistant") next.pop();
      return [...next, blankAssistantTurn()];
    });

    const ac = new AbortController();
    abortRef.current = ac;

    await runStream(
      {
        message: "",
        regenerate: true,
        conversationId,
        mode,
        privacy,
        modelId: overrideModel ?? (pinnedModel === "" ? null : pinnedModel),
      },
      ac,
    );
  }

  /**
   * Replace the last question and answer it again (spec §58).
   *
   * The mirror of regenerate: the prompt IS resent, because changing it is the
   * whole point. The server rewinds the same way, so the transcript ends up as
   * though the question had been asked correctly the first time rather than
   * carrying a bad exchange forever.
   */
  async function editLast(text: string): Promise<void> {
    const next = text.trim();
    if (busy || !conversationId || next.length === 0) return;

    setBusy(true);
    setTurns((prev) => {
      const out = [...prev];
      if (out.at(-1)?.kind === "assistant") out.pop();
      const lastUser = out.length - 1;
      if (out[lastUser]?.kind === "user") out[lastUser] = { kind: "user", text: next };
      return [...out, blankAssistantTurn()];
    });

    const ac = new AbortController();
    abortRef.current = ac;

    await runStream(
      {
        message: next,
        editLast: true,
        conversationId,
        mode,
        privacy,
        modelId: pinnedModel === "" ? null : pinnedModel,
      },
      ac,
    );
    // The sidebar title is derived from the first question, so an edit of it
    // renames the conversation server-side.
    void refreshConversations();
  }

  async function send(): Promise<void> {
    const message = input.trim();
    if (message.length === 0 || busy) return;

    setInput("");
    setBusy(true);
    setTurns((prev) => [...prev, { kind: "user", text: message }, blankAssistantTurn()]);

    const ac = new AbortController();
    abortRef.current = ac;

    await runStream(
      {
        message,
        conversationId,
        mode,
        privacy,
        modelId: pinnedModel === "" ? null : pinnedModel,
      },
      ac,
    );
  }

  async function runStream(body: Record<string, unknown>, ac: AbortController): Promise<void> {
    await streamChat(
      body,
      {
        onBudget: (b) => patchLast((t) => { t.budget = b; }),
        onRouting: (d) => patchLast((t) => { t.decision = d; }),
        onAttempt: (a) => patchLast((t) => { t.attempts = [...t.attempts, a]; }),
        onDelta: (text) => patchLast((t) => { t.text += text; }),
        onUsage: (u) => patchLast((t) => { t.usage = u; }),
        onDone: (d) => {
          setConversationId(d.conversationId);
          patchLast((t) => { t.latencyMs = d.latencyMs; t.streaming = false; });
        },
        onError: (e) => patchLast((t) => { t.error = e; t.streaming = false; }),
      },
      ac.signal,
    );

    patchLast((t) => { t.streaming = false; });
    setBusy(false);
    abortRef.current = null;
    onActivity();
    void refreshConversations();
  }

  function stop(): void {
    abortRef.current?.abort();
    setBusy(false);
    // Marked here as well as on reload, so the screen says the same thing
    // about this answer before and after a refresh. The server keeps the
    // partial text with finish_reason 'cancelled'.
    patchLast((t) => { t.streaming = false; if (t.text.trim().length > 0) t.stopped = true; });
  }

  const enabledModels = models.filter((m) => m.enabled);
  // A rewind (regenerate or edit) needs a stored conversation to rewind, and
  // nothing else. It was gated on `showHistory` -- whether the sidebar renders
  // -- which hid two working behaviours from the browser demo, whose in-memory
  // core implements both. The seeded demo transcript has no conversationId, so
  // it correctly offers neither until you send something of your own.
  const canRewind = conversationId !== null && !busy;
  const lastUserIndex = turns.map((t) => t.kind).lastIndexOf("user");

  const chatColumn = (
    <div className="flex h-full min-h-0 min-w-0 flex-col gap-4">
      <Panel title="Request">
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="block">
            <span className="mb-1 block text-[11px] uppercase tracking-wider text-dim">Routing mode</span>
            <select className={inputClass} value={mode} onChange={(e) => setMode(e.target.value)}>
              {MODES.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] uppercase tracking-wider text-dim">Privacy</span>
            <select className={inputClass} value={privacy} onChange={(e) => setPrivacy(e.target.value)}>
              <option value="normal">normal</option>
              <option value="sensitive">sensitive (local only)</option>
              <option value="local_only">local_only</option>
              <option value="public">public</option>
            </select>
          </label>
          <label className="block">
            <span className="mb-1 block text-[11px] uppercase tracking-wider text-dim">Pin a model (optional)</span>
            <select className={inputClass} value={pinnedModel} onChange={(e) => setPinnedModel(e.target.value)}>
              <option value="">let NYRO choose</option>
              {enabledModels.map((m) => (
                <option key={m.id} value={m.id}>{m.displayName} {m.local ? "(local)" : ""}</option>
              ))}
            </select>
          </label>
        </div>
        {privacy !== "normal" && privacy !== "public" ? (
          <p className="mt-3 text-[11px] text-live">
            Privacy is enforced in the router: cloud models are excluded entirely, including from the fallback chain.
            If no local model is available the request fails rather than escalating.
          </p>
        ) : null}
        {instructions && instructions.enabled && instructions.text.trim().length > 0 ? (
          <p className="prose-sans mt-3 text-[11px] leading-relaxed text-dim">
            <span className="uppercase tracking-wider text-accent">Custom instructions</span>{" "}
            are being sent with every turn: <span className="text-ink">{firstLineOf(instructions.text)}</span>{" "}
            Change or switch them off in Settings.
          </p>
        ) : null}
      </Panel>

      <div className="flex-1 space-y-3 overflow-y-auto">
        {turns.length === 0 ? (
          <Panel title="Conversation">
            <Empty>
              {enabledModels.length === 0
                ? "No models are enabled yet. Add a provider on the Models page, then run discovery."
                : "Send a message. NYRO will pick a model and show you why."}
            </Empty>
          </Panel>
        ) : null}

        {turns.map((turn, i) =>
          turn.kind === "user" ? (
            <UserTurn
              key={i}
              text={turn.text}
              // Only the most recent question is editable. Rewriting an earlier
              // one would invalidate every answer that came after it, and
              // silently discarding those is not something a chat should do
              // behind a pencil icon.
              onEdit={i === lastUserIndex && canRewind ? (text) => void editLast(text) : undefined}
            />
          ) : (
            <AssistantTurn
              key={i}
              turn={turn}
              // Only the last answer can be regenerated: replacing an earlier
              // one would orphan every turn that followed it.
              onRetry={
                canRewind && i === turns.length - 1 && !turn.streaming
                  ? (modelId) => void regenerate(modelId)
                  : undefined
              }
              models={enabledModels}
            />
          ),
        )}
        <div ref={bottomRef} />
      </div>

      <div className="rounded border border-line bg-panel p-3">
        <textarea
          className={`${inputClass} min-h-[76px] resize-y text-sm`}
          placeholder="Message NYRO…  (Enter to send, Shift+Enter for a newline)"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); void send(); }
          }}
        />
        <RoutePreviewStrip preview={preview} />

        <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
          <span className="text-[11px] text-dim">
            {enabledModels.length} model{enabledModels.length === 1 ? "" : "s"} available
            {conversationId ? " · saved" : ""}
            {loadingHistory ? " · loading history…" : ""}
          </span>
          <div className="flex gap-2">
            {busy ? <Button variant="danger" onClick={stop}>Stop</Button> : null}
            <Button variant="primary" onClick={() => void send()} disabled={busy || input.trim().length === 0}>
              {busy ? "Working…" : "Send"}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );

  if (!showHistory) return chatColumn;

  // The sidebar sits beside the chat on wide screens and above it on narrow
  // ones, where it is capped so it cannot push the composer off the screen.
  //
  // min-w-0 on BOTH children is load-bearing, not tidiness. A grid item
  // defaults to min-width:auto, so the track refuses to shrink below its
  // content's min-content width — and a conversation title is `truncate`,
  // which means white-space:nowrap, which means its min-content is the whole
  // untruncated title. At phone width that dragged the single column out to
  // 544px inside a 390px viewport and clipped the app on both edges. The
  // lg: track already says minmax(0,…); the stacked one had nothing.
  return (
    <div className="grid h-full min-h-0 gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
      <div className="min-w-0 max-h-[40vh] min-h-0 overflow-hidden lg:max-h-none">
        <ConversationList
          conversations={conversations}
          activeId={conversationId}
          busy={busy}
          onOpen={(id) => void openConversation(id)}
          onNew={startNew}
          onChanged={() => {
            void refreshConversations();
            // The open conversation may have just been deleted.
            void api.conversations().then((list) => {
              if (conversationId && !list.some((c) => c.id === conversationId)) startNew();
            });
          }}
        />
      </div>
      {chatColumn}
    </div>
  );
}

function AssistantTurn({
  turn,
  onRetry,
  models = [],
}: {
  turn: Extract<Turn, { kind: "assistant" }>;
  /** Absent when this turn cannot be regenerated. */
  onRetry?: (modelId?: string) => void;
  models?: Model[];
}) {
  const chosen = turn.decision?.chosen;
  const usedFallback = turn.attempts.some((a) => a.isFallback);
  const actualModelId = turn.attempts.at(-1)?.modelId ?? chosen?.modelId ?? null;

  /*
   * Label the turn by the model that ACTUALLY ran. After a fallback the first
   * choice is not what answered, and showing its provider badge would
   * misattribute the response — the one thing a routing UI must never do.
   */
  const ran =
    chosen && actualModelId === chosen.modelId
      ? chosen
      : turn.decision?.fallbacks.find((f) => f.modelId === actualModelId) ?? null;

  return (
    <div className="rounded border border-line bg-panel">
      <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-2">
        <Dot state={turn.error ? "unreachable" : turn.streaming ? "degraded" : "healthy"} />
        {chosen ? (
          <>
            <span className="text-xs text-ink">{ran?.displayName ?? actualModelId}</span>
            {ran ? (
              ran.local ? <Badge tone="live">local</Badge> : <Badge>{ran.providerId}</Badge>
            ) : null}
            <Badge tone="accent">{turn.decision?.mode}</Badge>
          </>
        ) : turn.restored ? (
          <>
            <span className="text-xs text-ink">{actualModelId ?? "assistant"}</span>
            <span className="text-[11px] text-dim">from history</span>
          </>
        ) : (
          <span className="text-xs text-dim">{turn.streaming ? "Routing…" : "No model selected"}</span>
        )}
        {turn.latencyMs !== null ? <span className="text-[11px] text-dim">{turn.latencyMs} ms</span> : null}
        {turn.usage ? (
          <span className="text-[11px] text-dim">
            {turn.usage.inputTokens}→{turn.usage.outputTokens} tok · {formatCost(turn.usage.costUsd)}
          </span>
        ) : null}
      </div>

      {turn.budget?.message ? (
        <p className="prose-sans border-b border-line px-4 py-2 text-[11.5px] text-wait">{turn.budget.message}</p>
      ) : null}

      {usedFallback ? (
        <p className="border-b border-line px-4 py-2 text-[11px] text-wait">
          The first model failed. NYRO fell back to {ran?.displayName ?? actualModelId}. Attempts:{" "}
          {turn.attempts.map((a) => a.modelId).join(" → ")}
        </p>
      ) : null}

      {chosen && chosen.reasons.length > 0 ? (
        <p className="border-b border-line px-4 py-2 text-[11px] text-dim">Chosen because: {chosen.reasons.join(" · ")}</p>
      ) : null}

      {turn.stopped ? (
        <p className="border-b border-line px-4 py-2 text-[11px] text-wait">
          You stopped this answer part-way. What the model had written is kept, and it is incomplete.
        </p>
      ) : null}

      <div className="px-4 py-3">
        {turn.error ? (
          <div className="rounded border border-stop/40 bg-stop/5 p-3">
            <p className="text-xs text-stop">{turn.error.message}</p>
            <p className="mt-1 text-[11px] text-dim">
              code: {turn.error.code} · component: {turn.error.component}
              {turn.error.retryable ? " · retryable" : ""}
            </p>
            {turn.decision && turn.decision.rejected.length > 0 ? (
              <details className="mt-2">
                <summary className="cursor-pointer text-[11px] text-dim">
                  Why no model was used ({turn.decision.rejected.length})
                </summary>
                <ul className="mt-1 space-y-0.5">
                  {turn.decision.rejected.map((r) => (
                    <li key={r.modelId} className="text-[11px] text-dim">{r.modelId}: {r.reason}</li>
                  ))}
                </ul>
              </details>
            ) : null}
          </div>
        ) : (
          <div className="stream-body">
            <Markdown source={turn.text} />
            {turn.streaming ? <span className="ml-0.5 animate-pulse text-accent">▍</span> : null}
          </div>
        )}
      </div>

      {onRetry ? <RetryBar onRetry={onRetry} models={models} failed={turn.error !== null} /> : null}
    </div>
  );
}

/**
 * Retry controls (spec §58, §103).
 *
 * Two separate actions, because they answer different questions: "that went
 * wrong, try again" and "try again somewhere else". Collapsing them into one
 * would make the second require fiddling with the request panel first.
 */
/**
 * What the router would do with the current draft, before anything is spent.
 *
 * Deliberately quiet: one line, and the reasoning behind a `details` the user
 * opens when they want it. A dry run that shouts is a dry run people turn off.
 */
function RoutePreviewStrip({ preview }: { preview: RoutePreview | null }) {
  if (!preview) return null;

  const chosen = preview.decision.chosen;
  const rejected = preview.decision.rejected;

  return (
    <div className="mt-2 border-t border-line pt-2 text-[11px]">
      {chosen ? (
        <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className="text-dim">would go to</span>
          <span className="text-ink">{chosen.displayName}</span>
          {chosen.local ? (
            <span className="text-live">local · free</span>
          ) : (
            <span className="text-dim">{chosen.providerId} · ~{formatCost(chosen.estimatedCostUsd)}</span>
          )}
          <span className="text-dim">· ~{preview.estimatedInputTokens.toLocaleString()} tok in</span>
          {preview.budget.message ? <span className="text-wait">· {preview.budget.message}</span> : null}
        </div>
      ) : rejected.length === 0 ? (
        // Nothing was even considered, so there is nothing to relax. Telling a
        // first-run user to loosen their privacy setting sends them to fix a
        // problem they do not have; the real one is that no provider is
        // reachable yet.
        <p className="text-wait">
          No models are available yet. Add a provider on the Models page and run discovery.
        </p>
      ) : (
        <p className="text-stop">
          Every available model was excluded. Open the reasons below — relaxing privacy or clearing the model pin is
          usually what is needed.
        </p>
      )}

      {chosen || rejected.length > 0 ? (
        <details className="mt-1">
          <summary className="cursor-pointer text-dim">
            why{rejected.length > 0 ? ` — and why not the other ${rejected.length}` : ""}
          </summary>
          {chosen && chosen.reasons.length > 0 ? (
            <p className="mt-1 text-dim">Chosen because: {chosen.reasons.join(" · ")}</p>
          ) : null}
          {preview.decision.fallbacks.length > 0 ? (
            <p className="mt-1 text-dim">
              Then, if it fails: {preview.decision.fallbacks.map((f) => f.displayName).join(" → ")}
            </p>
          ) : null}
          {rejected.length > 0 ? (
            <ul className="mt-1 space-y-0.5">
              {rejected.map((r) => (
                <li key={r.modelId} className="text-dim">{r.modelId}: {r.reason}</li>
              ))}
            </ul>
          ) : null}
          <p className="mt-1 text-dim">Nothing has been sent. This is the decision, not the answer.</p>
        </details>
      ) : null}
    </div>
  );
}

/**
 * A question, optionally editable in place.
 *
 * Editing is offered on the last question only, and it is explicit: a pencil
 * that silently replaced an answer would be indistinguishable from NYRO
 * changing its mind on its own.
 */
function UserTurn({ text, onEdit }: { text: string; onEdit?: (text: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null);

  if (draft !== null && onEdit) {
    return (
      <div className="ml-auto w-full max-w-[85%] rounded border border-accent/40 bg-sunk p-3">
        <textarea
          autoFocus
          className={`${inputClass} min-h-[70px] resize-y text-sm`}
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") setDraft(null);
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              if (draft.trim().length > 0) { onEdit(draft); setDraft(null); }
            }
          }}
        />
        <div className="mt-2 flex flex-wrap items-center justify-end gap-2">
          <span className="prose-sans mr-auto text-[11px] text-dim">
            Replaces this question and the answer below it. Earlier turns are untouched.
          </span>
          <Button onClick={() => setDraft(null)}>Cancel</Button>
          <Button
            variant="primary"
            disabled={draft.trim().length === 0}
            onClick={() => { onEdit(draft); setDraft(null); }}
          >
            Save and re-answer
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="ml-auto flex max-w-[85%] items-start gap-2">
      {onEdit ? (
        <button
          type="button"
          className="mt-1 shrink-0 rounded border border-line px-2 py-1 text-[10px] uppercase tracking-wider text-dim transition hover:border-accent/40 hover:text-accent"
          onClick={() => setDraft(text)}
        >
          Edit
        </button>
      ) : null}
      <div className="rounded border border-line bg-sunk px-4 py-2.5 text-sm text-ink">{text}</div>
    </div>
  );
}

function RetryBar({
  onRetry,
  models,
  failed,
}: {
  onRetry: (modelId?: string) => void;
  models: Model[];
  failed: boolean;
}) {
  const [picking, setPicking] = useState(false);

  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-line px-4 py-2">
      <Button variant={failed ? "primary" : "default"} onClick={() => onRetry()}>
        {failed ? "Try again" : "Regenerate"}
      </Button>

      {picking ? (
        <select
          autoFocus
          className={`${inputClass} w-auto`}
          defaultValue=""
          onChange={(e) => {
            const id = e.target.value;
            setPicking(false);
            if (id !== "") onRetry(id);
          }}
          onBlur={() => setPicking(false)}
        >
          <option value="">choose a model…</option>
          {models.map((m) => (
            <option key={m.id} value={m.id}>{m.displayName}{m.local ? " (local)" : ""}</option>
          ))}
        </select>
      ) : (
        <Button onClick={() => setPicking(true)} disabled={models.length === 0}>
          Use another model
        </Button>
      )}

      <span className="prose-sans text-[11px] text-dim">
        Re-answers this turn. Your question is not resent or changed.
      </span>
    </div>
  );
}

export { api };
export type { Turn };
