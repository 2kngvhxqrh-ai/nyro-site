# Working in this repository

Two separate things live here:

- **`index.html` + `README.md` at the root** — the public Nyro page, served by
  GitHub Pages. Do not restructure the root or move `index.html`; Pages serves
  it from there.
- **`nyro/`** — the NYRO system (Phases 1 and 2). Self-contained; nothing
  outside it references it.

> The root README says the system lives in a separate private repository.
> `nyro/` is here because that repo was not available. If it should move, it
> moves with one `git mv`.

## Commands (run inside `nyro/`)

```bash
pnpm setup        # writes .env, generates NYRO_SECRET_KEY (never overwrites)
pnpm smoke        # live check against the user's REAL providers (spends money)
pnpm start        # builds the UI, migrates, serves everything on :8787
pnpm dev          # Vite on :5173 with hot reload, API on :8787
pnpm typecheck    # both packages
pnpm build        # both packages
pnpm test         # both suites; needs TEST_DATABASE_URL (a THROWAWAY database)
pnpm --filter @nyro/web test   # web suite alone (no database)
```

Tests delete rows. Never point `TEST_DATABASE_URL` at a real database.

## Architectural invariants

These are not style preferences. Each is enforced by tests, and breaking one is
a bug even if everything still compiles.

**1. Nothing in `core/` may reference a vendor.**
`core/types.ts` is the contract. Adapters translate *into* those types. If you
are adding `openai_` or `ollama_` to a field name in `core/`, the abstraction
has leaked and the fix belongs in the adapter.

**2. Privacy is a hard constraint, not a preference.**
A request marked `local_only` or `sensitive` must never reach a cloud model —
not through fallback, and not when the user explicitly pins one. `route()`
excludes them before ranking, so the executor cannot escalate. See the six
privacy tests in `apps/api/test/router.test.ts`; if you change routing, those
must still pass unmodified.

**3. The router stays a pure function.**
`route(models, request) → ranked decision`. No I/O, no clock, no randomness.
That purity is what makes invariant 2 testable rather than aspirational.

**4. Transport capabilities and model capabilities are different things.**
`adapter.supports()` answers "can this adapter *send* that?" (streaming, image
parts, tool definitions). Model traits answer "is this model *good* at that?"
(reasoning, coding, context). `providers/provider.ts` states which side owns
which. Intersecting them was a real bug — it stripped `coding` from a coder
model.

**5. Never advertise a capability the adapter does not implement.**
No adapter claims `vision` or `tool_calling`, because none sends image parts or
tool definitions yet. Claiming one makes the router select that provider for
work it cannot do.

**6. Guessed intent is a preference, never a requirement.**
Inferred capabilities go in `preferredCapabilities` (steers ranking). Only
caller-stated capabilities go in `requiredCapabilities` (excludes models).
Making a guess a hard filter once caused NYRO to *refuse* to answer rather than
use a weaker model.

**7. A cancellation is not a failure.**
Every adapter ends a cancelled stream with `{done, finishReason: "cancelled"}`
rather than throwing, so Stop behaves identically on every transport.
Cancellations are counted separately from failures in `model_runs`; counting
them as failures would teach the router to avoid healthy models.

**8. Decrypted API keys never leave `ProviderRepo.getConfig()`.**
The `PublicProvider` type has no key field, so returning one is a type error.
Do not add one.

**9. The browser has no provider knowledge.**
No base URLs, no keys, no mention of Ollama in `apps/web`. The browser demo
mode is the proof: it runs the UI unmodified against an in-browser core.

**10. The demo bundles the real modules; it does not reimplement them.**
`apps/web/src/demo/core-imports.ts` imports from `apps/api/src`. CI fails if
the demo bundle stops containing the real router. A reimplementation would
drift and start quietly lying about what NYRO does.
Sharing the real modules also means the demo inherits their bugs, so
`apps/web/test/demo-core.test.ts` runs its core in Node against **the exact
request bodies `Chat.tsx` builds**. A tidier body than the app sends would have
passed while the published demo answered nothing, which is what happened.

**11. A spending limit must never block free work.**
A request that is already local-only or sensitive costs nothing, so no budget
applies to it. Likewise, one provider hitting its own cap excludes that
provider, never the whole account. Both cases are tested in
`apps/api/test/budget.test.ts`, and both are safeguards that would otherwise
quietly become obstacles.

**12. A routing rule is a preference, never a constraint.**
Rules boost a candidate's score; they cannot add one the eligibility filter
removed. That is what keeps a rule from overriding privacy, a budget, or
availability. If you ever make a rule a hard filter, "coding goes to Claude"
becomes a way to leak private code to the cloud.

