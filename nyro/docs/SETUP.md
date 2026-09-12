# Setup

## Requirements

- Node.js 22 or newer (uses the built-in test runner and native TypeScript stripping)
- pnpm 9 or newer
- Docker, for Postgres (or an existing Postgres 14+)

## 1. Database

```bash
docker compose -f docker/docker-compose.yml up -d
```

Postgres listens on **5433** so it does not collide with an existing local
instance on 5432. It also creates `nyro_test` for the test suite.

Using your own Postgres instead? Create two databases and point `DATABASE_URL`
and `TEST_DATABASE_URL` at them. No extensions are required.

## 2. Configuration

```bash
pnpm install
pnpm setup
```

`pnpm setup` writes `.env` from `.env.example` and generates `NYRO_SECRET_KEY`
for you. It never touches an existing `.env` — regenerating that key would make
every stored provider API key undecryptable. It is a Node script, so it behaves
identically on Windows, where `openssl` is often absent.

`NYRO_SECRET_KEY` encrypts provider API keys at rest. **Back it up.** If it is
lost or changed, stored keys cannot be decrypted and must be re-entered — NYRO
will tell you so rather than failing silently.

## 3. Run it

```bash
pnpm start
```

Builds the UI, applies migrations, and starts NYRO. Then open:

**http://localhost:8787**

That is the whole application. The API serves the built web app itself, so
there is one process on one origin — no second server, no dev proxy, and no
CORS, because the browser's `/api` requests are same-origin by construction.

Migrations are idempotent; re-running prints `Database already up to date.`

### Development instead

```bash
pnpm dev
```

Runs Vite on :5173 with hot reload, proxying `/api` to the API on :8787. Use
this while changing the UI; use `pnpm start` to run the real thing.

## 4. Connect a provider

### Ollama (local)

Set `OLLAMA_BASE_URL` in `.env` and restart, or add it in the UI under
**Models → + Add provider**.

Which URL depends on where each part runs:

| NYRO runs | Ollama runs | URL |
|---|---|---|
| On the host | On the host | `http://localhost:11434` |
| In Docker | On the host | `http://host.docker.internal:11434` |
| On the host | In Docker (port published) | `http://localhost:11434` |

Then press **Discover**. Every model you have pulled appears in the registry.

Ollama must be reachable and have at least one model pulled:

```bash
ollama pull llama3.2:1b
curl http://localhost:11434/api/tags     # should list it
```

### A cloud provider

**Models → + Add provider**, pick one, paste the key, save. The key is
encrypted before it is stored and is never sent back to the browser — you will
only ever see the last four characters again.

Presets ship for OpenAI, Anthropic, Google Gemini, Groq, Mistral, OpenRouter
and xAI, plus **Custom (OpenAI-compatible)** for vLLM, LM Studio, llama.cpp, a
proxy, or anything else speaking that protocol.

## 5. Verify it works

```bash
curl http://127.0.0.1:8787/api/health | jq
curl -N -X POST http://127.0.0.1:8787/api/chat/stream \
  -H 'content-type: application/json' \
  -d '{"message":"What is 25 x 17?","mode":"auto"}'
```

You should see a `routing` event naming the chosen model, then `delta` events,
then `usage` and `done`.

## Tests

```bash
pnpm test          # requires TEST_DATABASE_URL
pnpm typecheck
pnpm build
```

### Proving it works against the real vendors

```bash
pnpm smoke            # every enabled provider
pnpm smoke -- ollama  # just one
```

This is the one check the test suite cannot do for you. It uses the providers
and API keys you have configured, lists their models, and sends one ~16-token
completion to each provider's cheapest registered model. It prints what it is
about to do before spending anything, never prints a key, and exits non-zero if
any provider fails.

It is not in `pnpm test` and not in CI, because it needs your real credentials
and spends your real money.

**What the tests do and do not prove.** They run against a real Postgres, a
real HTTP listener and real sockets. The upstream model servers are local
servers speaking each vendor's genuine wire protocol — which proves request
shaping, stream framing, usage parsing, error mapping and cancellation, but
does **not** prove that OpenAI or Anthropic behave as documented. Only a live
API key does that. Use **Test connection** in the Models UI for that check.

## Browser demo mode (no server)

```bash
pnpm --filter @nyro/web build:demo     # output in apps/web/dist-demo
```

Builds the UI with an in-browser core replacing the API, so the app runs with
no server, no database and no provider. The React app is **unchanged** — it
still only talks to `/api/*`, which is the point: if it needed special-casing
for this, the frontend would hold provider knowledge it should not have.

Real in demo mode: the router, privacy enforcement, the fallback chain, cost
and token estimates and model traits — the actual modules from `apps/api/src`,
bundled, not reimplemented. Simulated: reply text (nothing is inferred), the
model registry (a browser cannot reach a provider), and storage (memory only).

Every simulated reply is prefixed `[simulated — no model was called]`, and a
non-dismissible banner says so. `apps/web/artifact.html` is the page shell used
when publishing the build as a hosted page; the build emits it alongside the
assets.

The flag is `VITE_NYRO_DEMO`, defined literally in both vite configs so the
demo code is dropped from the production bundle at build time rather than
shipped as chunks the real app never loads.

## Troubleshooting

**`NYRO_SECRET_KEY is not set`** — step 2. It is required; NYRO will not start
without it rather than storing keys unencrypted.

**Provider shows `unreachable`** — the base URL is wrong or the service is
down. The Health page prints the exact origin it tried. From Docker,
`localhost` means the container, not your machine — use `host.docker.internal`.

**`no_eligible_model`** — the router excluded everything. The error response
lists each model and the rule that excluded it. Common causes: privacy set to
local-only with no local provider, every model disabled, or a prompt larger
than any configured model's context window.

**Ollama reachable but no models** — nothing is pulled. `ollama pull llama3.2:1b`.

**Port already in use** — change `NYRO_PORT`, or the `5433:5432` mapping in
`docker/docker-compose.yml`.
