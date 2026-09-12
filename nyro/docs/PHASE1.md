# Phase 1 — what was built, tested, and found

## Scope

Spec §157: Web UI, API, Core, PostgreSQL, model abstraction, Ollama provider,
cloud provider architecture, model registry, router, streaming, health checks.

Milestone: `User → NYRO → Model Router → provider → response`, working reliably.

## Built

**Provider layer** — `ModelProvider` interface plus four adapters:

| Adapter | Protocol | Covers |
|---|---|---|
| `OllamaProvider` | native `/api/chat`, newline-delimited JSON | Ollama |
| `OpenAICompatibleProvider` | `/v1/chat/completions`, SSE | OpenAI, Groq, Mistral, OpenRouter, xAI, Gemini (OpenAI-compat endpoint), vLLM, LM Studio, llama.cpp, any custom |
| `AnthropicProvider` | `/v1/messages`, typed SSE | Anthropic |
| `MockProvider` | in-process | tests and first-run verification; labelled a mock everywhere |

Anthropic exists partly to keep the abstraction honest: its wire format differs
from OpenAI's in five ways that would break a layer that was secretly
OpenAI-shaped (system prompt placement, auth header, mandatory `max_tokens`,
typed stream events, usage split across two events).

**Core** — pure-function router with six modes and hard privacy constraints;
ranked-candidate fallback executor; Postgres-backed dynamic model registry with
discovery and pruning; encrypted secrets; event bus; per-component health.

**API** — 17 endpoints, SSE streaming, zod validation, cancellation.

**Web** — React + TypeScript + Tailwind. Chat with live routing display and a
working Stop button, provider/model management, health and run statistics.

## Tested

220 automated tests, run repeatedly with no flakes.

| Suite | Tests | What it protects |
|---|---|---|
| `router.test.ts` | 24 | privacy constraints, modes, overrides, determinism, hard vs soft capabilities |
| `providers.test.ts` | 21 | all three wire protocols against real HTTP servers, chunk boundaries, error mapping, cross-transport cancellation |
| `security.test.ts` | 14 | encryption round-trip, IV uniqueness, tamper detection, redaction, error-surface leakage |
| `performance.test.ts` | 19 | measured throughput overrides guessed speed, but only with enough evidence |
| `routing-rules.test.ts` | 20 | rules steer routing, and can never beat privacy, budget or availability |
| `export.test.ts` | 6 | markdown rendering and the versioned bundle shape |
| `budget.test.ts` | 22 | spending limits: period caps, per-provider caps, and the cases where a budget must NOT fire |
| `static.test.ts` | 21 | path traversal (encoded, NUL bytes, malformed encoding, prefix-sibling), cache headers, SPA fallback |
| `e2e.test.ts` | 23 | full stack on real Postgres: discovery, chat, streaming, fallback, cancellation accounting, restart persistence |

Additionally verified by hand against a running system:

- API booted, migrated, bootstrapped a provider, discovered models, reported healthy
- SSE streaming inspected raw over curl
- The UI driven in real Chromium: message sent and streamed, routing shown,
  models table rendered, health page populated, Stop button halting token
  delivery, **zero console errors**, and no key material anywhere in the DOM

### What the tests do not prove

The upstream model servers in the tests are local servers speaking each
vendor's real wire protocol. That proves our adapters. It does not prove that
OpenAI or Anthropic behave as documented, and nothing here was run against a
live Ollama either.

That gap is now closable rather than merely acknowledged: `pnpm smoke` runs the
real adapters against the user's own providers and keys. It is deliberately not
in CI, because CI has neither.

## Bugs found by testing, and fixed

Three of these were found only by running the system, not by unit tests. Worth
recording, because each was a design error rather than a typo.

1. **Transport capabilities were intersected with model capabilities.**
   `adapter.supports()` describes what the adapter can *send*; model traits
   describe what the model *is*. Intersecting them stripped `coding` from
   `qwen2.5-coder:7b`, because the Ollama adapter does not implement tool
   calling. Fixed by making capability ownership explicit in `provider.ts`.

2. **Inferred capabilities were hard requirements.** Asking "Explain what you
   are" made NYRO infer `reasoning`, which no small local model claimed, so it
   *refused to answer*. Guessed intent is now a preference that steers ranking
   and never excludes. Refusing is worse than answering with a weaker model.

3. **Cancellation behaved differently per adapter.** An abort threw out of the
   fetch body before the adapters' own checks ran. Every adapter now ends a
   cancelled stream with `{done, finishReason: "cancelled"}`, and a
   cross-transport test asserts all three agree.

4. **User cancellations were counted as model failures**, which would misreport
   provider reliability and eventually teach the router to avoid a healthy
   model. Now counted separately and excluded from latency averages.

5. **A turn was attributed to the wrong model after a fallback.** The header
   showed the provider of the model first *chosen*, not the one that answered —
   `gpt-4o` labelled `ANTHROPIC`. Misattributing which model produced a
   response is close to the worst bug a routing UI can have. Found by looking
   at a screenshot, not by a test.

6. **A top-level `await` broke the production build.** It was introduced for
   the browser demo, whose build targets es2022 and so hid it. Caught only by
   re-running the normal build — a reminder that verifying the path you just
   changed is not the same as verifying the ones you did not.

## Deviations from the spec, and why

| Spec asks for | Built instead | Reason |
|---|---|---|
| `packages/core`, `packages/models`, … (§118) | Directory boundaries inside `apps/api/src` | The same separation without build wiring. Extraction is mechanical once a second consumer exists (§186) |
| ~22 database tables (§75) | 5 | Tables for agents, tools and approvals would be designed without the code that uses them and would be wrong by the time it arrives (§175) |
| Gemini as a native provider (§5) | Gemini via its OpenAI-compatible endpoint | Real and working today. A native adapter is Phase 2; claiming one now would be fiction |
| Benchmarking (§13) | Heuristic scores, labelled as such | Real benchmarks need real usage data. Every score shows its source in the UI |

## Not built (and not stubbed)

Agents, tools, memory, projects, background tasks, Windmill, browser control,
computer control, voice, vision, documents, approvals, plugins, multi-user.

The navigation has three items, not twelve. Dead nav links would be exactly
the fake completeness §175 rules out.

## Suggested Phase 2

In dependency order:

1. ~~**A live-provider smoke test.**~~ — **done.** `pnpm smoke` runs the real
   adapters against the user's own configured providers and keys. It is the one
   check CI cannot do, so it is opt-in rather than automated.
2. ~~**Router learning from `model_runs`** (§102)~~ — **done.** Speed is now
   measured from real runs (median output tokens per second) once a model has
   enough of them. Reasoning and coding scores remain heuristics.
3. **Native Gemini adapter**, proving a third wire format.
4. ~~**Budget enforcement** (§66)~~ — **done.** Daily, weekly, monthly,
   per-request and per-provider caps, enforced before a model is called.
5. ~~**Model editing in the UI**~~ — **done.** Prices and context windows are
   correctable, and the preservation logic in `upsertDiscovered` is finally
   reachable: nothing could previously set `traits_source = 'user'`, so those
   branches were dead code.

Authentication should come before anything that makes NYRO reachable beyond
localhost.
