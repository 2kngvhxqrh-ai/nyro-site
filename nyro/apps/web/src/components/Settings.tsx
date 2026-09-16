/**
 * Settings — spending limits (spec §64, §66).
 *
 * The design point: a limit shows what it is *currently doing*, not just what
 * it is set to. A budget you cannot see the effect of is one you will either
 * distrust or forget, and both end badly.
 */
import { useEffect, useState } from "react";
import { api, NyroApiError, type BudgetConfig, type BudgetState, type Instructions, type Model, type PerformanceState, type Provider, type RoutingRule } from "../api.ts";
import { DEMO_MODE } from "../demo-mode.ts";
import { recall, remember } from "../session-store.ts";
import { Badge, Button, Empty, Field, formatCost, inputClass, Panel } from "./ui.tsx";

/** An empty field means "no limit", which is different from zero. */
function toInput(v: number | null): string {
  return v === null ? "" : String(v);
}
function fromInput(v: string): number | null {
  const t = v.trim();
  if (t === "") return null;
  const n = Number.parseFloat(t);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export function Settings({ providers, models }: { providers: Provider[]; models: Model[] }) {
  const [state, setState] = useState<BudgetState | null>(null);
  const [draft, setDraft] = useState<BudgetConfig | null>(null);
  const [notice, setNotice] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [saving, setSaving] = useState(false);

  async function load(): Promise<void> {
    try {
      const b = await api.budget();
      setState(b);
      setDraft(b.config);
      // Clear a previous failure. Without this the panel came back with its
      // data AND the stale "Failed to fetch" still sitting above it, which
      // reads as "this is broken" on top of something that just worked.
      setNotice((n) => (n?.tone === "err" ? null : n));
    } catch (err) {
      setNotice({ tone: "err", text: err instanceof NyroApiError ? err.message : String(err) });
    }
  }

  useEffect(() => { void load(); }, []);

  async function save(): Promise<void> {
    if (!draft) return;
    setSaving(true);
    setNotice(null);
    try {
      await api.setBudget(draft);
      await load();
      setNotice({ tone: "ok", text: "Spending limits saved." });
    } catch (err) {
      setNotice({
        tone: "err",
        text: err instanceof NyroApiError ? `${err.info.code}: ${err.message}` : String(err),
      });
    } finally {
      setSaving(false);
    }
  }

  async function clear(): Promise<void> {
    setSaving(true);
    try {
      await api.clearBudget();
      await load();
      setNotice({ tone: "ok", text: "All spending limits removed." });
    } finally {
      setSaving(false);
    }
  }

  if (!state || !draft) {
    // A failed load used to sit on "Loading…" forever: the error was captured
    // into `notice` and this early return rendered before anything could show
    // it. With the API down that is an honest-looking spinner in front of a
    // known failure — the one state a user cannot act on.
    return (
      <Panel title="Spending limits" actions={notice?.tone === "err" ? <Button onClick={() => void load()}>Retry</Button> : undefined}>
        {notice?.tone === "err" ? (
          <p className="prose-sans px-1 py-2 text-[11.5px] leading-relaxed text-stop">
            Could not load your spending limits: {notice.text}
          </p>
        ) : (
          <Empty>Loading…</Empty>
        )}
      </Panel>
    );
  }

  const paidProviders = providers.filter((p) => !p.local);

  return (
    <div className="space-y-4">
      {notice ? (
        <p className={`rounded border px-3 py-2 text-xs ${notice.tone === "ok" ? "border-live/40 text-live" : "border-stop/40 text-stop"}`}>
          {notice.text}
        </p>
      ) : null}

      {/* What the limits are doing right now, before what they are set to. */}
      {state.status.message ? (
        <p className={`rounded border px-3 py-2 text-xs ${state.status.action === "block" ? "border-stop/40 text-stop" : "border-wait/40 text-wait"}`}>
          {state.status.message}
        </p>
      ) : null}

      <Panel title="Spent so far">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Meter label="Today" spent={state.spend.dayUsd} limit={state.config.dailyUsd} />
          <Meter label="This week" spent={state.spend.weekUsd} limit={state.config.weeklyUsd} />
          <Meter label="This month" spent={state.spend.monthUsd} limit={state.config.monthlyUsd} />
        </div>
        <p className="prose-sans mt-3 text-[11.5px] leading-relaxed text-dim">
          Spend is summed from the token counts each provider reported on its own responses, priced with the
          model registry. Local models are free and never count against a limit.
        </p>
      </Panel>

      <Panel
        title="Limits"
        actions={
          <div className="flex gap-2">
            <Button onClick={() => void clear()} disabled={saving}>Remove all</Button>
            <Button variant="primary" onClick={() => void save()} disabled={saving}>
              {saving ? "Saving…" : "Save"}
            </Button>
          </div>
        }
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Daily (USD)" hint="Leave empty for no limit.">
            <input className={inputClass} inputMode="decimal" value={toInput(draft.dailyUsd)}
              onChange={(e) => setDraft({ ...draft, dailyUsd: fromInput(e.target.value) })} />
          </Field>
          <Field label="Weekly (USD)" hint="Leave empty for no limit.">
            <input className={inputClass} inputMode="decimal" value={toInput(draft.weeklyUsd)}
              onChange={(e) => setDraft({ ...draft, weeklyUsd: fromInput(e.target.value) })} />
          </Field>
          <Field label="Monthly (USD)" hint="Leave empty for no limit.">
            <input className={inputClass} inputMode="decimal" value={toInput(draft.monthlyUsd)}
              onChange={(e) => setDraft({ ...draft, monthlyUsd: fromInput(e.target.value) })} />
          </Field>
          <Field label="Per request (USD)" hint="Models whose estimate exceeds this are not selected.">
            <input className={inputClass} inputMode="decimal" value={toInput(draft.perRequestUsd)}
              onChange={(e) => setDraft({ ...draft, perRequestUsd: fromInput(e.target.value) })} />
          </Field>
        </div>

        <div className="mt-4">
          <span className="mb-1 block text-[11px] uppercase tracking-wider text-dim">When a limit is reached</span>
          <div className="flex flex-wrap gap-2">
            <Choice
              active={draft.onExceeded === "local_only"}
              onClick={() => setDraft({ ...draft, onExceeded: "local_only" })}
              title="Keep working, locally"
              detail="Cloud models are excluded; free local models keep answering."
            />
            <Choice
              active={draft.onExceeded === "block"}
              onClick={() => setDraft({ ...draft, onExceeded: "block" })}
              title="Stop and tell me"
              detail="Requests are refused until you raise the limit."
            />
          </div>
          <p className="prose-sans mt-2 text-[11.5px] leading-relaxed text-dim">
            Either way, a request you mark local-only or sensitive is never blocked by a spending limit —
            it costs nothing to run.
          </p>
        </div>
      </Panel>

      <InstructionsPanel />

      <ExportPanel />

      <MeasuredRoutingPanel />

      <RoutingRulesPanel providers={providers} models={models} />

      <Panel title="Per-provider monthly caps">
        {paidProviders.length === 0 ? (
          <Empty>No paid providers configured. Local providers are free and need no cap.</Empty>
        ) : (
          <div className="space-y-2">
            {paidProviders.map((p) => {
              const spent = state.spend.perProviderMonthUsd[p.id] ?? 0;
              const cap = draft.perProviderMonthlyUsd[p.id];
              const exhausted = cap !== undefined && spent >= cap;
              return (
                <div key={p.id} className="flex flex-wrap items-center gap-3 rounded border border-line bg-sunk px-3 py-2">
                  <span className="text-xs text-ink">{p.displayName}</span>
                  {exhausted ? <Badge tone="stop">cap reached</Badge> : null}
                  <span className="text-[11px] text-dim tabular">{formatCost(spent)} this month</span>
                  <input
                    className={`${inputClass} ml-auto w-32`}
                    inputMode="decimal"
                    placeholder="no cap"
                    value={cap === undefined ? "" : String(cap)}
                    onChange={(e) => {
                      const next = { ...draft.perProviderMonthlyUsd };
                      const v = fromInput(e.target.value);
                      if (v === null) delete next[p.id];
                      else next[p.id] = v;
                      setDraft({ ...draft, perProviderMonthlyUsd: next });
                    }}
                  />
                </div>
              );
            })}
            <p className="prose-sans text-[11.5px] leading-relaxed text-dim">
              A provider over its cap is excluded from routing. The others keep working — one provider's
              cap is not a reason to stop everything.
            </p>
          </div>
        )}
      </Panel>
    </div>
  );
}

/**
 * Export (spec §108, §109).
 *
 * The public Nyro page states the constraint this project is built around:
 * you should be able to read everything the system knows in a text editor,
 * with nothing running. A Postgres database is the opposite of that, so export
 * is what makes the promise true rather than aspirational.
 *
 * Plain links rather than fetch-and-blob: the API sets Content-Disposition, so
 * the browser saves the file with the right name and nothing has to be held in
 * memory. A large history would be a bad thing to buffer twice.
 */
function ExportPanel() {
  return (
    <Panel title="Your data">
      <p className="prose-sans text-[11.5px] leading-relaxed text-dim">
        Everything NYRO knows, in a file you own. Conversations, providers, models, settings and usage
        totals. <span className="text-ink">No API keys are included</span> — they stay encrypted in the
        database and must be re-entered after a restore, which is stated inside the file too.
      </p>
      {DEMO_MODE ? (
        // The demo answers /api/export with an honest 409 — and could never
        // deliver it, because these were plain <a download> navigations and
        // the demo intercepts fetch. The browser downloaded the SPA fallback
        // instead: an HTML file, named like an export, that looked like a
        // successful backup of a database this page does not have.
        <p className="mt-3 rounded border border-line bg-sunk px-3 py-2 text-[11.5px] leading-relaxed text-dim">
          <span className="text-ink">Not in this demo.</span> Export reads your database, and this page has
          none — it runs NYRO&rsquo;s real router in the browser against a simulated provider. Run NYRO
          yourself and the two buttons here give you the whole thing.
        </p>
      ) : (
        <>
          <div className="mt-3 flex flex-wrap gap-2">
            <a
              href="/api/export"
              download
              className="rounded border border-accent bg-accent/15 px-3 py-1.5 text-xs text-accent transition hover:bg-accent/25"
            >
              Download JSON
            </a>
            <a
              href="/api/export?format=markdown"
              download
              className="rounded border border-line px-3 py-1.5 text-xs text-body transition hover:border-dim hover:text-ink"
            >
              Download conversations as Markdown
            </a>
          </div>
          <p className="prose-sans mt-2 text-[11.5px] leading-relaxed text-dim">
            The JSON is for backup and migration. The Markdown is your conversations as prose — readable in
            any text editor, with NYRO not running.
          </p>
        </>
      )}
    </Panel>
  );
}

/**
 * Measured routing (spec §13, §102, §147).
 *
 * The switch exists because §147 is explicit that the user must be able to
 * override a learned system. It defaults ON, because a measurement is simply
 * better evidence than a guess from a model's name — and the UI marks which
 * is which, so nothing here is hidden.
 */
/**
 * Custom instructions (spec §26).
 *
 * The chat API has always taken a per-request systemPrompt and there was no
 * way to set one, so every request sent null. This is that field, given a
 * place to live between requests.
 *
 * Off by default, and the switch is separate from the text on purpose: turning
 * instructions off to check whether they are what is making an answer strange
 * should not require deleting them first.
 */
function InstructionsPanel() {
  const [saved, setSaved] = useState<Instructions | null>(null);
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function load(): Promise<void> {
    try {
      const value = await api.instructions();
      setSaved(value);
      setText(value.text);
    } catch {
      setSaved(null);
    }
  }
  useEffect(() => { void load(); }, []);

  async function write(next: Instructions, message: string): Promise<void> {
    setBusy(true);
    setNotice(null);
    try {
      await api.setInstructions(next);
      await load();
      setNotice(message);
    } catch (err) {
      setNotice(err instanceof NyroApiError ? `${err.info.code}: ${err.message}` : String(err));
    } finally {
      setBusy(false);
    }
  }

  async function remove(): Promise<void> {
    setBusy(true);
    setNotice(null);
    try {
      await api.clearInstructions();
      await load();
      setNotice("Instructions removed.");
    } catch (err) {
      setNotice(err instanceof NyroApiError ? `${err.info.code}: ${err.message}` : String(err));
    } finally {
      setBusy(false);
    }
  }

  if (!saved) return null;

  const trimmed = text.trim();
  const dirty = text !== saved.text;
  const active = saved.enabled && saved.text.trim().length > 0;
  // Nobody writes instructions in order to keep them switched off, so the
  // FIRST save turns them on. It used to store `enabled: false` and say so,
  // which is honest and still leaves you with a setting that does nothing
  // until you notice a second button. Off exists so you can park instructions
  // you already have — which is why editing existing ones keeps the switch
  // where you left it, and emptying the box switches them off either way.
  const neverSaved = saved.text.trim().length === 0;

  return (
    <Panel
      title="Custom instructions"
      actions={
        <div className="flex flex-wrap gap-2">
          <Button
            onClick={() => void write({ enabled: !saved.enabled, text: saved.text }, saved.enabled ? "Instructions switched off." : "Instructions switched on.")}
            disabled={busy || saved.text.trim().length === 0}
          >
            {saved.enabled ? "Turn off" : "Turn on"}
          </Button>
          <Button onClick={() => void remove()} disabled={busy || saved.text.length === 0}>Remove</Button>
          <Button
            variant="primary"
            onClick={() =>
              void write(
                { enabled: trimmed.length > 0 && (neverSaved || saved.enabled), text },
                trimmed.length > 0 && neverSaved ? "Instructions saved, and switched on." : "Instructions saved.",
              )
            }
            disabled={busy || !dirty}
          >
            {busy ? "Saving…" : "Save"}
          </Button>
        </div>
      }
    >
      <div className="mb-2 flex items-center gap-2">
        <Badge tone={active ? "live" : "dim"}>{active ? "in effect" : "not in effect"}</Badge>
        <span className="prose-sans text-[11.5px] text-dim">
          {active
            ? "Sent as a system message ahead of every turn."
            : saved.text.trim().length === 0
              ? "Nothing saved yet."
              : "Saved, but switched off — no turn is using it."}
        </span>
      </div>

      <textarea
        className={`${inputClass} min-h-[7rem] resize-y`}
        value={text}
        spellCheck={false}
        placeholder="e.g. Answer in British English. When I ask for code, give me the code first and the explanation after."
        onChange={(e) => setText(e.target.value)}
      />

      <p className="prose-sans mt-2 text-[11.5px] leading-relaxed text-dim">
        {text.length.toLocaleString()} characters. Instructions are prepended to every turn, so they count
        toward the context window and toward what a cloud model charges — the routing preview sizes them
        along with the rest of the request. A turn that sends its own system prompt replaces these rather
        than adding to them.
      </p>

      {notice ? <p className="prose-sans mt-2 text-[11.5px] text-dim">{notice}</p> : null}
    </Panel>
  );
}

function MeasuredRoutingPanel() {
  const [state, setState] = useState<PerformanceState | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function load(): Promise<void> {
    try { setState(await api.performance()); } catch { setState(null); }
  }
  useEffect(() => { void load(); }, []);

  async function toggle(enabled: boolean): Promise<void> {
    setBusy(true);
    setErr(null);
    try {
      await api.setMeasuredRouting(enabled);
      await load();
    } catch (e) {
      // This was the only write in this file with no catch. The rejection
      // escaped as an unhandled page error, the switch stayed where it was,
      // and the user was told nothing at all -- pressing Turn off simply did
      // nothing whenever the API could not take it.
      setErr(e instanceof NyroApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  if (!state) return null;
  const measured = state.models.filter((m) => m.inUse);
  const learning = state.models.filter((m) => !m.inUse);

  return (
    <Panel
      title="Measured routing"
      actions={
        <Button onClick={() => void toggle(!state.enabled)} disabled={busy}>
          {state.enabled ? "Turn off" : "Turn on"}
        </Button>
      }
    >
      {err ? <p className="mb-3 rounded border border-stop/40 px-3 py-2 text-xs text-stop">{err}</p> : null}

      <p className="prose-sans text-[11.5px] leading-relaxed text-dim">
        {state.enabled
          ? "NYRO is ranking models on speed it measured from your own runs, not on guesses from the model name."
          : "Turned off. NYRO is ranking models on the catalog's guessed speed scores."}{" "}
        A model needs {state.minSamples} successful runs before its measurement is trusted. Speed is median
        output tokens per second, so a longer answer is not mistaken for a slower model.
      </p>

      {measured.length > 0 ? (
        <div className="mt-3 overflow-x-auto">
        <table className="w-full min-w-[30rem] text-left text-xs">
          <thead className="text-[10px] uppercase tracking-wider text-dim">
            <tr className="border-b border-line">
              <th className="py-2 pr-3">Model</th>
              <th className="py-2 pr-3">Tokens/sec</th>
              <th className="py-2 pr-3">Success</th>
              <th className="py-2 pr-3">Runs</th>
              <th className="py-2">Speed score</th>
            </tr>
          </thead>
          <tbody>
            {measured.map((m) => (
              <tr key={m.modelId} className="border-b border-line/50">
                <td className="py-2 pr-3 text-ink">{m.modelId}</td>
                <td className="py-2 pr-3 text-dim tabular">{m.medianTokensPerSecond}</td>
                <td className={`py-2 pr-3 tabular ${m.successRate < 0.95 ? "text-wait" : "text-dim"}`}>
                  {Math.round(m.successRate * 100)}%
                </td>
                <td className="py-2 pr-3 text-dim tabular">{m.samples}</td>
                <td className="py-2 text-live tabular">{m.measuredSpeedScore}</td>
              </tr>
            ))}
          </tbody>
        </table>
        </div>
      ) : (
        <Empty>No model has enough runs yet. Use NYRO and measurements will appear here.</Empty>
      )}

      {learning.length > 0 ? (
        <p className="prose-sans mt-2 text-[11.5px] text-dim">
          Still gathering evidence: {learning.map((m) => `${m.modelId} (${m.samples})`).join(", ")}.
        </p>
      ) : null}
    </Panel>
  );
}

/**
 * Task-specific routing rules (spec §10).
 *
 * The copy has one job beyond configuration: make clear that a rule is a
 * preference. A user who believes a rule is absolute would reasonably assume
 * "coding goes to Claude" also applies to a local-only request — it does not,
 * and finding that out by surprise is worse than reading it here.
 */
const RULES_DRAFT_KEY = "nyro.settings.rulesDraft";

function RoutingRulesPanel({ providers, models }: { providers: Provider[]; models: Model[] }) {
  // A draft you have not saved survives leaving this tab. Adding a rule used
  // to be local state only, so filling one in and glancing at Chat threw it
  // away without a word. Read in the initialiser, not an effect: see
  // `session-store.ts`.
  const [rules, setRules] = useState<RoutingRule[]>(() => {
    const raw = recall(RULES_DRAFT_KEY);
    if (raw === null) return [];
    try {
      const parsed: unknown = JSON.parse(raw);
      return Array.isArray(parsed) ? (parsed as RoutingRule[]) : [];
    } catch {
      return [];
    }
  });
  /** What the server has. Anything else on screen is unsaved. */
  const [onRecord, setOnRecord] = useState<RoutingRule[] | null>(null);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void api
      .routingRules()
      .then((r) => {
        setOnRecord(r.rules);
        // A draft from before the tab switch wins over the server's copy; with
        // no draft there is nothing to keep, so show what is saved.
        if (recall(RULES_DRAFT_KEY) === null) setRules(r.rules);
      })
      .catch(() => setOnRecord([]));
  }, []);

  const dirty = onRecord !== null && JSON.stringify(rules) !== JSON.stringify(onRecord);

  useEffect(() => {
    if (onRecord === null) return;
    remember(RULES_DRAFT_KEY, dirty ? JSON.stringify(rules) : "");
  }, [rules, onRecord, dirty]);

  async function save(next: RoutingRule[]): Promise<void> {
    setSaving(true);
    setErr(null);
    try {
      const saved = await api.setRoutingRules(next);
      setRules(saved.rules);
      setOnRecord(saved.rules);
      remember(RULES_DRAFT_KEY, "");
    } catch (e) {
      setErr(e instanceof NyroApiError ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }

  function add(): void {
    const first = providers[0];
    setRules([
      ...rules,
      {
        id: `rule-${Date.now()}`,
        enabled: true,
        name: "New rule",
        whenCapability: "coding",
        preferModelId: null,
        preferProviderId: first?.id ?? null,
      },
    ]);
  }

  function update(i: number, patch: Partial<RoutingRule>): void {
    setRules(rules.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }

  return (
    <Panel
      title="Routing rules"
      actions={
        <div className="flex flex-wrap items-center gap-2">
          {dirty ? <Badge tone="stop">unsaved</Badge> : null}
          <Button onClick={add} disabled={saving}>+ Add rule</Button>
          {dirty ? (
            <Button onClick={() => setRules(onRecord ?? [])} disabled={saving}>Discard</Button>
          ) : null}
          <Button variant={dirty ? "primary" : "default"} onClick={() => void save(rules)} disabled={saving || !dirty}>
            {saving ? "Saving…" : "Save rules"}
          </Button>
        </div>
      }
    >
      {err ? <p className="mb-3 rounded border border-stop/40 px-3 py-2 text-xs text-stop">{err}</p> : null}

      {dirty ? (
        <p className="mb-3 rounded border border-stop/40 px-3 py-2 text-[11.5px] text-stop">
          Not saved yet — nothing here is steering routing until you press Save rules.
        </p>
      ) : null}

      {rules.length === 0 ? (
        <Empty>No rules. NYRO picks a model on quality, speed and cost for every request.</Empty>
      ) : (
        <div className="space-y-2">
          {rules.map((rule, i) => (
            <div key={rule.id} className="grid gap-2 rounded border border-line bg-sunk p-3 sm:grid-cols-[auto_1fr_auto_1fr_auto]">
              <input
                type="checkbox"
                checked={rule.enabled}
                onChange={(e) => update(i, { enabled: e.target.checked })}
                className="mt-2 accent-[var(--color-accent)]"
                aria-label={`Enable ${rule.name}`}
              />
              <input className={inputClass} value={rule.name} onChange={(e) => update(i, { name: e.target.value })} />
              <span className="self-center text-[11px] uppercase tracking-wider text-dim">when</span>
              <select className={inputClass} value={rule.whenCapability} onChange={(e) => update(i, { whenCapability: e.target.value })}>
                {["coding", "reasoning", "vision", "tool_calling", "long_context"].map((c) => (
                  <option key={c} value={c}>{c}</option>
                ))}
              </select>
              {/* A local edit, like the fields beside it. It used to call save()
                  with the CURRENT draft, so removing one rule quietly committed
                  every unsaved change to the others. */}
              <Button variant="danger" onClick={() => setRules(rules.filter((_, idx) => idx !== i))}>Remove</Button>

              <span className="self-center text-[11px] uppercase tracking-wider text-dim sm:col-start-3">prefer</span>
              <select
                className={`${inputClass} sm:col-start-4`}
                value={rule.preferModelId ?? `provider:${rule.preferProviderId ?? ""}`}
                onChange={(e) => {
                  const v = e.target.value;
                  if (v.startsWith("provider:")) update(i, { preferProviderId: v.slice(9), preferModelId: null });
                  else update(i, { preferModelId: v, preferProviderId: null });
                }}
              >
                <optgroup label="Any model from provider">
                  {providers.map((p) => <option key={p.id} value={`provider:${p.id}`}>{p.displayName}</option>)}
                </optgroup>
                <optgroup label="A specific model">
                  {models.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
                </optgroup>
              </select>
            </div>
          ))}
        </div>
      )}

      <p className="prose-sans mt-3 text-[11.5px] leading-relaxed text-dim">
        A rule is a preference, not a command. It reorders the models NYRO already considers eligible, so it
        can never send a local-only or sensitive request to the cloud, never exceed a spending limit, and
        never fail a request because the preferred model is offline — NYRO falls back and says so.
      </p>
    </Panel>
  );
}

function Meter({ label, spent, limit }: { label: string; spent: number; limit: number | null }) {
  const pct = limit === null || limit === 0 ? null : Math.min(100, (spent / limit) * 100);
  const tone = pct === null ? "bg-dim" : pct >= 100 ? "bg-stop" : pct >= 80 ? "bg-wait" : "bg-live";
  return (
    <div className="rounded border border-line bg-sunk px-3 py-2">
      <div className="flex items-baseline justify-between">
        <span className="text-[10px] uppercase tracking-wider text-dim">{label}</span>
        <span className="text-[11px] text-dim tabular">{limit === null ? "no limit" : `of ${formatCost(limit)}`}</span>
      </div>
      <div className="mt-1 text-sm text-ink tabular">{formatCost(spent)}</div>
      <div className="mt-1.5 h-1 w-full overflow-hidden rounded bg-line">
        {/* No bar when there is no limit — a full-width bar would imply a ceiling. */}
        {pct === null ? null : <div className={`h-full ${tone}`} style={{ width: `${pct}%` }} />}
      </div>
    </div>
  );
}

function Choice({ active, onClick, title, detail }: { active: boolean; onClick: () => void; title: string; detail: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`flex-1 rounded border px-3 py-2 text-left transition ${
        active ? "border-accent bg-accent/10" : "border-line hover:border-dim"
      }`}
    >
      <span className={`block text-xs ${active ? "text-accent" : "text-ink"}`}>{title}</span>
      <span className="prose-sans mt-0.5 block text-[11px] text-dim">{detail}</span>
    </button>
  );
}
