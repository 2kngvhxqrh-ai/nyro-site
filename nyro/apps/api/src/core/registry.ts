/**
 * Provider + model registry (spec §7, §106, §107).
 *
 * Owns two things Core needs and nothing else should do:
 *  - turning stored provider rows into live adapter instances (cached)
 *  - discovery: asking each provider what models it has, and recording health
 *
 * Adapters are cached by a config fingerprint so an edited base URL or rotated
 * key takes effect immediately without a restart.
 */
import { createHash } from "node:crypto";
import { createProvider, type ModelProvider } from "../providers/index.ts";
import { isTransportCapability } from "../providers/provider.ts";
import type { ProviderConfig } from "../providers/provider.ts";
import { traitsFor } from "../providers/model-traits.ts";
import type { ModelRepo, ProviderRepo, PublicProvider } from "../db/repos.ts";
import type { HealthState, RegisteredModel } from "./types.ts";
import { NyroError } from "./errors.ts";
import { logger } from "../util/logger.ts";
import type { EventBus } from "./events.ts";

const log = logger("registry");

function fingerprint(cfg: ProviderConfig): string {
  return createHash("sha256")
    .update(
      // Includes the key so a rotation invalidates the cached adapter, but the
      // value is hashed, never stored or logged.
      JSON.stringify([cfg.transport, cfg.baseUrl, cfg.apiKey ?? "", cfg.requestTimeoutMs, cfg.extra]),
    )
    .digest("hex");
}

export interface DiscoveryReport {
  providerId: string;
  ok: boolean;
  modelsFound: number;
  modelsPruned: number;
  health: HealthState;
  detail: string;
}

export class Registry {
  private readonly providers: ProviderRepo;
  private readonly models: ModelRepo;
  private readonly bus: EventBus;
  private cache = new Map<string, { fp: string; provider: ModelProvider }>();

  constructor(providers: ProviderRepo, models: ModelRepo, bus: EventBus) {
    this.providers = providers;
    this.models = models;
    this.bus = bus;
  }

  /** Live adapter for a provider id, built from current DB config. */
  async adapterFor(providerId: string): Promise<ModelProvider> {
    const cfg = await this.providers.getConfig(providerId);
    if (!cfg) {
      throw new NyroError("config_error", `Provider "${providerId}" is not configured.`, { component: "registry" });
    }
    const fp = fingerprint(cfg);
    const cached = this.cache.get(providerId);
    if (cached && cached.fp === fp) return cached.provider;

    const provider = createProvider(cfg);
    this.cache.set(providerId, { fp, provider });
    return provider;
  }

  invalidate(providerId: string): void {
    this.cache.delete(providerId);
  }

  /** All models the router may consider. */
  async routableModels(): Promise<RegisteredModel[]> {
    return this.models.list({ enabledOnly: true });
  }

  /**
   * Ask one provider what it has, write the results into the registry, and
   * record health. Never throws for an unreachable provider — an offline
   * Ollama is an expected state, not an error (spec §110, §184).
   */
  async discoverProvider(providerId: string, signal?: AbortSignal): Promise<DiscoveryReport> {
    let adapter: ModelProvider;
    try {
      adapter = await this.adapterFor(providerId);
    } catch (err) {
      const e = NyroError.from(err, "registry");
      await this.providers.recordHealth(providerId, "unknown", e.message, null);
      return { providerId, ok: false, modelsFound: 0, modelsPruned: 0, health: "unknown", detail: e.message };
    }

    const health = await adapter.healthCheck(signal);
    await this.providers.recordHealth(providerId, health.state, health.detail, health.latencyMs);
    this.bus.emit({ type: "provider.health", providerId, state: health.state });

    if (health.state === "unreachable") {
      return { providerId, ok: false, modelsFound: 0, modelsPruned: 0, health: health.state, detail: health.detail };
    }

    let found: Awaited<ReturnType<ModelProvider["listModels"]>>;
    try {
      found = await adapter.listModels(signal);
    } catch (err) {
      const e = NyroError.from(err, "registry");
      log.warn("model discovery failed", { providerId, code: e.code });
      return { providerId, ok: false, modelsFound: 0, modelsPruned: 0, health: health.state, detail: e.message };
    }

    for (const info of found) {
      const traits = traitsFor(info.modelIdentifier, adapter.local, info.contextWindow);
      await this.models.upsertDiscovered({
        id: `${providerId}:${info.modelIdentifier}`,
        providerId,
        modelIdentifier: info.modelIdentifier,
        displayName: info.displayName ?? traits.displayName,
        contextWindow: traits.contextWindow,
        maxOutputTokens: traits.maxOutputTokens,
        inputCostPer1m: traits.inputCostPer1m,
        outputCostPer1m: traits.outputCostPer1m,
        // Gate ONLY transport-determined capabilities. A model's reasoning or
        // coding ability is a property of the model and survives regardless of
        // which adapter carries it.
        capabilities: traits.capabilities.filter((c) => !isTransportCapability(c) || adapter.supports(c)),
        scores: traits.scores,
        local: adapter.local,
        traitsSource: traits.source,
      });
    }

    const pruned = await this.models.pruneMissing(providerId, found.map((f) => f.modelIdentifier));
    log.info("discovery complete", { providerId, found: found.length, pruned });

    return {
      providerId,
      ok: true,
      modelsFound: found.length,
      modelsPruned: pruned,
      health: health.state,
      detail: health.detail,
    };
  }

  /** Discovery across every enabled provider, in parallel (spec §126). */
  async discoverAll(signal?: AbortSignal): Promise<DiscoveryReport[]> {
    const all: PublicProvider[] = await this.providers.listPublic();
    const enabled = all.filter((p) => p.enabled);
    return Promise.all(enabled.map((p) => this.discoverProvider(p.id, signal)));
  }
}
