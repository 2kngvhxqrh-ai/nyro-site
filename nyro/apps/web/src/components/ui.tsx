import type { ReactNode } from "react";
import type { HealthState } from "../api.ts";

export function Dot({ state }: { state: HealthState }) {
  const color =
    state === "healthy" ? "bg-live"
    : state === "degraded" ? "bg-wait"
    : state === "unreachable" ? "bg-stop"
    : "bg-dim";
  return <span className={`inline-block h-2 w-2 rounded-full ${color}`} aria-label={state} />;
}

export function Panel({ title, children, actions }: { title: string; children: ReactNode; actions?: ReactNode }) {
  return (
    <section className="rounded border border-line bg-panel">
      <header className="flex items-center justify-between border-b border-line px-4 py-2.5">
        <h2 className="text-[11px] font-semibold uppercase tracking-[0.18em] text-dim">{title}</h2>
        {actions}
      </header>
      <div className="p-4">{children}</div>
    </section>
  );
}

export function Button({
  children, onClick, disabled, variant = "default", type = "button",
}: {
  children: ReactNode; onClick?: () => void; disabled?: boolean;
  variant?: "default" | "primary" | "danger"; type?: "button" | "submit";
}) {
  const base = "rounded border px-3 py-1.5 text-xs transition disabled:opacity-40 disabled:cursor-not-allowed";
  const styles =
    variant === "primary" ? "border-accent bg-accent/15 text-accent hover:bg-accent/25"
    : variant === "danger" ? "border-stop/60 text-stop hover:bg-stop/10"
    : "border-line text-body hover:border-dim hover:text-ink";
  return (
    <button type={type} onClick={onClick} disabled={disabled} className={`${base} ${styles}`}>
      {children}
    </button>
  );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="block">
      <span className="mb-1 block text-[11px] uppercase tracking-wider text-dim">{label}</span>
      {children}
      {hint ? <span className="mt-1 block text-[11px] text-dim">{hint}</span> : null}
    </label>
  );
}

export const inputClass =
  "w-full rounded border border-line bg-sunk px-2.5 py-1.5 text-xs text-ink outline-none focus:border-accent";

export function Badge({ children, tone = "dim" }: { children: ReactNode; tone?: "dim" | "live" | "accent" | "stop" }) {
  const styles =
    tone === "live" ? "border-live/40 text-live"
    : tone === "accent" ? "border-accent/40 text-accent"
    : tone === "stop" ? "border-stop/40 text-stop"
    : "border-line text-dim";
  return <span className={`rounded border px-1.5 py-0.5 text-[10px] uppercase tracking-wider ${styles}`}>{children}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <p className="py-6 text-center text-xs text-dim">{children}</p>;
}

export function formatCost(usd: number): string {
  if (usd === 0) return "free";
  if (usd < 0.01) return `$${usd.toFixed(5)}`;
  return `$${usd.toFixed(3)}`;
}
