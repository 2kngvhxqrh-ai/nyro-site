# NYRO Architecture (Phase 1)

## The one rule

NYRO Core depends on the `ModelProvider` interface and never on a vendor.

```
apps/web  ──HTTP/SSE──▶  apps/api/src/http  ──▶  core/chat-service
                                                       │
                                          ┌────────────┴────────────┐
                                          ▼                         ▼
                                    core/router                core/executor
                                    (pure function)                  │
                                                                     ▼
                                                              core/registry
                                                                     │
                                                       ┌─────────────┴─────────────┐
                                                       ▼             ▼             ▼
                                          providers/ollama   openai-compatible  anthropic
```

Two properties follow, and both are enforced by tests rather than convention:

- **The browser has no provider knowledge.** No base URLs, no API keys, no
  mention of Ollama. It names models by registry id and nothing else.
- **Adding a provider touches no file in `core/`.** It is a preset entry, an
  adapter class, one line in `providers/index.ts`, and tests.

## Request lifecycle

```
POST /api/chat/stream
  → zod validation                       (http/schemas.ts)
  → load recent history                  (db/repos.ts)
  → derive capabilities                  (core/chat-service.ts)
  → route → ranked candidate list        (core/router.ts)        ── SSE: routing
  → persist the user turn                (db/repos.ts)
  → attempt candidate[0]                 (core/executor.ts)      ── SSE: attempt
      ├─ success → stream deltas                                 ── SSE: delta…
      └─ retryable failure → attempt candidate[1]                ── SSE: attempt
  → persist the assistant turn + a model_run row
                                                                 ── SSE: usage, done
```

## Design decisions worth the argument

### The router returns a ranked list, not a winner

Fallback then needs no policy of its own. Anything excluded on privacy or cost
grounds is not in the list, so the executor *cannot* escalate to it even if
every other candidate fails. Making fallback a separate subsystem with its own
rules would create exactly the gap where a local-only request leaks to a cloud
provider.

### The router is a pure function

`route(models, request) → decision`. No I/O, no clock, no randomness. This is
what makes the privacy guarantee a test rather than a promise
(`test/router.test.ts`).

### Required vs preferred capabilities

A *required* capability excludes models that lack it. A *preferred* capability
only influences ranking.

Guessed intent belongs in the second category. An early version made inferred
capabilities hard requirements, and the result was NYRO refusing to answer
"explain what you are" because the word *explain* implied reasoning and the only
local model scored low on it. Refusing to answer is worse than answering with
the best model available.

### Transport capabilities vs model capabilities

`adapter.supports()` answers "can this adapter send that?" — streaming, images,
tool definitions. Model traits answer "is this model good at that?" — reasoning,
coding, context length.

Intersecting the two was a real bug: it stripped `coding` from a coder model,
because the Ollama *adapter* does not implement tool calling. `provider.ts`
now states which capabilities each side owns, and the registry only gates the
transport-owned ones.

### Cancellation is a terminal state, not an error

Every adapter ends a cancelled stream with `{done, finishReason: "cancelled"}`
rather than throwing, so Stop behaves identically whichever provider is in use.
A cancellation is recorded separately from a failure — counting a user pressing
Stop as a model failure would misreport provider reliability and, once the
router learns from history, would teach it to avoid a perfectly good model.

### The API serves the UI in production, Vite serves it in development

With `NYRO_STATIC_DIR` set, the API serves the built web app itself. That makes
NYRO one process on one origin, which removes the dev proxy and removes CORS
from the picture entirely — `/api` requests are same-origin by construction
rather than by configuration, so there is no allow-list to get wrong in
production.

`pnpm dev` keeps Vite on :5173 with hot reload, proxying `/api`; that is the
only configuration where CORS applies at all.

### No Express, no ORM, no Redis, no vector DB

Each was considered and rejected for Phase 1 (spec §74, §116, §186):

| Candidate | Why not yet |
|---|---|
| Express | `node:http` plus a ~90-line router covers every current route |
| ORM | The queries are simple; an ORM would add a build step and a mental model |
| Redis / queue | Nothing is queued yet. Phase 10 background tasks is when this earns its place |
| Vector DB | No embeddings yet. Phase 3 will use Postgres + pgvector before anything else |

Runtime dependencies for the whole API: `pg` and `zod`.

### Only the Phase 1 tables exist

The long-term spec lists ~22 tables. Five exist. Creating empty `agents`,
`tools` and `approvals` tables now would be schema theatre — they would be
designed without the code that uses them and would be wrong by the time it
arrives.

## Extension points already in place

| Future phase | Seam that exists today |
|---|---|
| Agents (§15, §16) | `chat-service.plan()` produces the routing request; a CEO agent replaces the keyword pass without changing anything downstream |
| Memory (§25) | `HISTORY_TURNS` in `chat-service.ts` is the single place context is assembled |
| Tools (§32) | `Capability` already carries `tool_calling`; adapters simply do not claim it yet |
| Router learning (§102) | `model_runs` records model, latency, success and cost per attempt |
| Automation engines (§49) | Nothing references Windmill; the automation interface lands with Phase 6 |
| Multi-user (§92) | `conversations` has no user column yet, but nothing assumes a single user in Core |