**13. Anything NYRO stores, the user must be able to see and remove.**
Conversations were persisted from Phase 1 and unreachable in the UI until
Phase 2 — a system that quietly keeps your history and never shows it is worse
than one that does not keep it, because you cannot tell. Deleting a
conversation removes its messages but NOT its `model_runs`
(`on delete set null`), so removing a chat never rewrites what you have spent
or what NYRO measured. Tested. The same rule covers the `settings` table:
`export.ts` lists its keys through the `*_SETTINGS_KEY` constants, and
`instructions.test.ts` fails if a new settings document is added without one,
because a document NYRO stores and never exports is state the user cannot see.

**14. `traitsSource` must always describe where the values actually came from.**
`catalog` means a known-model lookup, `heuristic` means inferred from the name,
`user` means corrected by hand. `upsertDiscovered` maintains it — never
downgrading a user's override, and otherwise following the values — because a
row that reports catalog numbers as a guess is lying about its own provenance.

**15. Model output is never turned into HTML.**
`markdown/parse.ts` emits a token tree; `Markdown.tsx` renders it as React
elements. No HTML string, no `dangerouslySetInnerHTML`, anywhere in that path.
Only `http:`, `https:` and `mailto:` become links. If you ever reach for a
Markdown library here, you are trading a structural guarantee for trust in
someone else's sanitiser.

**16. A regenerate takes its prompt from stored history, never from the request.**
`send()` appends the user turn, so a naive retry would store the question twice
and send it to the model twice. `prepareRegenerate` deletes only the trailing
assistant message and returns the question already on record — which is also
what stops a regenerate from silently changing what was asked. Tested both
ways. `editLast` is the deliberate counterpart and a SEPARATE flag: changing
the question is its entire purpose, so it rewrites the stored turn in place
rather than appending. One flag with two meanings would make this invariant
hold only when a caller left a field unset, which is why sending both is a
400.

**17. A measured number must be distinguishable from a guessed one.**
Speed is measured from real runs once a model has enough of them; reasoning and
coding are still inferred from the model name. The Models table and the routing
explanation both say which is which. Never present an estimate as an
observation.

**18. Configuration is never a message.**
Custom instructions are sent to the model as a system message and are *not*
written to the conversation. Storing them would fold them into the history of
every later turn (compounding on each one), let them be edited from the chat,
and put a setting into an export of what the user said. They stay in
`settings`, resolved per turn by `resolveSystemPrompt` — a pure function, so
the precedence rule (a request's own prompt replaces them; `""` means none) is
testable without a database. `plan()` resolves them, which is what keeps
`/api/route/preview` sizing the same request `/api/chat` will send.

**19. A capability nobody can reach is not shipped.**
Three bugs came from one shape: something built and documented on the server,
wired into `apps/web/src/api.ts`, and called by no component. `systemPrompt`
was accepted by `/api/chat` from Phase 1 and always sent as `null`;
`/api/route/preview` — the view that makes a router legible — went unused for
the whole project. Nothing failed, so nobody looked.
`apps/web/test/api-surface.test.ts` fails when a client method is called by
nothing. A method genuinely meant for external callers does not belong in the
browser's client.

## Honesty rules for this codebase

The spec this was built from is explicit about it, and the code follows:

- Never claim something works that has not been run. Say what was tested and
  what was not.
- Never fabricate a tool result, a source, or a completed action.
- Mark anything not ready as `planned` or `experimental`. Do not ship
  placeholder features to look complete — the navigation lists only what is
  built, which is why it has four items and not twelve.
- Reasoning and coding scores are heuristics; every model row carries
  `traitsSource` (`catalog` / `heuristic` / `user`). Speed is measured once
  there is enough evidence, and is marked as measured wherever it appears.
- The mock and the browser demo label themselves as simulated on every surface.

## Conventions

- TypeScript throughout, `strict` plus `noUncheckedIndexedAccess`.
- `erasableSyntaxOnly` is on (Node strips types natively): no enums, no
  parameter properties.
- Runtime dependencies for the whole API are `pg` and `zod`. Adding one needs a
  real justification — Express, an ORM, Redis and a vector DB were each
  considered and rejected for Phase 1.
- Plain SQL, no ORM. Migrations are append-only entries in
  `apps/api/src/db/migrations.ts`.
- Only the tables Phase 1 uses exist. Do not create empty tables for future
  phases.
- Comments explain *why*, especially where a choice looks odd. Do not add
  comments that restate the code.

## Phase discipline

Phase 1 is the foundation. Later phases (agents, tools, memory, projects,
automation, voice, vision) are listed in `nyro/docs/PHASE1.md`. Build the
smallest genuinely useful thing, test it, then move on — do not start a later
phase because its abstraction seems obvious now.
