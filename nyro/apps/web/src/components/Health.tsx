/**
 * System health and run statistics (spec §62, §66, §71, §107).
 * Everything shown here is measured, not asserted.
 */
import { useState } from "react";
import { api, type HealthReport } from "../api.ts";
import { Button, Dot, Empty, formatCost, Panel } from "./ui.tsx";

export function Health({
  health, stats, refresh,
}: {
  health: HealthReport | null;
  stats: Awaited<ReturnType<typeof api.stats>> | null;
  refresh: (probe: boolean) => Promise<void>;
}) {
  const [probing, setProbing] = useState(false);

  return (
    <div className="space-y-4">
      <Panel
        title="System health"
        actions={
          <Button
            onClick={async () => { setProbing(true); await refresh(true); setProbing(false); }}
            disabled={probing}
          >
            {probing ? "Probing…" : "Probe providers now"}
          </Button>
        }
      >
        {!health ? (
          <Empty>Waiting for the API…</Empty>
        ) : (
          <>
            <div className="mb-3 flex items-center gap-2">
              <Dot state={health.state} />
              <span className="text-sm text-ink">{health.state}</span>
              <span className="text-[11px] text-dim">checked {new Date(health.checkedAt).toLocaleTimeString()}</span>
            </div>
            <ul className="space-y-1.5">
              {health.components.map((c) => (
                <li key={c.name} className="flex items-center gap-2 border-b border-line/50 pb-1.5 text-xs">
                  <Dot state={c.state} />
                  <span className="text-ink">{c.name}</span>
                  <span className="text-dim">{c.detail}</span>
                  {c.latencyMs !== null ? <span className="ml-auto text-[11px] text-dim">{c.latencyMs} ms</span> : null}
                </li>
              ))}
            </ul>
            <p className="mt-3 text-[11px] text-dim">
              A provider being unreachable degrades NYRO but does not stop it — other providers keep working.
            </p>
          </>
        )}
      </Panel>

      <Panel title="Runs (last 24h)">
        {!stats || stats.totalRuns === 0 ? (
          <Empty>No model runs recorded yet.</Empty>
        ) : (
          <>
            <div className="mb-3 grid grid-cols-2 gap-3 sm:grid-cols-5">
              <Stat label="Runs" value={String(stats.totalRuns)} />
              <Stat label="Failures" value={String(stats.failedRuns)} />
              <Stat label="Cancelled" value={String(stats.cancelledRuns)} />
              <Stat label="Avg latency" value={`${stats.avgLatencyMs} ms`} />
              <Stat label="Cost" value={formatCost(stats.totalCostUsd)} />
            </div>
            <table className="w-full text-left text-xs">
              <thead className="text-[10px] uppercase tracking-wider text-dim">
                <tr className="border-b border-line">
                  <th className="py-2 pr-3">Model</th>
                  <th className="py-2 pr-3">Runs</th>
                  <th className="py-2 pr-3">Failures</th>
                  <th className="py-2 pr-3">Cancelled</th>
                  <th className="py-2 pr-3">Avg latency</th>
                  <th className="py-2">Cost</th>
                </tr>
              </thead>
              <tbody>
                {stats.perModel.map((m) => (
                  <tr key={m.modelId} className="border-b border-line/50">
                    <td className="py-2 pr-3 text-ink">{m.modelId}</td>
                    <td className="py-2 pr-3 text-dim">{m.runs}</td>
                    <td className={`py-2 pr-3 ${m.failures > 0 ? "text-stop" : "text-dim"}`}>{m.failures}</td>
                    <td className="py-2 pr-3 text-dim">{m.cancelled}</td>
                    <td className="py-2 pr-3 text-dim">{m.avgLatencyMs} ms</td>
                    <td className="py-2 text-dim">{formatCost(m.costUsd)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="mt-3 text-[11px] text-dim">
              Costs use the price table in the model registry, and token counts come from each provider's own
              response. Providers that report no usage contribute 0 rather than an estimate. Stopping a
              response is counted as cancelled, not as a model failure, and cancelled runs are excluded
              from the latency average.
            </p>
          </>
        )}
      </Panel>
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded border border-line bg-sunk px-3 py-2">
      <div className="text-[10px] uppercase tracking-wider text-dim">{label}</div>
      <div className="text-sm text-ink">{value}</div>
    </div>
  );
}
