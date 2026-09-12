/**
 * NYRO shell.
 *
 * Phase 1 ships three views. The navigation deliberately does NOT list Tasks,
 * Agents, Tools, Memory, Projects or Automations — those arrive with the phases
 * that implement them. Showing dead nav items would be exactly the fake
 * completeness spec §175/§176 rules out.
 */
import { useCallback, useEffect, useState } from "react";
import { api, type HealthReport, type Model, type Provider } from "./api.ts";
import { Chat } from "./components/Chat.tsx";
import { Models } from "./components/Models.tsx";
import { Health } from "./components/Health.tsx";
import { Dot } from "./components/ui.tsx";

type View = "chat" | "models" | "health";

const VIEWS: Array<{ key: View; label: string }> = [
  { key: "chat", label: "Chat" },
  { key: "models", label: "Models" },
  { key: "health", label: "Health" },
];

export function App() {
  const [view, setView] = useState<View>("chat");
  const [providers, setProviders] = useState<Provider[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [stats, setStats] = useState<Awaited<ReturnType<typeof api.stats>> | null>(null);
  const [offline, setOffline] = useState(false);

  const refreshRegistry = useCallback(async () => {
    try {
      const [p, m] = await Promise.all([api.providers(), api.models()]);
      setProviders(p);
      setModels(m);
      setOffline(false);
    } catch {
      setOffline(true);
    }
  }, []);

  const refreshHealth = useCallback(async (probe = false) => {
    try {
      const [h, s] = await Promise.all([api.health(probe), api.stats()]);
      setHealth(h);
      setStats(s);
      setOffline(false);
    } catch {
      setOffline(true);
    }
  }, []);

  useEffect(() => {
    void refreshRegistry();
    void refreshHealth(false);
    // Cached health only — polling must never trigger live provider probes.
    const t = setInterval(() => void refreshHealth(false), 20_000);
    return () => clearInterval(t);
  }, [refreshRegistry, refreshHealth]);

  return (
    <div className="mx-auto flex h-full max-w-6xl flex-col px-4 py-4">
      <header className="mb-4 flex items-center gap-4 border-b border-line pb-3">
        <span className="text-lg font-semibold tracking-tight text-ink">NYRO</span>
        <span className="rounded border border-line px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-dim">
          Phase 1
        </span>

        <nav className="flex gap-1">
          {VIEWS.map((v) => (
            <button
              key={v.key}
              onClick={() => setView(v.key)}
              className={`rounded px-2.5 py-1 text-xs transition ${
                view === v.key ? "bg-accent/15 text-accent" : "text-dim hover:text-ink"
              }`}
            >
              {v.label}
            </button>
          ))}
        </nav>

        <span className="ml-auto flex items-center gap-2 text-[11px] text-dim">
          {offline ? (
            <>
              <Dot state="unreachable" /> API unreachable
            </>
          ) : (
            <>
              <Dot state={health?.state ?? "unknown"} />
              {models.filter((m) => m.enabled).length} model
              {models.filter((m) => m.enabled).length === 1 ? "" : "s"} ·{" "}
              {providers.filter((p) => p.enabled).length} provider
              {providers.filter((p) => p.enabled).length === 1 ? "" : "s"}
            </>
          )}
        </span>
      </header>

      <main className="min-h-0 flex-1 overflow-y-auto">
        {view === "chat" ? (
          <Chat models={models} onActivity={() => void refreshHealth(false)} />
        ) : view === "models" ? (
          <Models providers={providers} models={models} refresh={refreshRegistry} />
        ) : (
          <Health health={health} stats={stats} refresh={refreshHealth} />
        )}
      </main>
    </div>
  );
}
