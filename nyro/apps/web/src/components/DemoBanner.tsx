/**
 * Demo-mode banner.
 *
 * Non-dismissible on purpose. A page that behaves like NYRO but invents model
 * replies must say so permanently, not behind a tooltip the reader can close
 * and forget (spec §131, §176).
 */
export function DemoBanner() {
  return (
    <div className="rounded border border-wait/40 bg-wait/5 px-4 py-3">
      <div className="flex flex-wrap items-center gap-2">
        <span className="rounded border border-wait/50 px-1.5 py-0.5 text-[10px] uppercase tracking-wider text-wait">
          Demo
        </span>
        <span className="prose-sans text-xs text-ink">No model is being called. Replies on this page are simulated.</span>
      </div>
      <div className="prose-sans mt-2 grid gap-2 text-[11.5px] leading-relaxed text-dim sm:grid-cols-2">
        <p>
          <span className="text-live">Real:</span> the model router, privacy enforcement, the fallback chain,
          cost estimates, token estimates and model traits — bundled from the same source files that run on
          the server.
        </p>
        <p>
          <span className="text-wait">Simulated:</span> the reply text (no inference happens), the model
          registry (a browser cannot reach a provider), and storage (memory only — a refresh clears it).
        </p>
      </div>
      <p className="prose-sans mt-2 text-[11.5px] leading-relaxed text-dim">
        Things worth trying: switch <span className="text-ink">Privacy</span> to{" "}
        <span className="text-ink">local_only</span> and watch every cloud model get excluded — even if you
        pin one. Switch <span className="text-ink">Routing mode</span> between{" "}
        <span className="text-ink">cheapest</span>, <span className="text-ink">fastest</span> and{" "}
        <span className="text-ink">best</span>. Send <code className="text-accent">/fail</code> in a message
        to make the chosen model fail and watch the fallback take over. Press{" "}
        <span className="text-ink">Stop</span> mid-stream.
      </p>
    </div>
  );
}
