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
                      {/* Honesty: say whether a score is a table lookup or a guess. */}
                      <span className="text-[10px] text-dim" title={
                        m.traitsSource === "catalog" ? "From NYRO's known-model table (list prices, not measured)"
                        : m.traitsSource === "user" ? "Edited by you"
                        : "Estimated from the model name — not measured"
                      }>
                        {m.traitsSource}
                      </span>
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
              </tbody>
            </table>
            <p className="prose-sans mt-3 text-[11.5px] leading-relaxed text-dim">
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

function AddProviderForm({
  presets, onDone, onError,
}: {
  presets: Preset[]; onDone: (msg: string) => Promise<void>; onError: (msg: string) => void;
}) {
  const [presetKey, setPresetKey] = useState("ollama");
  const [id, setId] = useState("ollama");
  const [baseUrl, setBaseUrl] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [saving, setSaving] = useState(false);

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
      <Button variant="primary" onClick={() => void save()} disabled={saving || id.trim() === ""}>
        {saving ? "Saving…" : "Save and discover"}
      </Button>
    </div>
  );
}
