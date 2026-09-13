/**
 * Migrations.
 *
 * Plain SQL in an ordered list, applied inside a transaction, tracked in
 * nyro_migrations. No migration framework: at this size one would be
 * infrastructure for its own sake (spec §116, §186).
 *
 * Only the Phase 1 slice of the §75 table list is created here. Tables for
 * memory, agents, tools, approvals and automations arrive with the phases that
 * actually use them — creating them now would be the placeholder-schema
 * equivalent of the fake features §175 forbids.
 */
export interface Migration {
  id: string;
  sql: string;
}

export const MIGRATIONS: Migration[] = [
  {
    id: "0001_phase1_foundation",
    sql: /* sql */ `
      -- Providers: user-configured connections to model backends.
      create table if not exists providers (
        id                text primary key,
        display_name      text        not null,
        preset_key        text        not null,
        transport         text        not null,
        base_url          text        not null default '',
        -- AES-256-GCM ciphertext, never plaintext. Null when no auth is needed.
        api_key_encrypted text,
        api_key_hint      text,
        local             boolean     not null default false,
        enabled           boolean     not null default true,
        request_timeout_ms integer    not null default 120000,
        extra             jsonb       not null default '{}'::jsonb,
        health_state      text        not null default 'unknown',
        health_detail     text        not null default '',
        health_latency_ms integer,
        health_checked_at timestamptz,
        created_at        timestamptz not null default now(),
        updated_at        timestamptz not null default now()
      );

      -- Model registry (spec §7). Rows are created by discovery, not hard-coded.
      create table if not exists models (
        id                  text primary key,
        provider_id         text        not null references providers(id) on delete cascade,
        model_identifier    text        not null,
        display_name        text        not null,
        context_window      integer     not null,
        max_output_tokens   integer     not null,
        input_cost_per_1m   numeric     not null default 0,
        output_cost_per_1m  numeric     not null default 0,
        capabilities        jsonb       not null default '[]'::jsonb,
        scores              jsonb       not null default '{}'::jsonb,
        local               boolean     not null default false,
        enabled             boolean     not null default true,
        -- 'catalog' = known family, 'heuristic' = inferred, 'user' = hand-edited.
        traits_source       text        not null default 'heuristic',
        last_seen_at        timestamptz not null default now(),
        created_at          timestamptz not null default now(),
        unique (provider_id, model_identifier)
      );
      create index if not exists models_provider_idx on models(provider_id);

      create table if not exists conversations (
        id         uuid primary key,
        title      text        not null default 'New conversation',
        created_at timestamptz not null default now(),
        updated_at timestamptz not null default now()
      );

      create table if not exists messages (
        id              uuid primary key,
        conversation_id uuid        not null references conversations(id) on delete cascade,
        role            text        not null,
        content         text        not null,
        -- Which model produced an assistant message; null for user/system turns.
        model_id        text,
        created_at      timestamptz not null default now()
      );
      create index if not exists messages_conversation_idx on messages(conversation_id, created_at);

      -- Observability (spec §71) and the data the router will later learn from (spec §102).
      create table if not exists model_runs (
        id               uuid primary key,
        conversation_id  uuid references conversations(id) on delete set null,
        model_id         text        not null,
        provider_id      text        not null,
        routing_mode     text        not null,
        -- 0 = primary choice, 1+ = a fallback was used.
        attempt_index    integer     not null default 0,
        ok               boolean     not null,
        error_code       text,
        latency_ms       integer     not null,
        input_tokens     integer     not null default 0,
        output_tokens    integer     not null default 0,
        cost_usd         numeric     not null default 0,
        created_at       timestamptz not null default now()
      );
      create index if not exists model_runs_created_idx on model_runs(created_at desc);
      create index if not exists model_runs_model_idx on model_runs(model_id, created_at desc);

      create table if not exists settings (
        key        text primary key,
        value      jsonb       not null,
        updated_at timestamptz not null default now()
      );
    `,
  },
  {
    id: "0002_message_finish_reason",
    sql: /* sql */ `
      -- Why an assistant message ended. Null for every message written before
      -- this column existed and for every ordinary completion; 'cancelled'
      -- marks an answer the user stopped part-way.
      --
      -- Stopping used to discard the text entirely, so the screen and the
      -- database disagreed about what had happened: you could read an answer,
      -- press Stop because you had what you needed, and find nothing there on
      -- reload. Keeping it is only honest if it is also marked, or a truncated
      -- answer would later read as a complete one.
      alter table messages add column if not exists finish_reason text;
    `,
  },
];
