/**
 * Provider presets (spec §5, §54).
 *
 * A preset is *configuration*, not code. Adding "Together AI" or a self-hosted
 * vLLM box is a new entry here — or, at runtime, a `custom` provider the user
 * configures in the UI with a base URL. Neither requires touching core/.
 */
import type { ProviderTransport } from "./provider.ts";

export interface ProviderPreset {
  key: string;
  displayName: string;
  transport: ProviderTransport;
  defaultBaseUrl: string;
  /** Whether an API key must be supplied before the provider can be enabled. */
  requiresApiKey: boolean;
  local: boolean;
  /** Where the user gets a key. Shown in the UI; never a credential itself. */
  apiKeyUrl: string | null;
  notes: string;
}

export const PROVIDER_PRESETS: ProviderPreset[] = [
  {
    key: "ollama",
    displayName: "Ollama",
    transport: "ollama",
    defaultBaseUrl: "http://host.docker.internal:11434",
    requiresApiKey: false,
    local: true,
    apiKeyUrl: null,
    notes: "Local inference. Uses Ollama's native /api endpoints.",
  },
  {
    key: "openai",
    displayName: "OpenAI",
    transport: "openai_compatible",
    defaultBaseUrl: "https://api.openai.com/v1",
    requiresApiKey: true,
    local: false,
    apiKeyUrl: "https://platform.openai.com/api-keys",
    notes: "",
  },
  {
    key: "anthropic",
    displayName: "Anthropic",
    transport: "anthropic",
    defaultBaseUrl: "https://api.anthropic.com/v1",
    requiresApiKey: true,
    local: false,
    apiKeyUrl: "https://console.anthropic.com/settings/keys",
    notes: "Native /v1/messages API.",
  },
  {
    key: "google",
    displayName: "Google Gemini",
    transport: "openai_compatible",
    defaultBaseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    requiresApiKey: true,
    local: false,
    apiKeyUrl: "https://aistudio.google.com/apikey",
    notes: "Via Google's OpenAI-compatible endpoint. A native Gemini adapter is planned for Phase 2.",
  },
  {
    key: "groq",
    displayName: "Groq",
    transport: "openai_compatible",
    defaultBaseUrl: "https://api.groq.com/openai/v1",
    requiresApiKey: true,
    local: false,
    apiKeyUrl: "https://console.groq.com/keys",
    notes: "",
  },
  {
    key: "mistral",
    displayName: "Mistral",
    transport: "openai_compatible",
    defaultBaseUrl: "https://api.mistral.ai/v1",
    requiresApiKey: true,
    local: false,
    apiKeyUrl: "https://console.mistral.ai/api-keys",
    notes: "",
  },
  {
    key: "openrouter",
    displayName: "OpenRouter",
    transport: "openai_compatible",
    defaultBaseUrl: "https://openrouter.ai/api/v1",
    requiresApiKey: true,
    local: false,
    apiKeyUrl: "https://openrouter.ai/keys",
    notes: "Aggregator: exposes many upstream models under one key.",
  },
  {
    key: "xai",
    displayName: "xAI",
    transport: "openai_compatible",
    defaultBaseUrl: "https://api.x.ai/v1",
    requiresApiKey: true,
    local: false,
    apiKeyUrl: "https://console.x.ai",
    notes: "",
  },
  {
    key: "openai_compatible",
    displayName: "Custom (OpenAI-compatible)",
    transport: "openai_compatible",
    defaultBaseUrl: "",
    requiresApiKey: false,
    local: false,
    apiKeyUrl: null,
    notes: "Any server speaking the OpenAI /v1 protocol: vLLM, LM Studio, llama.cpp, a proxy, a colleague's box.",
  },
  {
    key: "mock",
    displayName: "Mock (not a real model)",
    transport: "mock",
    defaultBaseUrl: "",
    requiresApiKey: false,
    local: true,
    apiKeyUrl: null,
    notes: "In-process fake used for tests and first-run verification. Never produces real answers.",
  },
];

export function findPreset(key: string): ProviderPreset | undefined {
  return PROVIDER_PRESETS.find((p) => p.key === key);
}
