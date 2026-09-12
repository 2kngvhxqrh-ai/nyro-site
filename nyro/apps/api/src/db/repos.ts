/**
 * Data access. Plain SQL, no ORM (spec §116: dependencies must earn their place).
 *
 * Rule enforced here: a provider row's decrypted API key never leaves this
 * module except inside a ProviderConfig handed straight to an adapter. The
 * `PublicProvider` shape is what the API returns, and it has no key field at all
 * — so leaking one is a type error, not a code-review catch.
 */
import { randomUUID } from "node:crypto";
import type { Pool } from "./pool.ts";
import { dbError } from "./pool.ts";
import { decryptSecret, encryptSecret, secretHint } from "../util/crypto.ts";
import type { ProviderConfig, ProviderTransport } from "../providers/provider.ts";
import type { Capability, ChatMessage, HealthState, ModelScores, RegisteredModel, Role } from "../core/types.ts";

// ---------------------------------------------------------------------------
// Providers
// ---------------------------------------------------------------------------

interface ProviderRow {
  id: string;
  display_name: string;
  preset_key: string;
  transport: ProviderTransport;
  base_url: string;
  api_key_encrypted: string | null;
  api_key_hint: string | null;
  local: boolean;
  enabled: boolean;
  request_timeout_ms: number;
  extra: Record<string, string>;
  health_state: HealthState;
  health_detail: string;
  health_latency_ms: number | null;
  health_checked_at: string | null;
}

/** Exactly what /api/providers returns. Note the absence of any key material. */
export interface PublicProvider {
  id: string;
  displayName: string;
  presetKey: string;
  transport: ProviderTransport;
  baseUrl: string;
  hasApiKey: boolean;
  apiKeyHint: string | null;
  local: boolean;
  enabled: boolean;
  health: { state: HealthState; detail: string; latencyMs: number | null; checkedAt: string | null };
}

function toPublicProvider(r: ProviderRow): PublicProvider {
  return {
    id: r.id,
    displayName: r.display_name,
    presetKey: r.preset_key,
    transport: r.transport,
    baseUrl: r.base_url,
    hasApiKey: r.api_key_encrypted !== null,
    apiKeyHint: r.api_key_hint,
    local: r.local,
    enabled: r.enabled,
    health: {
      state: r.health_state,
      detail: r.health_detail,
      latencyMs: r.health_latency_ms,
      checkedAt: r.health_checked_at,
    },
  };
}

export interface UpsertProviderInput {
  id: string;
  displayName: string;
  presetKey: string;
  transport: ProviderTransport;
  baseUrl: string;
  /** Plaintext, encrypted here. `undefined` keeps any existing key; `null` clears it. */
  apiKey?: string | null;
  local: boolean;
  enabled: boolean;
  requestTimeoutMs: number;
  extra?: Record<string, string>;
}

export class ProviderRepo {
  private readonly pool: Pool;
  private readonly key: Buffer;

  constructor(pool: Pool, secretKey: Buffer) {
    this.pool = pool;
    this.key = secretKey;
  }

  async listPublic(): Promise<PublicProvider[]> {
    try {
      const { rows } = await this.pool.query<ProviderRow>("select * from providers order by local desc, display_name");
      return rows.map(toPublicProvider);
    } catch (err) {
      throw dbError(err, "listing providers");
    }
  }

  async getPublic(id: string): Promise<PublicProvider | null> {
    try {
      const { rows } = await this.pool.query<ProviderRow>("select * from providers where id = $1", [id]);
      return rows[0] ? toPublicProvider(rows[0]) : null;
    } catch (err) {
      throw dbError(err, "reading provider");
    }
  }

