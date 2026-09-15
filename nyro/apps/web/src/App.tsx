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
import { Settings } from "./components/Settings.tsx";
import { ErrorBoundary } from "./components/ErrorBoundary.tsx";
import { Dot } from "./components/ui.tsx";
import { DemoBanner } from "./components/DemoBanner.tsx";
import type { Turn } from "./components/Chat.tsx";
import { DEMO_MODE } from "./demo-mode.ts";

type View = "chat" | "models" | "health" | "settings";

const VIEWS: Array<{ key: View; label: string }> = [
  { key: "chat", label: "Chat" },
  { key: "models", label: "Models" },
  { key: "health", label: "Health" },
  { key: "settings", label: "Settings" },
];

export function App() {
  const [view, setView] = useState<View>("chat");
  const [providers, setProviders] = useState<Provider[]>([]);
  const [models, setModels] = useState<Model[]>([]);
  const [health, setHealth] = useState<HealthReport | null>(null);
  const [stats, setStats] = useState<Awaited<ReturnType<typeof api.stats>> | null>(null);
  const [offline, setOffline] = useState(false);
  const [seedTurns, setSeedTurns] = useState<Turn[]>([]);

  useEffect(() => {
    if (!DEMO_MODE) return;
    // Loaded lazily so the demo seed never ships in the real app's bundle.
    void import("./demo/seed-conversation.ts").then((m) => setSeedTurns(m.seedConversation()));
  }, []);

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
      <header className="mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line pb-3">
        <span className="text-lg font-semibold tracking-tight text-ink">NYRO</span>
        <span className="whitespace-nowrap rounded border border-line px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-dim">
          Phase 1
        </span>
        {DEMO_MODE ? (
          <span className="rounded border border-wait/50 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-wait">
            Demo
          </span>
        ) : null}

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

        <span className="order-last flex w-full items-center gap-2 text-[11px] text-dim sm:order-none sm:ml-auto sm:w-auto">
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

      {/* Outside the scroll container: a page that simulates replies must say
          so at all times, not only until the reader scrolls past it. Capped
          on small screens so it cannot swallow the whole viewport — it
          scrolls within itself instead of pushing the app off the page. */}
      {DEMO_MODE ? (
        <div className="mb-4 max-h-[40vh] shrink-0 overflow-y-auto sm:max-h-none sm:overflow-visible">
          <DemoBanner />
        </div>
      ) : null}

      {/* overflow-x-hidden is explicit: `overflow-y:auto` alone computes
          overflow-x to `auto`, so a few stray pixels — the vertical
          scrollbar's own width, mostly — let the whole content area be nudged
          sideways. Anything legitimately wider than the screen (the Models and
          Health tables) carries its own horizontal scroller, so nothing here
          needs the page to scroll. */}
      <main className="min-h-0 flex-1 overflow-y-auto overflow-x-hidden">
        {/* A render error used to unmount everything — no message, no nav,
            just a blank page. It is now contained to the view that threw. */}
        <ErrorBoundary resetKey={view}>
        {view === "chat" ? (
          <Chat
            models={models}
            onActivity={() => void refreshHealth(false)}
            initialTurns={seedTurns}
            showHistory={!DEMO_MODE}
          />
        ) : view === "models" ? (
          <Models providers={providers} models={models} refresh={refreshRegistry} />
        ) : view === "settings" ? (
          <Settings providers={providers} models={models} />
        ) : (
          <Health health={health} stats={stats} refresh={refreshHealth} />
        )}
        </ErrorBoundary>
      </main>
    </div>
  );
}
