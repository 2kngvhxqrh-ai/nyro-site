/**
 * Settings — spending limits (spec §64, §66).
 *
 * The design point: a limit shows what it is *currently doing*, not just what
 * it is set to. A budget you cannot see the effect of is one you will either
 * distrust or forget, and both end badly.
 */
import { useEffect, useState } from "react";
import { api, NyroApiError, type BudgetConfig, type BudgetState, type Provider } from "../api.ts";
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

export function Settings({ providers }: { providers: Provider[] }) {
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
