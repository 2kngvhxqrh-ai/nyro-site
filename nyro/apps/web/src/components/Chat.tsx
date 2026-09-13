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
import { api, streamChat, type ApiError, type Conversation, type Decision, type Model } from "../api.ts";
import { ConversationList } from "./ConversationList.tsx";
import { Markdown } from "./Markdown.tsx";
import { Badge, Button, Dot, Empty, formatCost, inputClass, Panel } from "./ui.tsx";

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
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [turns]);

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
    patchLast((t) => { t.streaming = false; });
  }

  const enabledModels = models.filter((m) => m.enabled);

  const chatColumn = (
    <div className="flex h-full min-h-0 flex-col gap-4">
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
            <div key={i} className="ml-auto max-w-[85%] rounded border border-line bg-sunk px-4 py-2.5 text-sm text-ink">
              {turn.text}
            </div>
          ) : (
            <AssistantTurn
              key={i}
              turn={turn}
              // Only the last answer can be regenerated: replacing an earlier
              // one would orphan every turn that followed it.
              onRetry={
                showHistory && conversationId && i === turns.length - 1 && !busy && !turn.streaming
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
  return (
    <div className="grid h-full min-h-0 gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
      <div className="max-h-[40vh] min-h-0 lg:max-h-none">
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