  /** Decrypts the key. Callers must pass the result straight to createProvider(). */
  async getConfig(id: string): Promise<ProviderConfig | null> {
    try {
      const { rows } = await this.pool.query<ProviderRow>("select * from providers where id = $1", [id]);
      const r = rows[0];
      if (!r) return null;
      return {
        id: r.id,
        displayName: r.display_name,
        transport: r.transport,
        baseUrl: r.base_url,
        apiKey: r.api_key_encrypted ? decryptSecret(r.api_key_encrypted, this.key) : null,
        local: r.local,
        requestTimeoutMs: r.request_timeout_ms,
        extra: r.extra ?? {},
      };
    } catch (err) {
      throw dbError(err, "reading provider config");
    }
  }

  async listEnabledConfigs(): Promise<ProviderConfig[]> {
    try {
      const { rows } = await this.pool.query<ProviderRow>("select id from providers where enabled = true");
      const out: ProviderConfig[] = [];
      for (const r of rows) {
        const cfg = await this.getConfig(r.id);
        if (cfg) out.push(cfg);
      }
      return out;
    } catch (err) {
      throw dbError(err, "listing enabled providers");
    }
  }

  async upsert(input: UpsertProviderInput): Promise<PublicProvider> {
    const encrypted =
      input.apiKey === undefined ? undefined : input.apiKey === null ? null : encryptSecret(input.apiKey, this.key);
    const hint = input.apiKey === undefined ? undefined : input.apiKey === null ? null : secretHint(input.apiKey);

    try {
      const { rows } = await this.pool.query<ProviderRow>(
        `insert into providers
           (id, display_name, preset_key, transport, base_url, api_key_encrypted, api_key_hint,
            local, enabled, request_timeout_ms, extra, updated_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11, now())
         on conflict (id) do update set
           display_name       = excluded.display_name,
           preset_key         = excluded.preset_key,
           transport          = excluded.transport,
           base_url           = excluded.base_url,
           -- $12 true means "the caller supplied a key field"; otherwise keep the stored one.
           api_key_encrypted  = case when $12 then excluded.api_key_encrypted else providers.api_key_encrypted end,
           api_key_hint       = case when $12 then excluded.api_key_hint      else providers.api_key_hint      end,
           local              = excluded.local,
           enabled            = excluded.enabled,
           request_timeout_ms = excluded.request_timeout_ms,
           extra              = excluded.extra,
           updated_at         = now()
         returning *`,
        [
          input.id,
          input.displayName,
          input.presetKey,
          input.transport,
          input.baseUrl,
          encrypted ?? null,
          hint ?? null,
          input.local,
          input.enabled,
          input.requestTimeoutMs,
          JSON.stringify(input.extra ?? {}),
          input.apiKey !== undefined,
        ],
      );
      return toPublicProvider(rows[0]!);
    } catch (err) {
      throw dbError(err, "saving provider");
    }
  }

  async delete(id: string): Promise<boolean> {
    try {
      const res = await this.pool.query("delete from providers where id = $1", [id]);
      return (res.rowCount ?? 0) > 0;
    } catch (err) {
      throw dbError(err, "deleting provider");
    }
  }

  async recordHealth(id: string, state: HealthState, detail: string, latencyMs: number | null): Promise<void> {
    try {
      await this.pool.query(
        `update providers
            set health_state = $2, health_detail = $3, health_latency_ms = $4, health_checked_at = now()
          where id = $1`,
        [id, state, detail, latencyMs],
      );
      // Model health tracks its provider; a model cannot be healthier than its route.
      await this.pool.query("update models set enabled = enabled where provider_id = $1", [id]);
    } catch (err) {
      throw dbError(err, "recording provider health");
    }
  }
}

// ---------------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------------

interface ModelRow {
  id: string;
  provider_id: string;
  model_identifier: string;
  display_name: string;
  context_window: number;
  max_output_tokens: number;
  input_cost_per_1m: number;
  output_cost_per_1m: number;
  capabilities: Capability[];
  scores: ModelScores;
  local: boolean;
  enabled: boolean;
  traits_source: string;
}

export interface ModelWithSource extends RegisteredModel {
  traitsSource: string;
}

