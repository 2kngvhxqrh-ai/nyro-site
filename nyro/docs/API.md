# NYRO API

Base URL `http://127.0.0.1:8787`. JSON in, JSON out, except `/api/chat/stream`
which returns `text/event-stream`.

No authentication yet — see [SECURITY.md](SECURITY.md). Bind to `127.0.0.1`
(the default) and do not expose this port.

When `NYRO_STATIC_DIR` is set (as `pnpm start` does), any non-`/api` GET is
served from the built web app instead, with an SPA fallback for extensionless
paths. An unmatched `/api` path is always a JSON 404 and is never served from
disk.

## Errors

Every failure returns the same shape and an appropriate status code:

```json
{
  "error": {
    "code": "provider_unreachable",
    "message": "Could not reach provider at http://localhost:11434.",
    "component": "provider:ollama",
    "retryable": true,
    "timestamp": "2026-01-01T00:00:00.000Z"
  }
}
```

Codes: `bad_request`, `model_not_found`, `no_eligible_model`, `privacy_violation`,
`cost_limit_exceeded`, `context_too_large`, `provider_unreachable`,
`provider_auth`, `provider_rate_limited`, `provider_timeout`,
`provider_bad_response`, `cancelled`, `config_error`, `db_error`, `internal`.

Raw upstream bodies are logged server-side but never returned — they can contain
credentials.

## Health

### `GET /api/health`
`?probe=true` actively contacts every provider. Without it, cached health is
returned, so dashboard polling cannot hammer providers. Returns 503 when the
database is unreachable.

## Providers

### `GET /api/providers`
Never includes key material. `hasApiKey` and a last-4 `apiKeyHint` only.

### `GET /api/providers/presets`
The connectable provider list with default base URLs.

### `PUT /api/providers/:id`
Create or update. Omit `apiKey` to keep the stored key, `null` to clear it, a
string to replace it.

```json
{
  "id": "openai",
  "displayName": "OpenAI",
  "presetKey": "openai",
  "transport": "openai_compatible",
  "baseUrl": "https://api.openai.com/v1",
  "apiKey": "sk-…",
  "local": false,
  "enabled": true,
  "requestTimeoutMs": 120000
}
```

### `DELETE /api/providers/:id`
Also removes that provider's models.

### `POST /api/providers/:id/test`
Probes the provider and records health.

### `POST /api/providers/:id/discover` · `POST /api/providers/discover`
Refreshes the model registry. Never overwrites a model you have hand-edited,
and removes models the provider no longer reports.

## Models

### `GET /api/models`
`?enabledOnly=true` to filter. `traitsSource` is `catalog`, `heuristic` or
`user` — so a guessed score is never mistaken for a measured one.

### `PUT /api/models/:id`
`{ "enabled": boolean }`

## Routing

### `POST /api/route/preview`
Same body as `/api/chat`. Returns the model that *would* be used, the fallback
chain, and every rejected model with the rule that rejected it — without
spending a token.

## Chat

Body for both chat endpoints:

```json
{
  "message": "required",
  "conversationId": null,
  "mode": "auto",
  "privacy": "normal",
  "modelId": null,
  "providerId": null,
  "systemPrompt": null,
  "temperature": null,
  "maxCostUsd": null,
  "requiredCapabilities": []
}
```

`mode`: `auto` · `cheapest` · `fastest` · `best` · `local_only` · `cloud_only` · `manual`
`privacy`: `normal` · `sensitive` · `local_only` · `public`

`sensitive` and `local_only` exclude every cloud model, including from the
fallback chain. If no local model can serve the request it fails — it never
escalates.

`requiredCapabilities` are hard requirements. NYRO's own inferred capabilities
are preferences and never cause a refusal.

### `POST /api/chat`
Blocks until complete. Returns content, the model used, usage, cost, the
routing decision and every attempt made.

### `POST /api/chat/stream`
SSE. Closing the connection cancels the upstream model call.

| Event | Data |
|---|---|
| `routing` | chosen model, fallbacks, rejected models with reasons |
| `attempt` | `{modelId, attemptIndex, isFallback}` — emitted per attempt |
| `delta` | `{text}` |
| `usage` | `{inputTokens, outputTokens, costUsd}` |
| `done` | `{conversationId, modelId, latencyMs}` |
| `error` | the error object above |

Because headers are already sent, a mid-stream failure arrives as an `error`
event, not an HTTP status.

## Conversations

- `GET /api/conversations`
- `POST /api/conversations` — `{ "title": "…" }`
- `GET /api/conversations/:id/messages`

## Stats

### `GET /api/stats`
`?hours=24`. Totals plus per-model runs, failures, cancellations, average
latency and cost. Cancellations are counted separately from failures and are
excluded from the latency average.
