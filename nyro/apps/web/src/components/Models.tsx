/**
 * Models & providers (spec §8).
 *
 * Add or remove providers, store keys, run discovery, test connections, and
 * enable/disable individual models. An API key entered here is POSTed once and
 * never read back — the field shows only a last-4 hint afterwards.
 */
import { useEffect, useState } from "react";
import { api, NyroApiError, type Model, type ModelPerformance, type Preset, type Provider } from "../api.ts";
import { Badge, Button, Dot, Empty, Field, formatCost, inputClass, Panel } from "./ui.tsx";

export function Models({
  providers, models, refresh,
}: {
  providers: Provider[]; models: Model[]; refresh: () => Promise<void>;
}) {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [perf, setPerf] = useState<Map<string, ModelPerformance>>(new Map());
  const [editing, setEditing] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [notice, setNotice] = useState<{ tone: "ok" | "err"; text: string } | null>(null);
  const [pending, setPending] = useState<string | null>(null);

  useEffect(() => { void api.presets().then(setPresets).catch(() => setPresets([])); }, []);
  useEffect(() => {
    void api.performance()
      .then((p) => setPerf(new Map(p.models.map((m) => [m.modelId, m]))))
      .catch(() => setPerf(new Map()));
  }, [models]);

  async function run(label: string, fn: () => Promise<string>): Promise<void> {
    setPending(label);
    setNotice(null);
    try {
      setNotice({ tone: "ok", text: await fn() });
      await refresh();
    } catch (err) {
      const msg = err instanceof NyroApiError ? `${err.info.code}: ${err.message}` : String(err);
      setNotice({ tone: "err", text: msg });
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-4">
      {notice ? (
        <p className={`rounded border px-3 py-2 text-xs ${notice.tone === "ok" ? "border-live/40 text-live" : "border-stop/40 text-stop"}`}>
          {notice.text}
        </p>
      ) : null}

      <Panel
        title="Providers"
        actions={
          <div className="flex gap-2">
            <Button
              onClick={() => void run("discover-all", async () => {
                await api.discoverAll();
                return "Discovery finished for all enabled providers.";
              })}
              disabled={pending !== null}
            >
              {pending === "discover-all" ? "Discovering…" : "Discover all"}
            </Button>
            <Button variant="primary" onClick={() => setAdding((v) => !v)}>
              {adding ? "Cancel" : "+ Add provider"}
            </Button>
          </div>
        }
      >
        {adding ? (
          <AddProviderForm
            presets={presets}
            existing={providers}
            onDone={async (msg) => { setAdding(false); setNotice({ tone: "ok", text: msg }); await refresh(); }}
            onError={(msg) => setNotice({ tone: "err", text: msg })}
          />
        ) : null}

        {providers.length === 0 && !adding ? (
          <Empty>No providers configured. Add Ollama for local models, or a cloud provider with an API key.</Empty>
        ) : null}

        <div className="space-y-2">
          {providers.map((p) => (
            <div key={p.id} className="rounded border border-line bg-sunk p-3">
              <div className="flex flex-wrap items-center gap-2">
                <Dot state={p.health.state} />
                <span className="text-sm text-ink">{p.displayName}</span>
                <Badge tone={p.local ? "live" : "dim"}>{p.local ? "local" : "cloud"}</Badge>
                <Badge>{p.transport}</Badge>
                {p.hasApiKey ? <Badge tone="accent">key {p.apiKeyHint}</Badge> : null}
                {!p.enabled ? <Badge tone="stop">disabled</Badge> : null}
                <span className="ml-auto flex gap-2">
                  <Button
                    onClick={() => void run(`test-${p.id}`, async () => {
                      const r = await api.testProvider(p.id);
                      return `${p.displayName}: ${r.health.state} — ${r.health.detail}`;
                    })}
                    disabled={pending !== null}
                  >
                    {pending === `test-${p.id}` ? "Testing…" : "Test"}
                  </Button>
                  <Button
                    onClick={() => void run(`disc-${p.id}`, async () => {
                      const r = await api.discoverProvider(p.id);
                      return r.ok
                        ? `${p.displayName}: found ${r.modelsFound} model(s), pruned ${r.modelsPruned}.`
                        : `${p.displayName}: discovery failed — ${r.detail}`;
                    })}
                    disabled={pending !== null}
                  >
                    Discover
                  </Button>
                  <Button
                    variant="danger"
                    onClick={() => void run(`del-${p.id}`, async () => {
                      await api.deleteProvider(p.id);
                      return `Removed ${p.displayName} and its models.`;
                    })}
                    disabled={pending !== null}
                  >
                    Remove
                  </Button>
                </span>
              </div>
              <p className="mt-1.5 text-[11px] text-dim">
                {p.baseUrl || "(no base URL)"} · {p.health.detail || "never checked"}
                {p.health.latencyMs !== null ? ` · ${p.health.latencyMs} ms` : ""}
              </p>
            </div>
          ))}
        </div>
      </Panel>

      <Panel title={`Models (${models.length})`}>
        {models.length === 0 ? (
          <Empty>No models discovered yet. Add a provider and press Discover.</Empty>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="text-[10px] uppercase tracking-wider text-dim">
                <tr className="border-b border-line">
                  <th className="py-2 pr-3">Model</th>
                  <th className="py-2 pr-3">Provider</th>
                  <th className="py-2 pr-3">Context</th>
                  <th className="py-2 pr-3">Cost / 1M</th>
                  <th className="py-2 pr-3">Speed</th>
                  <th className="py-2 pr-3">Reason</th>
                  <th className="py-2 pr-3">Code</th>
                  <th className="py-2 pr-3">Source</th>
                  <th className="py-2">On</th>
                </tr>
              </thead>
              <tbody>
                {models.map((m) => (
                  <tr key={m.id} className="border-b border-line/50">
                    <td className="py-2 pr-3 text-ink">
                      {m.displayName}
                      {m.local ? <span className="ml-2 text-[10px] text-live">local</span> : null}
                    </td>
                    <td className="py-2 pr-3 text-dim">{m.providerId}</td>
                    <td className="py-2 pr-3 text-dim">{m.contextWindow.toLocaleString()}</td>
                    <td className="py-2 pr-3 text-dim">
                      {m.inputCostPer1m === 0 && m.outputCostPer1m === 0
                        ? "free"
                        : `${formatCost(m.inputCostPer1m)} / ${formatCost(m.outputCostPer1m)}`}
                    </td>
                    <td className="py-2 pr-3">
                      {(() => {
                        const observed = perf.get(m.id);
                        if (observed?.inUse && observed.measuredSpeedScore !== null) {
                          return (
                            <span
                              className="text-live"
                              title={`Measured: ${observed.medianTokensPerSecond} tok/s over ${observed.samples} runs`}
                            >
                              {observed.measuredSpeedScore}
                            </span>
                          );
                        }
                        if (observed) {
                          return (
                            <span className="text-dim" title={`Measuring: ${observed.samples} run(s) so far`}>
                              {m.scores.speed}
                              <span className="ml-1 text-[10px] text-wait">·{observed.samples}</span>
                            </span>
                          );
                        }
                        return <span className="text-dim">{m.scores.speed}</span>;
                      })()}
                    </td>
                    <td className="py-2 pr-3 text-dim">{m.scores.reasoning}</td>
                    <td className="py-2 pr-3 text-dim">{m.scores.coding}</td>
                    <td className="py-2 pr-3">
                      {/* Honesty: say whether a value is a table lookup, a guess, or yours. */}
                      <button
                        type="button"
                        onClick={() => setEditing(editing === m.id ? null : m.id)}
                        title={
                          m.traitsSource === "catalog" ? "From NYRO's known-model table (list prices, not measured) — click to correct"
                          : m.traitsSource === "user" ? "Corrected by you; discovery will not overwrite it"
                          : "Estimated from the model name — click to correct"
                        }
                        className={`text-[10px] underline-offset-2 hover:underline ${m.traitsSource === "user" ? "text-accent" : "text-dim"}`}
                      >
                        {m.traitsSource}
                      </button>
                    </td>
                    <td className="py-2">
                      <input
                        type="checkbox"
                        checked={m.enabled}
                        onChange={(e) => void api.setModelEnabled(m.id, e.target.checked).then(refresh)}
                        className="accent-[var(--color-accent)]"
                      />
                    </td>
                  </tr>
                ))}
                {models.map((m) =>
                  editing === m.id ? (
                    <tr key={`${m.id}-edit`}>
                      <td colSpan={9} className="pb-3">
                        <ModelEditor
                          model={m}
                          onClose={() => setEditing(null)}
                          onSaved={async () => { setEditing(null); await refresh(); }}
                        />
                      </td>
                    </tr>
                  ) : null,
                )}
              </tbody>
            </table>
            <p className="prose-sans mt-3 text-[11.5px] leading-relaxed text-dim">
              The <span className="text-ink">source</span> column is a button: if a price or context window is
              wrong, correct it. Prices here are list prices and they drift — a wrong one produces wrong cost
              estimates and wrong budget enforcement. A corrected model is marked{" "}
              <span className="text-accent">user</span> and discovery will not overwrite it.
            </p>
            <p className="prose-sans mt-2 text-[11.5px] leading-relaxed text-dim">
              Reasoning and coding scores are heuristics from the model's name, not benchmarks. Speed is
              different: a <span className="text-live">green</span> figure is measured from real runs
              (median output tokens per second) and is what the router actually uses. A grey figure with
              <span className="text-wait"> ·n</span> is still the guess, with n runs recorded so far —
              NYRO waits for enough evidence before trusting a measurement over the catalog.
            </p>
          </div>
        )}
      </Panel>
    </div>
  );
}

/**
 * Correcting a model's traits.
 *
 * Only the fields whose wrongness has consequences: the costs (which drive
 * estimates and budget enforcement) and the context window (which decides
 * whether a model is eligible at all). Capability and score editing would be
 * more surface without more benefit — speed is measured now, and the rest is
 * better fixed in the catalog for everyone.
 */
function ModelEditor({
  model,
  onClose,
  onSaved,
}: {
  model: Model;
  onClose: () => void;
  onSaved: () => Promise<void>;
}) {
  const [displayName, setDisplayName] = useState(model.displayName);
  const [inputCost, setInputCost] = useState(String(model.inputCostPer1m));
  const [outputCost, setOutputCost] = useState(String(model.outputCostPer1m));
  const [contextWindow, setContextWindow] = useState(String(model.contextWindow));
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  function num(v: string): number | null {
    const n = Number.parseFloat(v.trim());
    return Number.isFinite(n) && n >= 0 ? n : null;
  }

  async function save(): Promise<void> {
    const patch: Record<string, unknown> = {};
    if (displayName.trim() && displayName !== model.displayName) patch["displayName"] = displayName.trim();

    // A value NYRO cannot read is NOT the same as a field you did not touch.
    // Both used to be skipped, so typing a price wrong — or clearing the box —
    // closed the editor with nothing sent and nothing said, which looks exactly
    // like a correction that was accepted. The table then still says `catalog`
    // and the model keeps the price you thought you had just fixed.
    const unreadable: string[] = [];
    const parse = (raw: string, label: string): number | null => {
      const n = num(raw);
      if (n === null) unreadable.push(label);
      return n;
    };
    const ic = parse(inputCost, "Input $ / 1M");
    const oc = parse(outputCost, "Output $ / 1M");
    const cw = parse(contextWindow, "Context window");
    if (unreadable.length > 0) {
      setErr(
        `${unreadable.join(" and ")} ${unreadable.length > 1 ? "need" : "needs"} a number that is zero or more. ` +
          "Nothing was saved.",
      );
      return;
    }
    if (ic !== null && ic !== model.inputCostPer1m) patch["inputCostPer1m"] = ic;
    if (oc !== null && oc !== model.outputCostPer1m) patch["outputCostPer1m"] = oc;
    if (cw !== null && cw !== model.contextWindow) patch["contextWindow"] = Math.round(cw);

    if (Object.keys(patch).length === 0) { onClose(); return; }

    setBusy(true); setErr(null);
    try {
      await api.updateModel(model.id, patch as never);
      await onSaved();
    } catch (e) {
      setErr(e instanceof NyroApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  async function reset(): Promise<void> {
    setBusy(true); setErr(null);
    try {
      await api.resetModel(model.id);
      await onSaved();
    } catch (e) {
      setErr(e instanceof NyroApiError ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded border border-accent/30 bg-sunk p-3">
      {err ? <p className="mb-2 text-[11px] text-stop">{err}</p> : null}
      <div className="grid gap-3 sm:grid-cols-4">
        <Field label="Display name">
          <input className={inputClass} value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
        </Field>
        <Field label="Input $ / 1M">
          <input className={inputClass} inputMode="decimal" value={inputCost} onChange={(e) => setInputCost(e.target.value)} />
        </Field>
        <Field label="Output $ / 1M">
          <input className={inputClass} inputMode="decimal" value={outputCost} onChange={(e) => setOutputCost(e.target.value)} />
        </Field>
        <Field label="Context window">
          <input className={inputClass} inputMode="numeric" value={contextWindow} onChange={(e) => setContextWindow(e.target.value)} />
        </Field>
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Button variant="primary" onClick={() => void save()} disabled={busy}>
          {busy ? "Saving…" : "Save correction"}
        </Button>
        <Button onClick={onClose} disabled={busy}>Cancel</Button>
        {model.traitsSource === "user" ? (
          <Button onClick={() => void reset()} disabled={busy}>Reset to catalog</Button>
        ) : null}
        <span className="prose-sans text-[11px] text-dim">
          Saving marks this model as yours; discovery will stop overwriting these fields.
        </span>
      </div>
    </div>
  );
}

function AddProviderForm({
  presets, existing, onDone, onError,
}: {
  presets: Preset[];
  /** Used only to notice that this "add" is really a replace. */
  existing: Provider[];
  onDone: (msg: string) => Promise<void>;
  onError: (msg: string) => void;
}) {
  const [presetKey, setPresetKey] = useState("ollama");
  const [id, setId] = useState("ollama");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);
  const clash = existing.find((p) => p.id === id.trim()) ?? null;

  const preset = presets.find((p) => p.key === presetKey);

  useEffect(() => {
    if (!preset) return;
    setId(preset.key === "openai_compatible" ? "" : preset.key);
    setBaseUrl(preset.defaultBaseUrl);
  }, [presetKey, preset?.key]);

  async function save(): Promise<void> {
    if (!preset) return;
    setSaving(true);
    try {
      await api.saveProvider({
        id,
        displayName: preset.displayName,
        presetKey: preset.key,
        transport: preset.transport,
        baseUrl,
        apiKey: apiKey === "" ? null : apiKey,
        local: preset.local,
        enabled: true,
        requestTimeoutMs: 120000,
        extra: {},
      });
      // Discovery immediately, so the user sees models rather than an empty list.
      await api.discoverProvider(id).catch(() => undefined);
      setApiKey("");
      await onDone(`Added ${preset.displayName}. Run Discover if no models appeared.`);
    } catch (err) {
      onError(err instanceof NyroApiError ? `${err.info.code}: ${err.message}` : String(err));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="mb-4 space-y-3 rounded border border-accent/30 bg-sunk p-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="Provider">
          <select className={inputClass} value={presetKey} onChange={(e) => setPresetKey(e.target.value)}>
            {presets.map((p) => <option key={p.key} value={p.key}>{p.displayName}</option>)}
          </select>
        </Field>
        <Field label="Id" hint="Used in model ids. Lowercase letters, digits, - and _.">
          <input className={inputClass} value={id} onChange={(e) => setId(e.target.value)} placeholder="my-provider" />
        </Field>
        <Field label="Base URL">
          <input className={inputClass} value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://…" />
        </Field>
        <Field
          label={preset?.requiresApiKey ? "API key (required)" : "API key (optional)"}
          hint="Encrypted at rest. Never returned by the API, never sent to the browser again."
        >
          <input className={inputClass} type="password" value={apiKey} onChange={(e) => setApiKey(e.target.value)} autoComplete="off" />
        </Field>
      </div>
      {preset?.notes ? <p className="text-[11px] text-dim">{preset.notes}</p> : null}
      {preset?.apiKeyUrl ? (
        <p className="text-[11px] text-dim">
          Get a key: <a className="text-accent underline" href={preset.apiKeyUrl} target="_blank" rel="noreferrer">{preset.apiKeyUrl}</a>
        </p>
      ) : null}
      {/* Choosing a preset prefills the id with the preset's own name, so the
          most likely way to reach this form is already holding an id that
          exists — and PUT /api/providers/:id is an upsert. A button labelled
          "add" that silently rewrites a provider you already configured, key
          and all, is the kind of thing you only discover afterwards. */}
      {clash ? (
        <p className="prose-sans text-[11.5px] leading-relaxed text-wait">
          A provider called <span className="text-ink">{clash.id}</span> already exists ({clash.baseUrl || "no base URL"}).
          Saving replaces its settings{clash.hasApiKey ? ", and its stored API key unless you enter a new one" : ""}. Give
          this one a different id to add it alongside.
        </p>
      ) : null}

      <Button variant="primary" onClick={() => void save()} disabled={saving || id.trim() === ""}>
        {saving ? "Saving…" : clash ? `Replace ${clash.id}` : "Save and discover"}
      </Button>
    </div>
  );
}
