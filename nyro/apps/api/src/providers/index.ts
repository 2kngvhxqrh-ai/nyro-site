/**
 * The one place that maps a transport to an adapter class.
 *
 * This is the full extent of the wiring a new provider needs (spec §152):
 * a preset entry, an adapter class, one case here, and tests.
 */
import { NyroError } from "../core/errors.ts";
import { AnthropicProvider } from "./anthropic.ts";
import { MockProvider } from "./mock.ts";
import { OllamaProvider } from "./ollama.ts";
import { OpenAICompatibleProvider } from "./openai-compatible.ts";
import type { ModelProvider, ProviderConfig, ProviderTransport } from "./provider.ts";

export type ProviderFactory = (cfg: ProviderConfig) => ModelProvider;

const FACTORIES: Record<ProviderTransport, ProviderFactory> = {
  ollama: (cfg) => new OllamaProvider(cfg),
  openai_compatible: (cfg) => new OpenAICompatibleProvider(cfg),
  anthropic: (cfg) => new AnthropicProvider(cfg),
  mock: (cfg) => new MockProvider(cfg),
};

export function createProvider(cfg: ProviderConfig): ModelProvider {
  const factory = FACTORIES[cfg.transport];
  if (!factory) {
    throw new NyroError("config_error", `Unknown provider transport "${cfg.transport}".`, { component: "providers" });
  }
  return factory(cfg);
}

export const SUPPORTED_TRANSPORTS = Object.keys(FACTORIES) as ProviderTransport[];

export { AnthropicProvider, MockProvider, OllamaProvider, OpenAICompatibleProvider };
export type { ModelProvider, ProviderConfig, ProviderTransport };
