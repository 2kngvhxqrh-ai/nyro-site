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

Everything in this list is covered by the test suite (299 tests: 264 API, 35 web) and was
verified running against a real Postgres and a real browser.

| Capability | State |
|---|---|
| Chat through the model router, streaming over SSE | working |
| Three real wire protocols: Ollama NDJSON, OpenAI SSE, Anthropic typed SSE | working |
| Add / remove / test providers; store API keys encrypted at rest | working |
| Dynamic model discovery into a Postgres-backed registry | working |
| Routing modes: auto, cheapest, fastest, best, local_only, cloud_only | working |
| Privacy enforcement — a local-only request can never reach a cloud model | working, tested |
| Automatic fallback to the next-ranked model when one fails | working, tested |
| Stop button that genuinely cancels the upstream model call | working, tested |
| Conversation persistence, with history you can browse, resume, rename and delete | working, tested |
| Export everything you own to JSON or readable Markdown, with no API keys | working, tested |
| Full-text search across every conversation, with highlighted snippets | working, tested |
| Correct a model's price or context window; discovery will not overwrite it | working, tested |
| Markdown rendering with syntax-labelled, copyable code blocks | working, tested |
| Regenerate an answer, or retry it on a different model | working, tested |
| Edit the last question in place and re-answer it | working, tested |
| See which model a message would go to, and why not the others, before sending | working, tested |
| Custom instructions: a standing system prompt you can switch off without losing | working, tested |
| Health checks per component; per-model run/latency/cost stats | working |
| Spending limits: daily / weekly / monthly / per-request / per-provider | working, tested |
| Task-specific routing rules ("coding goes to Claude") | working, tested |
| Measured routing: speed learned from real runs, not guessed | working, tested |
| Single-process mode: the API serves the built UI on one origin | working |
| Static serving that refuses path traversal | working, tested |

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
pnpm setup                                          # writes .env, generates the encryption key
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