function toModel(r: ModelRow, health: HealthState): ModelWithSource {
  return {
    id: r.id,
    providerId: r.provider_id,
    modelIdentifier: r.model_identifier,
    displayName: r.display_name,
    contextWindow: r.context_window,
    maxOutputTokens: r.max_output_tokens,
    inputCostPer1m: r.input_cost_per_1m,
    outputCostPer1m: r.output_cost_per_1m,
    capabilities: r.capabilities ?? [],
    scores: r.scores,
    local: r.local,
    enabled: r.enabled,
    health,
    traitsSource: r.traits_source,
  };
}

export interface UpsertModelInput {
  id: string;
  providerId: string;
  modelIdentifier: string;
  displayName: string;
  contextWindow: number;
  maxOutputTokens: number;
  inputCostPer1m: number;
  outputCostPer1m: number;
  capabilities: Capability[];
  scores: ModelScores;
  local: boolean;
  traitsSource: string;
}

export class ModelRepo {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  /** Joins provider health so the router never picks a model behind a dead provider. */
  async list(opts: { enabledOnly?: boolean } = {}): Promise<ModelWithSource[]> {
    try {
      const { rows } = await this.pool.query<ModelRow & { health_state: HealthState; provider_enabled: boolean }>(
        `select m.*, p.health_state, p.enabled as provider_enabled
           from models m
           join providers p on p.id = m.provider_id
          ${opts.enabledOnly ? "where m.enabled = true and p.enabled = true" : ""}
          order by m.local desc, m.display_name`,
      );
      return rows.map((r) => toModel(r, r.health_state));
    } catch (err) {
      throw dbError(err, "listing models");
    }
  }

  async get(id: string): Promise<ModelWithSource | null> {
    try {
      const { rows } = await this.pool.query<ModelRow & { health_state: HealthState }>(
        `select m.*, p.health_state from models m join providers p on p.id = m.provider_id where m.id = $1`,
        [id],
      );
      return rows[0] ? toModel(rows[0], rows[0].health_state) : null;
    } catch (err) {
      throw dbError(err, "reading model");
    }
  }

  /**
   * Discovery upsert. Deliberately does NOT overwrite `enabled` or any field a
   * user has hand-edited (traits_source = 'user') — re-running discovery must
   * not silently undo the user's configuration (spec §99).
   */
  async upsertDiscovered(input: UpsertModelInput): Promise<void> {
    try {
      await this.pool.query(
        `insert into models
           (id, provider_id, model_identifier, display_name, context_window, max_output_tokens,
            input_cost_per_1m, output_cost_per_1m, capabilities, scores, local, traits_source, last_seen_at)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12, now())
         on conflict (provider_id, model_identifier) do update set
           display_name       = case when models.traits_source = 'user' then models.display_name       else excluded.display_name end,
           context_window     = case when models.traits_source = 'user' then models.context_window     else excluded.context_window end,
           max_output_tokens  = case when models.traits_source = 'user' then models.max_output_tokens  else excluded.max_output_tokens end,
           input_cost_per_1m  = case when models.traits_source = 'user' then models.input_cost_per_1m  else excluded.input_cost_per_1m end,
           output_cost_per_1m = case when models.traits_source = 'user' then models.output_cost_per_1m else excluded.output_cost_per_1m end,
           capabilities       = case when models.traits_source = 'user' then models.capabilities       else excluded.capabilities end,
           scores             = case when models.traits_source = 'user' then models.scores             else excluded.scores end,
           local              = excluded.local,
           last_seen_at       = now()`,
        [
          input.id,
          input.providerId,
          input.modelIdentifier,
          input.displayName,
          input.contextWindow,
          input.maxOutputTokens,
          input.inputCostPer1m,
          input.outputCostPer1m,
          JSON.stringify(input.capabilities),
          JSON.stringify(input.scores),
          input.local,
          input.traitsSource,
        ],
      );
    } catch (err) {
      throw dbError(err, "saving discovered model");
    }
  }

