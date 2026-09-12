/**
 * The browser's entire view of NYRO.
 *
 * ARCHITECTURAL RULE (spec §113): the frontend talks to the NYRO API and
 * nothing else. There is no Ollama URL here, no provider base URL, and no API
 * key — model selection is a server concern, and the UI only ever names models
 * by their registry id.
 */

export type HealthState = "healthy" | "degraded" | "unreachable" | "unknown";

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

export interface Provider {
  id: string;
  displayName: string;
  presetKey: string;
  transport: string;
  baseUrl: string;
  hasApiKey: boolean;
  apiKeyHint: string | null;
  local: boolean;
  enabled: boolean;
  health: { state: HealthState; detail: string; latencyMs: number | null; checkedAt: string | null };
}

export interface Preset {
  key: string;
  displayName: string;
  transport: string;
  defaultBaseUrl: string;
  requiresApiKey: boolean;
  local: boolean;
  apiKeyUrl: string | null;
  notes: string;
}

export interface Model {
  id: string;
  providerId: string;
  modelIdentifier: string;
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number;
  inputCostPer1m: number;
  outputCostPer1m: number;
  capabilities: string[];
  scores: { speed: number; reasoning: number; coding: number; vision: number; tool_calling: number };
  local: boolean;
  enabled: boolean;
  health: HealthState;
  /** 'catalog' | 'heuristic' | 'user' — shown so estimates are not mistaken for measurements. */
  traitsSource: string;
}

export interface RoutingChoice {
  modelId: string;
  displayName: string;
  providerId: string;
  local: boolean;
  estimatedCostUsd: number;
  reasons: string[];
}

export interface Decision {
  mode: string;
  chosen: RoutingChoice | null;
  fallbacks: Array<{ modelId: string; displayName: string; providerId: string; local: boolean }>;
  rejected: Array<{ modelId: string; reason: string }>;
}

export interface ApiError {
  code: string;
  message: string;
  component: string;
  retryable: boolean;
  timestamp: string;
}

export class NyroApiError extends Error {
  readonly info: ApiError;
  constructor(info: ApiError) {
    super(info.message);
    this.info = info;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { "content-type": "application/json", ...(init?.headers ?? {}) },
  });
  const body = await res.json().catch(() => null);
  if (!res.ok) {
    const err = (body as { error?: ApiError } | null)?.error;
    throw new NyroApiError(
      err ?? {
        code: "internal",
        message: `Request failed with HTTP ${res.status}.`,
        component: "api",
        retryable: false,
        timestamp: new Date().toISOString(),
      },
    );
  }
  return body as T;
}

export const api = {
  health: (probe = false) => request<HealthReport>(`/api/health${probe ? "?probe=true" : ""}`),
  providers: () => request<{ providers: Provider[] }>("/api/providers").then((r) => r.providers),
  presets: () => request<{ presets: Preset[] }>("/api/providers/presets").then((r) => r.presets),
  saveProvider: (p: Record<string, unknown>) =>
    request<{ provider: Provider }>(`/api/providers/${encodeURIComponent(String(p["id"]))}`, {
      method: "PUT",
      body: JSON.stringify(p),
    }),
  deleteProvider: (id: string) => request<{ deleted: boolean }>(`/api/providers/${encodeURIComponent(id)}`, { method: "DELETE" }),
  testProvider: (id: string) =>
    request<{ health: { state: HealthState; detail: string; latencyMs: number | null } }>(
      `/api/providers/${encodeURIComponent(id)}/test`, { method: "POST" },
    ),
  discoverProvider: (id: string) =>
    request<{ ok: boolean; modelsFound: number; modelsPruned: number; detail: string }>(
      `/api/providers/${encodeURIComponent(id)}/discover`, { method: "POST" },
    ),
  discoverAll: () => request<{ reports: unknown[] }>("/api/providers/discover", { method: "POST" }),
  models: () => request<{ models: Model[] }>("/api/models").then((r) => r.models),
  setModelEnabled: (id: string, enabled: boolean) =>
    request<{ model: Model }>(`/api/models/${encodeURIComponent(id)}`, {
      method: "PUT",
      body: JSON.stringify({ enabled }),
    }),
  previewRoute: (body: Record<string, unknown>) =>
    request<{ estimatedInputTokens: number; decision: Decision }>("/api/route/preview", {
      method: "POST",
      body: JSON.stringify(body),
    }),
  conversations: () =>
    request<{ conversations: Array<{ id: string; title: string; updatedAt: string; messageCount: number }> }>(
      "/api/conversations",
    ).then((r) => r.conversations),
  messages: (id: string) =>
    request<{ messages: Array<{ id: string; role: string; content: string; modelId: string | null }> }>(
      `/api/conversations/${encodeURIComponent(id)}/messages`,
    ).then((r) => r.messages),
  stats: () =>
    request<{
      totalRuns: number; failedRuns: number; cancelledRuns: number; totalCostUsd: number; avgLatencyMs: number;
      perModel: Array<{ modelId: string; runs: number; failures: number; cancelled: number; avgLatencyMs: number; costUsd: number }>;
    }>("/api/stats"),
};

