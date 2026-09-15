/**
 * First-run bootstrap.
 *
 * Creates provider rows from environment variables so a fresh clone with an
 * Ollama box reachable can chat immediately. Deliberately conservative:
 *  - it only ever INSERTs; it never edits a provider the user has configured
 *  - it never invents an API key
 *  - the mock provider appears only when explicitly enabled
 */
import type { ProviderRepo } from "../db/repos.ts";
import { findPreset } from "../providers/presets.ts";
import type { NyroConfig } from "../config.ts";
import { logger } from "../util/logger.ts";

const log = logger("bootstrap");

export async function bootstrapProviders(providers: ProviderRepo, cfg: NyroConfig): Promise<string[]> {
  const created: string[] = [];
  const existing = new Set((await providers.listPublic()).map((p) => p.id));

  if (cfg.ollamaBaseUrl && !existing.has("ollama")) {
    const preset = findPreset("ollama")!;
    await providers.upsert({
      id: "ollama",
      displayName: preset.displayName,
      presetKey: preset.key,
      transport: preset.transport,
      baseUrl: cfg.ollamaBaseUrl,
      apiKey: null,
      local: true,
      enabled: true,
      requestTimeoutMs: cfg.requestTimeoutMs,
    });
    created.push("ollama");
  }

  if (cfg.enableMockProvider && !existing.has("mock")) {
    const preset = findPreset("mock")!;
    await providers.upsert({
      id: "mock",
      displayName: preset.displayName,
      presetKey: preset.key,
      transport: preset.transport,
      baseUrl: "",
      apiKey: null,
      local: true,
      enabled: true,
      requestTimeoutMs: 10_000,
    });
    created.push("mock");
  }

  if (created.length > 0) log.info("bootstrapped providers", { created });
  return created;
}