  async setEnabled(id: string, enabled: boolean): Promise<boolean> {
    try {
      const res = await this.pool.query("update models set enabled = $2 where id = $1", [id, enabled]);
      return (res.rowCount ?? 0) > 0;
    } catch (err) {
      throw dbError(err, "updating model");
    }
  }

  /** Removes models a provider no longer reports, so a deleted Ollama tag disappears. */
  async pruneMissing(providerId: string, seenIdentifiers: string[]): Promise<number> {
    try {
      const res = await this.pool.query(
        `delete from models where provider_id = $1 and not (model_identifier = any($2::text[]))`,
        [providerId, seenIdentifiers],
      );
      return res.rowCount ?? 0;
    } catch (err) {
      throw dbError(err, "pruning stale models");
    }
  }
}

// ---------------------------------------------------------------------------
// Conversations, messages, runs
// ---------------------------------------------------------------------------

export interface ConversationSummary {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messageCount: number;
}

export class ConversationRepo {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async create(title: string): Promise<string> {
    const id = randomUUID();
    try {
      await this.pool.query("insert into conversations (id, title) values ($1, $2)", [id, title]);
      return id;
    } catch (err) {
      throw dbError(err, "creating conversation");
    }
  }

  async exists(id: string): Promise<boolean> {
    try {
      const { rows } = await this.pool.query("select 1 from conversations where id = $1", [id]);
      return rows.length > 0;
    } catch (err) {
      throw dbError(err, "checking conversation");
    }
  }

  async list(limit = 50): Promise<ConversationSummary[]> {
    try {
      const { rows } = await this.pool.query<{
        id: string; title: string; created_at: Date; updated_at: Date; message_count: number;
      }>(
        `select c.id, c.title, c.created_at, c.updated_at,
                (select count(*) from messages m where m.conversation_id = c.id) as message_count
           from conversations c order by c.updated_at desc limit $1`,
        [limit],
      );
      return rows.map((r) => ({
        id: r.id,
        title: r.title,
        createdAt: r.created_at.toISOString(),
        updatedAt: r.updated_at.toISOString(),
        messageCount: Number(r.message_count),
      }));
    } catch (err) {
      throw dbError(err, "listing conversations");
    }
  }

  async messages(conversationId: string, limit = 200): Promise<Array<ChatMessage & { id: string; modelId: string | null; createdAt: string }>> {
    try {
      const { rows } = await this.pool.query<{
        id: string; role: Role; content: string; model_id: string | null; created_at: Date;
      }>(
        `select id, role, content, model_id, created_at from messages
          where conversation_id = $1 order by created_at asc limit $2`,
        [conversationId, limit],
      );
      return rows.map((r) => ({
        id: r.id,
        role: r.role,
        content: r.content,
        modelId: r.model_id,
        createdAt: r.created_at.toISOString(),
      }));
    } catch (err) {
      throw dbError(err, "reading messages");
    }
  }

  async addMessage(conversationId: string, role: Role, content: string, modelId: string | null): Promise<string> {
    const id = randomUUID();
    try {
      await this.pool.query(
        "insert into messages (id, conversation_id, role, content, model_id) values ($1,$2,$3,$4,$5)",
        [id, conversationId, role, content, modelId],
      );
      await this.pool.query("update conversations set updated_at = now() where id = $1", [conversationId]);
      return id;
    } catch (err) {
      throw dbError(err, "saving message");
    }
  }

  /**
   * Deletes a conversation and its messages.
   *
   * model_runs keeps its rows — conversation_id is ON DELETE SET NULL — so
   * deleting a conversation never rewrites spend history or the performance
   * measurements derived from it. Removing a chat should not change what NYRO
   * knows about how fast a model is, or how much you have spent this month.
   */
  async delete(conversationId: string): Promise<boolean> {
    try {
      const res = await this.pool.query("delete from conversations where id = $1", [conversationId]);
      return (res.rowCount ?? 0) > 0;
    } catch (err) {
      throw dbError(err, "deleting conversation");
    }
  }

