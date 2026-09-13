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
A patch; every field optional, and an omitted field is left alone.

```json
{
  "enabled": true,
  "displayName": "GPT-4o mini",
  "contextWindow": 128000,
  "maxOutputTokens": 16384,
  "inputCostPer1m": 0.15,
  "outputCostPer1m": 0.6
}
```

Supplying any **trait** marks the model `traitsSource: "user"`, after which
discovery leaves those fields alone. Toggling `enabled` does **not** — otherwise
switching a model off once would freeze its traits forever.

Correcting a price is not cosmetic: the catalog carries list prices that drift,
and a wrong one produces wrong cost estimates and wrong budget enforcement.

### `POST /api/models/:id/reset`
Discards the user's overrides and re-derives from the catalog immediately,
rather than waiting for the next discovery run.

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

### Regenerating (spec §58, §103)
Send `"regenerate": true` with a `conversationId` to re-answer the last turn.

The prompt is taken from the **stored conversation**, not from `message` — so a
regenerate cannot duplicate the question or quietly change it, and `message`
may be omitted. The trailing assistant message is deleted first; earlier turns
are untouched. Combine with `modelId` to answer the same question on a
different model.

If the previous attempt failed before an answer was stored, the conversation
already ends with the user turn and nothing is deleted.

### `POST /api/chat`
Blocks until complete. Returns content, the model used, usage, cost, the
routing decision and every attempt made.

### `POST /api/chat/stream`
SSE. Closing the connection cancels the upstream model call.

| Event | Data |
|---|---|
| `budget` | a spending limit constrained this request (emitted before `routing`) |
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
- `PUT /api/conversations/:id` — `{ "title": "…" }`, rename
- `DELETE /api/conversations/:id` — removes the conversation and its messages.
  `model_runs` rows survive (`on delete set null`), so deleting a chat never
  rewrites your spend or the performance measurements derived from it.
- `GET /api/conversations/:id/messages`

## Search (spec §63)

### `GET /api/search?q=…`
Full-text search over conversation titles and message content, using Postgres's
built-in text search — no extension, no search engine, no new dependency.

Terms are **prefix-matched**, because an incremental search box needs to be:
the English stemmer maps `router` to `router` but `routing` to `rout`, so a
plain stem query finds nothing for one when the text contains the other. All
terms must match, not any.

Each hit carries a `snippet` from `ts_headline`, with matches wrapped in `<b>`.
The UI splits on those tags and rebuilds them as elements rather than injecting
HTML, so message content can never be interpreted as markup.

An empty query returns no results rather than the whole history.

## Export (spec §108, §109)

### `GET /api/export`
Everything NYRO stores: conversations with messages, providers, models,
settings and usage totals. Sent as a download with a dated filename.

`?format=markdown` returns the conversations as prose instead — readable in any
text editor with NYRO not running, which is the constraint the project is built
around.

**Neither format contains an API key.** Providers carry `requiresApiKey` so a
restore knows a credential is needed, without carrying one.

## Measured performance (spec §13, §102)

### `GET /api/performance`
Per-model median output tokens per second, success rate, sample count, and the
speed score derived from it. `inUse` is false until a model has `minSamples`
successful runs — below that NYRO reports the measurement but keeps using the
catalog's guess.

Throughput, not latency: a longer answer legitimately takes longer, and ranking
on wall-clock would bias routing toward whichever model got short prompts.
Cancellations are excluded from both throughput and success rate.

### `PUT /api/performance`
`{ "enabled": boolean }` — turns measured routing off or on. Defaults to on.

## Routing rules (spec §10)

### `GET /api/routing-rules` · `PUT /api/routing-rules`
```json
{ "rules": [
  { "id": "r1", "enabled": true, "name": "Coding to Claude",
    "whenCapability": "coding", "preferProviderId": "anthropic", "preferModelId": null }
] }
```
A rule fires when the request wants that capability, whether the caller stated
it or NYRO inferred it. Targets are validated against the live registry on
save, so a rule cannot be stored pointing at something that does not exist.

**A rule is a preference, not a constraint.** It reorders candidates the router
already accepted, so it can never send a local-only or sensitive request to the
cloud, never exceed a spending limit, and never fail a request because the
preferred model is offline. The routing explanation names the rule that applied.

## Budget (spec §66)

### `GET /api/budget`
Returns the configured limits, spend to date (day / week / month / per provider),
what those limits are currently doing, and what remains.

### `PUT /api/budget`
```json
{
  "dailyUsd": 5,
  "weeklyUsd": null,
  "monthlyUsd": 50,
  "perRequestUsd": 0.05,
  "perProviderMonthlyUsd": { "openai": 10 },
  "onExceeded": "local_only"
}
```
`null` means no limit. A cap for an unknown provider id is rejected, so a typo
cannot create a limit that silently never applies.

`onExceeded` is `local_only` (keep working on free local models) or `block`
(refuse until the limit is raised).

### `DELETE /api/budget`
Removes every limit.

### How it is enforced
The budget is evaluated **before** routing, and its verdict narrows what the
router may consider:

- A period cap that is used up either forces the request local or blocks it.
- A provider whose own monthly cap is used up is excluded from routing; the
  other providers keep working.
- `perRequestUsd` becomes a routing ceiling. If the caller also sent
  `maxCostUsd`, the tighter of the two applies.
- A request marked `local_only` or `sensitive`, or sent with `mode:local_only`,
  is **never** blocked by a spending limit — it costs nothing to run.

When a limit constrains a request, `/api/chat` includes a `budget` object and
`/api/chat/stream` emits a `budget` event before `routing`. A blocked request
fails with `cost_limit_exceeded`.

## Stats

### `GET /api/stats`
`?hours=24`. Totals plus per-model runs, failures, cancellations, average
latency and cost. Cancellations are counted separately from failures and are
excluded from the latency average.
