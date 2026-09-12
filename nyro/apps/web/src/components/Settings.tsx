/**
 * Settings — spending limits (spec §64, §66).
 *
 * The design point: a limit shows what it is *currently doing*, not just what
 * it is set to. A budget you cannot see the effect of is one you will either
 * distrust or forget, and both end badly.
 */
import { useEffect, useState } from "react";
import { api, NyroApiError, type BudgetConfig, type BudgetState, type Model, type PerformanceState, type Provider, type RoutingRule } from "../api.ts";
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
    return <Panel title="Spending limits"><Empty>Loading…</Empty></Panel>;
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
 * Measured routing (spec §13, §102, §147).
 *
 * The switch exists because §147 is explicit that the user must be able to
 * override a learned system. It defaults ON, because a measurement is simply
 * better evidence than a guess from a model's name — and the UI marks which
 * is which, so nothing here is hidden.
 */
function MeasuredRoutingPanel() {
  const [state, setState] = useState<PerformanceState | null>(null);
  const [busy, setBusy] = useState(false);

  async function load(): Promise<void> {
    try { setState(await api.performance()); } catch { setState(null); }
  }
  useEffect(() => { void load(); }, []);

  async function toggle(enabled: boolean): Promise<void> {
    setBusy(true);
    try { await api.setMeasuredRouting(enabled); await load(); } finally { setBusy(false); }
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
      <p className="prose-sans text-[11.5px] leading-relaxed text-dim">
        {state.enabled
          ? "NYRO is ranking models on speed it measured from your own runs, not on guesses from the model name."
          : "Turned off. NYRO is ranking models on the catalog's guessed speed scores."}{" "}
        A model needs {state.minSamples} successful runs before its measurement is trusted. Speed is median
        output tokens per second, so a longer answer is not mistaken for a slower model.
      </p>

      {measured.length > 0 ? (
        <table className="mt-3 w-full text-left text-xs">
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
function RoutingRulesPanel({ providers, models }: { providers: Provider[]; models: Model[] }) {
  const [rules, setRules] = useState<RoutingRule[]>([]);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    void api.routingRules().then((r) => setRules(r.rules)).catch(() => setRules([]));
  }, []);

  async function save(next: RoutingRule[]): Promise<void> {
    setSaving(true);
    setErr(null);
    try {
      const saved = await api.setRoutingRules(next);
      setRules(saved.rules);
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
        <div className="flex gap-2">
          <Button onClick={add} disabled={saving}>+ Add rule</Button>
          <Button variant="primary" onClick={() => void save(rules)} disabled={saving}>
            {saving ? "Saving…" : "Save rules"}
          </Button>
        </div>
      }
    >
      {err ? <p className="mb-3 rounded border border-stop/40 px-3 py-2 text-xs text-stop">{err}</p> : null}

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
              <Button variant="danger" onClick={() => void save(rules.filter((_, idx) => idx !== i))}>Remove</Button>

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
