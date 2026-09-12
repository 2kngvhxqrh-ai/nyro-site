# NYRO — Phase 1 (Foundation)

A personal AI operating system. This directory contains **Phase 1 only**: the
foundation the rest of the system is built on.

```
User → NYRO Web UI → NYRO API → NYRO Core → Model Router → Provider adapters → Response
```

Ollama is one provider behind that boundary. So are OpenAI, Anthropic, Google,
Groq, Mistral, OpenRouter, xAI, and any OpenAI-compatible server you point at.
None of them is the architecture.

## What actually works today

Everything in this list is covered by the test suite (103 tests) and was
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
| Conversation persistence and history | working |
| Health checks per component; per-model run/latency/cost stats | working |
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
- **Model quality scores are heuristics, not benchmarks.** The Models table
  labels each row `catalog` (a known-family lookup) or `heuristic` (inferred
  from the model name). Measured scores from real runs are Phase 2.

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
API on :8787. Full detail in [`docs/SETUP.md`](docs/SETUP.md).

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