// ---------------------------------------------------------------------------
// Streaming chat
// ---------------------------------------------------------------------------

export interface StreamHandlers {
  onRouting?: (d: Decision) => void;
  onAttempt?: (a: { modelId: string; attemptIndex: number; isFallback: boolean }) => void;
  onDelta?: (text: string) => void;
  onUsage?: (u: { inputTokens: number; outputTokens: number; costUsd: number }) => void;
  onDone?: (d: { conversationId: string; modelId: string; latencyMs: number }) => void;
  onError?: (e: ApiError) => void;
}

/**
 * POSTs and reads SSE off the response body.
 *
 * EventSource is not used because it cannot issue a POST, and the chat request
 * carries a body. Aborting the returned controller cancels the upstream model
 * call server-side, which is what the Stop button relies on (spec §37, §83).
 */
export function streamChat(
  body: Record<string, unknown>,
  handlers: StreamHandlers,
  signal: AbortSignal,
): Promise<void> {
  return (async () => {
    let res: Response;
    try {
      res = await fetch("/api/chat/stream", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        signal,
      });
    } catch (err) {
      if (signal.aborted) return;
      handlers.onError?.({
        code: "provider_unreachable",
        message: "Could not reach the NYRO API. Is it running?",
        component: "web",
        retryable: true,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    if (!res.ok || !res.body) {
      const err = (await res.json().catch(() => null)) as { error?: ApiError } | null;
      handlers.onError?.(
        err?.error ?? {
          code: "internal", message: `HTTP ${res.status}`, component: "web",
          retryable: false, timestamp: new Date().toISOString(),
        },
      );
      return;
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let sep: number;
        while ((sep = buffer.indexOf("\n\n")) !== -1) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);

          let type = "message";
          let data = "";
          for (const line of frame.split("\n")) {
            if (line.startsWith("event:")) type = line.slice(6).trim();
            else if (line.startsWith("data:")) data += line.slice(5).trim();
          }
          if (!data) continue; // keep-alive comment

          let parsed: unknown;
          try { parsed = JSON.parse(data); } catch { continue; }

          switch (type) {
            case "routing": handlers.onRouting?.(parsed as Decision); break;
            case "attempt": handlers.onAttempt?.(parsed as { modelId: string; attemptIndex: number; isFallback: boolean }); break;
            case "delta": handlers.onDelta?.((parsed as { text: string }).text); break;
            case "usage": handlers.onUsage?.(parsed as { inputTokens: number; outputTokens: number; costUsd: number }); break;
            case "done": handlers.onDone?.(parsed as { conversationId: string; modelId: string; latencyMs: number }); break;
            case "error": handlers.onError?.(parsed as ApiError); break;
          }
        }
      }
    } catch {
      // An aborted read is the Stop button working, not a failure.
      if (!signal.aborted) {
        handlers.onError?.({
          code: "internal", message: "The response stream ended unexpectedly.",
          component: "web", retryable: true, timestamp: new Date().toISOString(),
        });
      }
    }
  })();
}
