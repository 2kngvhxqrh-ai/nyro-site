/**
 * System health (spec §107, §177).
 *
 * Aggregates component checks into one report. Every component reports its own
 * state; nothing is assumed healthy because something else is.
 */
import type { Pool } from "../db/pool.ts";
import { pingDb } from "../db/pool.ts";
import type { ProviderRepo } from "../db/repos.ts";
import type { Registry } from "./registry.ts";
import type { HealthState } from "./types.ts";

export interface ComponentHealth {
  name: string;
  state: HealthState;
  detail: string;
  latencyMs: number | null;
}

export interface HealthReport {
  state: HealthState;
  checkedAt: string;
  components: ComponentHealth[];
}

function worst(states: HealthState[]): HealthState {
  if (states.includes("unreachable")) return "unreachable";
  if (states.includes("degraded")) return "degraded";
  if (states.every((s) => s === "healthy")) return "healthy";
  return "unknown";
}

export async function systemHealth(opts: {
  pool: Pool;
  providers: ProviderRepo;
  registry: Registry;
  /** When true, actively re-probe providers instead of reading cached health. */
  probe: boolean;
  signal?: AbortSignal;
}): Promise<HealthReport> {
  const components: ComponentHealth[] = [{ name: "nyro-core", state: "healthy", detail: "running", latencyMs: null }];

  const db = await pingDb(opts.pool);
  components.push(
    db.ok
      ? { name: "database", state: "healthy", detail: "postgres reachable", latencyMs: db.latencyMs }
      : { name: "database", state: "unreachable", detail: db.detail, latencyMs: null },
  );

  // Without the DB there is nothing to say about providers.
  if (!db.ok) {
    return { state: "unreachable", checkedAt: new Date().toISOString(), components };
  }

  const providerRows = await opts.providers.listPublic();
  if (providerRows.length === 0) {
    components.push({
      name: "providers",
      state: "unknown",
      detail: "no providers configured yet",
      latencyMs: null,
    });
  }

  for (const p of providerRows) {
    if (!p.enabled) {
      components.push({ name: `provider:${p.id}`, state: "unknown", detail: "disabled", latencyMs: null });
      continue;
    }
    if (!opts.probe) {
      components.push({
        name: `provider:${p.id}`,
        state: p.health.state,
        detail: p.health.checkedAt ? `${p.health.detail} (cached ${p.health.checkedAt})` : "never checked",
        latencyMs: p.health.latencyMs,
      });
      continue;
    }
    const adapter = await opts.registry.adapterFor(p.id);
    const h = await adapter.healthCheck(opts.signal);
    await opts.providers.recordHealth(p.id, h.state, h.detail, h.latencyMs);
    components.push({ name: `provider:${p.id}`, state: h.state, detail: h.detail, latencyMs: h.latencyMs });
  }

  // Core + DB decide the overall state; a single offline provider degrades but
  // does not take the system down (spec §184).
  const critical = components.filter((c) => c.name === "nyro-core" || c.name === "database").map((c) => c.state);
  const providerStates = components.filter((c) => c.name.startsWith("provider:")).map((c) => c.state);
  const anyProviderHealthy = providerStates.includes("healthy");

  let state = worst(critical);
  if (state === "healthy" && providerStates.length > 0 && !anyProviderHealthy) state = "degraded";

  return { state, checkedAt: new Date().toISOString(), components };
}
