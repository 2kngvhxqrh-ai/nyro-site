# Security — Phase 1

## What is protected

### API keys at rest
AES-256-GCM, random 12-byte IV per record, master key from `NYRO_SECRET_KEY`
(32 bytes). Stored as `v1.<iv>.<tag>.<ciphertext>`.

- A key is decrypted only inside `ProviderRepo.getConfig()` and handed straight
  to an adapter's request headers.
- The `PublicProvider` type returned by the API has **no key field at all**, so
  leaking one is a type error rather than something a reviewer must catch.
- Tampering fails GCM authentication rather than returning garbage.
- The wrong master key produces a clear error, not silent corruption.

### Keys in logs
Two layers. Keys named `apiKey`, `authorization`, `token`, `secret`, `password`,
`credential`, `cookie` (any depth) are replaced with `[redacted]`. Independently,
known key *shapes* (`sk-`, `sk-ant-`, `gsk_`, `xai-`, `AIza`, `Bearer …`) are
stripped from free text — so a key echoed inside an upstream error message is
caught too.

### Error detail
`NyroError.detail` holds raw upstream response bodies and is written to the
server log only. `toPublic()` omits it entirely.

### Input validation
Every request body is parsed with zod before reaching Core. Request bodies are
capped at 1 MB.

### CORS
Explicit allow-list from `NYRO_CORS_ORIGINS`. No wildcard. An unknown origin
receives no CORS header.

### SQL
Parameterised queries throughout. No string interpolation of user input.

### Privacy routing
A request marked `local_only` or `sensitive` cannot reach a cloud model —
including via fallback, and including when the user explicitly names a cloud
model. Enforced in `core/router.ts` and covered by six tests.

## What is NOT protected yet

Stated plainly, because a security section that only lists wins is misleading.

| Gap | Consequence | Phase |
|---|---|---|
| **No authentication** | Anyone who can reach the port can use NYRO and manage providers. Bind to `127.0.0.1`. Do not expose it. | Auth arrives with multi-user (§92) |
| **No rate limiting** | A runaway client can exhaust a provider quota | §69 |
| **No audit log** | Provider and model changes are not recorded | §70 |
| **No budget enforcement** | `maxCostUsd` is per-request only; there is no daily or monthly cap | §66 |
| **No approval engine** | Nothing needs approval yet because no tool can act on the world | §36 |
| **No sandboxing** | Nothing executes code yet | §40 |
| **Key rotation is manual** | Changing `NYRO_SECRET_KEY` invalidates stored keys; they must be re-entered | — |

## Operational notes

- Back up `NYRO_SECRET_KEY` separately from the database. Together they are the
  plaintext keys; apart, neither is enough.
- `.env` is gitignored. Cloud provider keys belong in the Models UI (encrypted),
  not in `.env` (plaintext).
- The test suite deletes rows. Point `TEST_DATABASE_URL` at a throwaway database.
- The mock provider is off unless `NYRO_ENABLE_MOCK_PROVIDER=true`, and labels
  itself as a mock in its output, its health detail and the UI.