  async setTitle(conversationId: string, title: string): Promise<void> {
    try {
      await this.pool.query("update conversations set title = $2 where id = $1", [conversationId, title]);
    } catch (err) {
      throw dbError(err, "setting conversation title");
    }
  }
}

export interface RecordRunInput {
  conversationId: string | null;
  modelId: string;
  providerId: string;
  routingMode: string;
  attemptIndex: number;
  ok: boolean;
  errorCode: string | null;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export class RunRepo {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async record(input: RecordRunInput): Promise<void> {
    try {
      await this.pool.query(
        `insert into model_runs
           (id, conversation_id, model_id, provider_id, routing_mode, attempt_index,
            ok, error_code, latency_ms, input_tokens, output_tokens, cost_usd)
         values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
        [
          randomUUID(),
          input.conversationId,
          input.modelId,
          input.providerId,
          input.routingMode,
          input.attemptIndex,
          input.ok,
          input.errorCode,
          input.latencyMs,
          input.inputTokens,
          input.outputTokens,
          input.costUsd,
        ],
      );
    } catch (err) {
      throw dbError(err, "recording model run");
    }
  }

  /**
   * Observed performance per model, for measured routing (spec §102).
   *
   * Median rather than mean, so one cold start or one network stall does not
   * define a model's reputation. Throughput rather than latency, because a
   * longer answer legitimately takes longer and ranking on wall-clock would
   * bias routing toward whichever model got the short prompts.
   *
   * Cancellations are excluded from both the throughput sample and the success
   * rate: the user stopping a response says nothing about the model.
   */
  async performance(sinceDays = 30): Promise<Array<{
    modelId: string; medianTokensPerSecond: number; successRate: number; samples: number;
  }>> {
    try {
      const { rows } = await this.pool.query<{
        model_id: string; median_tps: number | null; ok_count: number; attempt_count: number;
      }>(
        `select
           model_id,
           percentile_cont(0.5) within group (
             order by output_tokens::numeric / (latency_ms::numeric / 1000)
           ) filter (where ok and output_tokens > 0 and latency_ms > 0) as median_tps,
           count(*) filter (where ok)::int as ok_count,
           count(*) filter (where error_code is distinct from 'cancelled')::int as attempt_count
         from model_runs
        where created_at > now() - ($1 || ' days')::interval
        group by model_id`,
        [String(sinceDays)],
      );
      return rows
        .filter((r) => r.median_tps !== null && r.attempt_count > 0)
        .map((r) => ({
          modelId: r.model_id,
          medianTokensPerSecond: Number(r.median_tps),
          successRate: r.ok_count / r.attempt_count,
          samples: r.ok_count,
        }));
    } catch (err) {
      throw dbError(err, "computing model performance");
    }
  }
  /**
   * Money actually spent, by period and by provider.
   *
   * Uses date_trunc rather than a rolling window, so "daily" means the calendar
   * day the user is living in — which is what a person means by a daily budget.
   * Computed in Postgres so it stays correct as rows accumulate.
   */
  async spend(): Promise<{
    dayUsd: number; weekUsd: number; monthUsd: number; perProviderMonthUsd: Record<string, number>;
  }> {
    try {
      const totals = await this.pool.query<{ day: number; week: number; month: number }>(
        `select
           coalesce(sum(cost_usd) filter (where created_at >= date_trunc('day',   now())), 0) as day,
           coalesce(sum(cost_usd) filter (where created_at >= date_trunc('week',  now())), 0) as week,
           coalesce(sum(cost_usd) filter (where created_at >= date_trunc('month', now())), 0) as month
         from model_runs`,
      );
      const perProvider = await this.pool.query<{ provider_id: string; cost: number }>(
        `select provider_id, coalesce(sum(cost_usd), 0) as cost
           from model_runs
          where created_at >= date_trunc('month', now())
          group by provider_id`,
      );
      const row = totals.rows[0]!;
      const perProviderMonthUsd: Record<string, number> = {};
      for (const r of perProvider.rows) perProviderMonthUsd[r.provider_id] = Number(r.cost);
      return {
        dayUsd: Number(row.day),
        weekUsd: Number(row.week),
        monthUsd: Number(row.month),
        perProviderMonthUsd,
      };
    } catch (err) {
      throw dbError(err, "computing spend");
    }
  }
  /**
   * Aggregates for the Health / cost panels (spec §66, §71).
   *
   * A user pressing Stop is NOT a model failure. Counting it as one would
   * misreport provider reliability and, once the router learns from history
   * (spec §102), would train it to avoid models the user simply interrupted.
   * Cancellations are therefore counted separately, and latency averages
   * ignore them because a cancelled call says nothing about how fast the
   * model is.
   */
  async stats(sinceHours = 24): Promise<{
    totalRuns: number; failedRuns: number; cancelledRuns: number; totalCostUsd: number; avgLatencyMs: number;
    perModel: Array<{ modelId: string; runs: number; failures: number; cancelled: number; avgLatencyMs: number; costUsd: number }>;
  }> {
    try {
      const since = `${sinceHours} hours`;
      const overall = await this.pool.query<{ total: number; failed: number; cancelled: number; cost: number; avg_latency: number }>(
        `select count(*)::int as total,
                count(*) filter (where not ok and error_code is distinct from 'cancelled')::int as failed,
                count(*) filter (where error_code = 'cancelled')::int as cancelled,
                coalesce(sum(cost_usd),0) as cost,
                coalesce(avg(latency_ms) filter (where ok), 0) as avg_latency
           from model_runs where created_at > now() - $1::interval`,
        [since],
      );
      const per = await this.pool.query<{ model_id: string; runs: number; failures: number; cancelled: number; avg_latency: number; cost: number }>(
        `select model_id,
                count(*)::int as runs,
                count(*) filter (where not ok and error_code is distinct from 'cancelled')::int as failures,
                count(*) filter (where error_code = 'cancelled')::int as cancelled,
                coalesce(avg(latency_ms) filter (where ok), 0) as avg_latency,
                coalesce(sum(cost_usd),0) as cost
           from model_runs where created_at > now() - $1::interval
          group by model_id order by runs desc limit 50`,
        [since],
      );
      const o = overall.rows[0]!;
      return {
        totalRuns: o.total,
        failedRuns: o.failed,
        cancelledRuns: o.cancelled,
        totalCostUsd: Number(o.cost),
        avgLatencyMs: Math.round(Number(o.avg_latency)),
        perModel: per.rows.map((r) => ({
          modelId: r.model_id,
          runs: r.runs,
          failures: r.failures,
          cancelled: r.cancelled,
          avgLatencyMs: Math.round(Number(r.avg_latency)),
          costUsd: Number(r.cost),
        })),
      };
    } catch (err) {
      throw dbError(err, "computing run stats");
    }
  }
}

// ---------------------------------------------------------------------------
// Settings (spec §64) — small typed key/value documents
// ---------------------------------------------------------------------------

/**
 * A JSON document store for user configuration.
 *
 * Deliberately not a column-per-setting table: settings are read as whole
 * documents by the code that owns them, and each owner validates its own shape
 * with zod. Adding a setting is then a schema change in one file, not a
 * migration.
 */
export class SettingsRepo {
  private readonly pool: Pool;

  constructor(pool: Pool) {
    this.pool = pool;
  }

  async get<T>(key: string): Promise<T | null> {
    try {
      const { rows } = await this.pool.query<{ value: T }>("select value from settings where key = $1", [key]);
      return rows[0] ? rows[0].value : null;
    } catch (err) {
      throw dbError(err, `reading setting "${key}"`);
    }
  }

  async set<T>(key: string, value: T): Promise<void> {
    try {
      await this.pool.query(
        `insert into settings (key, value, updated_at) values ($1, $2, now())
         on conflict (key) do update set value = excluded.value, updated_at = now()`,
        [key, JSON.stringify(value)],
      );
    } catch (err) {
      throw dbError(err, `saving setting "${key}"`);
    }
  }
}
