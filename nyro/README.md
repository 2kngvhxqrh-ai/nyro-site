# NYRO — Phase 1 (Foundation)

A personal AI operating system. This directory contains **Phase 1** (the
foundation) plus **Phase 2**: enforced spending limits, task-specific routing rules,
and routing that learns model speed from real runs.

```
User → NYRO Web UI → NYRO API → NYRO Core → Model Router → Provider adapters → Response
```

Ollama is one provider behind that boundary. So are OpenAI, Anthropic, Google,
Groq, Mistral, OpenRouter, xAI, and any OpenAI-compatible server you point at.
None of them is the architecture.

## What actually works today

Every row names the suite that covers it, so the claim is checkable rather
than asserted — 314 tests (277 API, 37 web) plus 29 browser checks, run against
a real Postgres and a real Chromium. The column used to read "working" or
"working, tested", which distinguished nothing: every row was tested, so the
weaker label was misinformation in the cautious direction.

| Capability | Covered by |
|---|---|
| Chat through the model router, streaming over SSE | e2e |
| Three real wire protocols: Ollama NDJSON, OpenAI SSE, Anthropic typed SSE | providers, e2e |
| Add / remove / test providers; store API keys encrypted at rest | e2e, security, ui.browser |
| Dynamic model discovery into a Postgres-backed registry | e2e |
| Routing modes: auto, cheapest, fastest, best, local_only, cloud_only | router, e2e |
| Privacy enforcement — a local-only request can never reach a cloud model | router, e2e |
| Automatic fallback to the next-ranked model when one fails | e2e |
| Stop that cancels the upstream call, keeping what was written, marked | providers, e2e |
| Conversation persistence: browse, resume, rename, delete | e2e |
| Your place, your draft and the panel you closed survive a tab switch | ui.browser |
| Copy a whole answer, not only the code blocks inside it — over plain HTTP too | ui.browser |
| One view that throws shows a message instead of blanking the app | ui.browser |
| Export everything you own, and it really is everything | export, e2e |
| Full-text search with snippets, saying when it capped | e2e, ui.browser |
| Correct a model's price or context window; discovery will not overwrite it | e2e |
| Markdown rendering with syntax-labelled, copyable code blocks | markdown |
| Regenerate an answer, or retry it on a different model | e2e |
| Edit the last question in place and re-answer it | e2e |
| See which model a message would go to, and why not the others | e2e, demo-core, ui.browser |
| Custom instructions: a standing system prompt you can switch off without losing | instructions, ui.browser |
| Health checks per component; per-model run/latency/cost stats | e2e |
| Spending limits: daily / weekly / monthly / per-request / per-provider | budget, e2e |
| Task-specific routing rules ("coding goes to Claude") | routing-rules, e2e |
| Measured routing: speed learned from real runs, not guessed | performance, e2e |
| Single-process mode: the API serves the built UI on one origin | static |
| Static serving that refuses path traversal and symlink escapes | static |
| No clipped content at 360–1440px; a fresh install; the API going away | ui.browser |

## What is deliberately NOT here

Not stubs, not hidden behind a flag — simply not built yet, because Phase 1 is
the foundation and shipping empty shells would be worse than shipping nothing
(spec §175, §176).

Agents · Tools · Memory · Projects · Tasks/background jobs · Windmill ·
Browser control · Computer control · Voice · Vision and documents ·
Multi-user · Approvals · Plugin system.

Two things are worth calling out because their *absence is visible* in the code:

- **No adapter advertises `vision` or `tool_calling`.** Those APIs support both;
  these adapters do not send image parts or tool definitions yet. Claiming the
  capability would make the router pick a provider for work it cannot do.
- **Reasoning and coding scores are still heuristics**, inferred from the model
  name and labelled `catalog` or `heuristic` in the Models table. **Speed is no
  longer a guess**: once a model has enough successful runs, NYRO ranks it on
  measured throughput and says so. Prices and context windows can be corrected
  by hand, and a corrected model is labelled `user` and left alone by discovery.

## Quick start

```bash
docker compose -f docker/docker-compose.yml up -d   # Postgres
pnpm install
pnpm setup:env                                      # writes .env, generates the encryption key
pnpm start                                          # builds the UI, migrates, serves everything
```

Then open **http://localhost:8787**. That is the whole app — the API serves the
built UI, so it is one process on one origin.

Set `OLLAMA_BASE_URL` in `.env` (or add a provider in the UI) to connect a model.

For development with hot reload, `pnpm dev` instead runs Vite on :5173 with the
API on :8787. `pnpm smoke` checks your real providers against the real vendors —
the one thing the test suite cannot do for you. Full detail in
[`docs/SETUP.md`](docs/SETUP.md).

## Layout

```
nyro/
├── apps/
│   ├── api/          NYRO API + Core + providers + database
│   │   └── src/
│   │       ├── core/       router, executor, registry, chat service, health
│   │       ├── providers/  one file per wire protocol + presets + traits
│   │       ├── db/         schema, migrations, repositories
│   │       ├── http/       routes, SSE, validation
│   │       └── util/       crypto, redaction, logging, HTTP client
│   └── web/          React + TypeScript + Tailwind
├── docker/           Postgres for development
└── docs/             ARCHITECTURE, SETUP, API, SECURITY, PHASE1
```

The `src/core/`, `src/providers/`, `src/db/` split mirrors the eventual
`packages/*` layout in the long-term spec. Extracting them into real workspace
packages is mechanical when a second consumer exists; doing it now would add
build wiring to solve nothing.

## Docs

- [ARCHITECTURE.md](docs/ARCHITECTURE.md) — the boundaries and why they are where they are
- [SETUP.md](docs/SETUP.md) — running it, including Windows + Ollama
- [API.md](docs/API.md) — every endpoint
- [SECURITY.md](docs/SECURITY.md) — key handling, and what is not protected yet
- [PHASE1.md](docs/PHASE1.md) — what was built, what was tested, what is next
