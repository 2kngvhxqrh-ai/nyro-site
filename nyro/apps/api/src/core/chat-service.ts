/**
 * The Core entry point the API layer calls.
 *
 * This is the whole Phase 1 flow in one place:
 *   request -> load history -> classify -> route -> execute (with fallback)
 *           -> persist -> report
 *
 * Intent classification, agents, tools and memory retrieval are later phases.
 * The seam for them is `buildRoutingRequest`: today it derives capabilities
 * from explicit request fields plus a cheap keyword pass; in Phase 5 a CEO
 * agent produces the same structure. Nothing downstream changes.
 */
import type { ConversationRepo, RunRepo, SettingsRepo } from "../db/repos.ts";
import { buildPerformanceIndex } from "./performance.ts";
import {
  DEFAULT_ROUTING_RULES,
  preferencesFor,
  routingRulesSchema,
  type RoutingRules,
} from "./routing-rules.ts";
import { DEFAULT_INSTRUCTIONS, resolveSystemPrompt, type Instructions } from "./instructions.ts";
import { instructionsSchema } from "./instructions-schema.ts";
import {
  budgetConfigSchema,
  DEFAULT_BUDGET,
  evaluateBudget,
  exhaustedProviders,
  type BudgetConfig,
  type BudgetVerdict,
} from "./budget.ts";
import type { EventBus } from "./events.ts";
import { NyroError } from "./errors.ts";
import { Executor } from "./executor.ts";
import type { Registry } from "./registry.ts";
import { route } from "./router.ts";
import { estimateMessagesTokens } from "../util/tokens.ts";
import type {
  Capability,
  ChatMessage,
  ExecutionOutcome,
  PrivacyClass,
  RoutingDecision,
  RoutingMode,
  RoutingRequest,
} from "./types.ts";

export interface ChatInput {
  conversationId: string | null;
  message: string;
  /**
   * Re-answer the last turn instead of adding a new one (spec §58, §103).
   *
   * The prompt comes from the stored conversation rather than from `message`,
   * so a regenerate cannot silently change what was asked — and the user turn
   * is never re-inserted, so it cannot be duplicated.
   */
  regenerate?: boolean;
  mode: RoutingMode;
  privacy: PrivacyClass;
  modelId: string | null;
  providerId: string | null;
  systemPrompt: string | null;
  temperature: number | null;
  maxCostUsd: number | null;
  requiredCapabilities: Capability[];
}

export interface ChatCallbacks {
  /** Fired when a spending limit constrains the request, so the UI can say so. */
  onBudget?: (verdict: BudgetVerdict) => void;
  onRouted?: (decision: RoutingDecision) => void;
  onDelta?: (text: string) => void;
  onAttempt?: (info: { modelId: string; attemptIndex: number; isFallback: boolean }) => void;
}

/**
 * Cheap keyword pass so "write me a function" prefers a coding model without a
 * round-trip to a classifier.
 *
 * These are PREFERENCES, never requirements. A guess about intent must not be
 * able to make NYRO refuse a request: if the only model available is a small
 * local one, answering with it beats saying "no eligible model". Capabilities
 * the CALLER states explicitly are treated as hard requirements instead.
 *
 * A real classifier arrives with the CEO agent in Phase 5 (spec §15, §130).
 */
function inferPreferredCapabilities(message: string): Capability[] {
  const caps = new Set<Capability>();
  if (/\b(code|function|refactor|debug|typescript|python|sql|stack ?trace|compile)\b/i.test(message)) {
    caps.add("coding");
  }
  if (/\b(analyse|analyze|why|explain|compare|trade-?off|design|architect|prove)\b/i.test(message)) {
    caps.add("reasoning");
  }
  return [...caps];
}

/** How many recent turns to send. Real context management lands in Phase 3 (spec §128). */
const HISTORY_TURNS = 20;

/** Where the budget document lives in the settings table. */
export const BUDGET_SETTINGS_KEY = "budget";
/** Where the user's task-specific routing rules live (spec §10). */
export const ROUTING_RULES_SETTINGS_KEY = "routing_rules";
/** Whether measured performance may override the registry's guessed scores. */
export const LEARNING_SETTINGS_KEY = "measured_routing";
/** Where the user's standing system prompt lives (spec §26). */
export const INSTRUCTIONS_SETTINGS_KEY = "instructions";

export class ChatService {
  private readonly registry: Registry;
  private readonly conversations: ConversationRepo;
  private readonly executor: Executor;
  private readonly bus: EventBus;
  private readonly settings: SettingsRepo;
  private readonly runs: RunRepo;

  constructor(
    registry: Registry,
    conversations: ConversationRepo,
    executor: Executor,
    bus: EventBus,
    settings: SettingsRepo,
    runs: RunRepo,
  ) {
    this.registry = registry;
    this.conversations = conversations;
    this.executor = executor;
    this.bus = bus;
    this.settings = settings;
    this.runs = runs;
  }

  /** Stored budget, falling back to the unlimited default. */
  async budgetConfig(): Promise<BudgetConfig> {
    const raw = await this.settings.get<unknown>(BUDGET_SETTINGS_KEY);
    if (raw === null) return DEFAULT_BUDGET;
    const parsed = budgetConfigSchema.safeParse(raw);
    // A malformed stored document must not take NYRO down, and must not
    // silently become "no limit" either — fall back to the default and let the
    // Settings UI show what is actually stored.
    return parsed.success ? parsed.data : DEFAULT_BUDGET;
  }

  /**
   * Whether measured routing is on. Defaults to ON: measurements are strictly
   * better evidence than a guess from a model's name, and the UI always says
   * when a score is measured. §147 is satisfied by the switch existing, not by
   * defaulting to the weaker data.
   */
  async measuredRoutingEnabled(): Promise<boolean> {
    const raw = await this.settings.get<{ enabled?: boolean }>(LEARNING_SETTINGS_KEY);
    return raw?.enabled !== false;
  }

  /** Stored routing rules, falling back to none. */
  async routingRules(): Promise<RoutingRules> {
    const raw = await this.settings.get<unknown>(ROUTING_RULES_SETTINGS_KEY);
    if (raw === null) return DEFAULT_ROUTING_RULES;
    const parsed = routingRulesSchema.safeParse(raw);
    return parsed.success ? parsed.data : DEFAULT_ROUTING_RULES;
  }

  /** The user's standing instructions, falling back to none. */
  async instructions(): Promise<Instructions> {
    const raw = await this.settings.get<unknown>(INSTRUCTIONS_SETTINGS_KEY);
    if (raw === null) return DEFAULT_INSTRUCTIONS;
    const parsed = instructionsSchema.safeParse(raw);
    return parsed.success ? parsed.data : DEFAULT_INSTRUCTIONS;
  }

  async plan(
    input: ChatInput,
    history: ChatMessage[],
  ): Promise<{ decision: RoutingDecision; messages: ChatMessage[]; budget: BudgetVerdict }> {
    const models = await this.registry.routableModels();

    // Budget is evaluated BEFORE routing, because its verdict changes what the
    // router is allowed to consider — not after, when the money is spent.
    const config = await this.budgetConfig();
    const spend = await this.runs.spend();
    const budget = evaluateBudget(config, spend, { privacy: input.privacy, mode: input.mode });
    const { rules } = await this.routingRules();

    // Measured performance, when there is enough of it to beat a guess.
    const observed = (await this.measuredRoutingEnabled())
      ? buildPerformanceIndex(await this.runs.performance())
      : undefined;

    const messages: ChatMessage[] = [];
    // Resolved here rather than at the HTTP edge so that every caller of
    // plan() -- chat, stream and the routing preview -- sizes the SAME prompt.
    // A preview that ignored standing instructions would report a token count
    // and a candidate list the real request then contradicts.
    const systemPrompt = resolveSystemPrompt(await this.instructions(), input.systemPrompt);
    if (systemPrompt) messages.push({ role: "system", content: systemPrompt });
    messages.push(...history);
    messages.push({ role: "user", content: input.message });

    const estimatedInputTokens = estimateMessagesTokens(messages);

    // force_local narrows the request rather than rejecting it: NYRO stays
    // useful on free local models once the paid budget is gone (spec §184).
    const effectivePrivacy = budget.action === "force_local" ? "local_only" : input.privacy;

    // A per-request ceiling can come from the caller or the budget; the tighter
    // of the two wins, so neither can be used to escape the other.
    const ceilings = [input.maxCostUsd, budget.maxCostUsd].filter((v): v is number => v !== null && v !== undefined);
    const maxCostUsd = ceilings.length > 0 ? Math.min(...ceilings) : null;

    const requiredCapabilities = [...new Set<Capability>(["chat", ...input.requiredCapabilities])];
    const preferredCapabilities = inferPreferredCapabilities(input.message);

    const req: RoutingRequest = {
      mode: input.mode,
      // Rules see everything the request wants, stated or inferred, so
      // "this looks like coding" is enough to fire a coding rule.
      preferences: preferencesFor(rules, [...requiredCapabilities, ...preferredCapabilities]),
      requestedModelId: input.modelId,
      requestedProviderId: input.providerId,
      excludedProviderIds: exhaustedProviders(config, spend),
      ...(observed ? { observed } : {}),
      // "chat" is the one genuine requirement for a chat turn; everything the
      // keyword pass guessed is a preference.
      requiredCapabilities,
      preferredCapabilities,
      privacy: effectivePrivacy,
      estimatedInputTokens,
      // Used only for cost ceilings and context headroom, never billed.
      estimatedOutputTokens: 800,
      maxCostUsd,
    };

    return { decision: route(models, req), messages, budget };
  }

  async send(
    input: ChatInput,
    callbacks: ChatCallbacks,
    signal?: AbortSignal,
  ): Promise<ExecutionOutcome & { conversationId: string }> {
    const conversationId =
      input.conversationId ?? (await this.conversations.create(titleFromMessage(input.message)));

    if (input.conversationId && !(await this.conversations.exists(input.conversationId))) {
      throw new NyroError("bad_request", `Conversation ${input.conversationId} does not exist.`, {
        component: "chat-service",
      });
    }

    this.bus.emit({ type: "chat.started", conversationId });

    // A regenerate rewinds first: the trailing answer is dropped and the
    // existing user turn becomes the prompt.
    let effectiveInput = input;
    if (input.regenerate) {
      if (!input.conversationId) {
        throw new NyroError("bad_request", "Nothing to regenerate: this conversation has not started yet.", {
          component: "chat-service",
        });
      }
      const prepared = await this.conversations.prepareRegenerate(conversationId);
      if (!prepared) {
        throw new NyroError("bad_request", "Nothing to regenerate in this conversation.", {
          component: "chat-service",
        });
      }
      effectiveInput = { ...input, message: prepared.prompt };
    }

    const stored = await this.conversations.messages(conversationId);
    // On a regenerate the prompt is already the last stored message, so it must
    // not also be appended as history — that would send it twice.
    const historySource = input.regenerate ? stored.slice(0, -1) : stored;
    const history: ChatMessage[] = historySource
      .slice(-HISTORY_TURNS)
      .map((m) => ({ role: m.role, content: m.content }));

    const { decision, messages, budget } = await this.plan(effectiveInput, history);

    if (budget.action === "block") {
      throw new NyroError("cost_limit_exceeded", budget.message ?? "A spending limit has been reached.", {
        component: "chat-service",
      });
    }
    if (budget.message) callbacks.onBudget?.(budget);

    callbacks.onRouted?.(decision);
    this.bus.emit({
      type: "router.decided",
      mode: decision.mode,
      chosenModelId: decision.candidates[0]?.model.id ?? null,
      candidateCount: decision.candidates.length,
      rejectedCount: decision.rejected.length,
    });

    // The user turn is saved before execution so a crash mid-answer does not
    // lose what the user typed (spec §141, §142). On a regenerate it is already
    // there — re-adding it is the duplication bug this branch exists to avoid.
    if (!input.regenerate) {
      await this.conversations.addMessage(conversationId, "user", input.message, null);
    }

    try {
      const outcome = await this.executor.execute({
        decision,
        messages,
        conversationId,
        ...(input.temperature !== null ? { temperature: input.temperature } : {}),
        ...(signal ? { signal } : {}),
        ...(callbacks.onDelta ? { onDelta: callbacks.onDelta } : {}),
        ...(callbacks.onAttempt ? { onAttempt: callbacks.onAttempt } : {}),
      });

      await this.conversations.addMessage(conversationId, "assistant", outcome.content, outcome.model.id);
      this.bus.emit({ type: "chat.completed", conversationId, modelId: outcome.model.id });
      return { ...outcome, conversationId };
    } catch (err) {
      const e = NyroError.from(err, "chat-service");
      if (e.code === "cancelled") this.bus.emit({ type: "chat.cancelled", conversationId });
      throw e;
    }
  }
}

function titleFromMessage(message: string): string {
  const cleaned = message.replace(/\s+/g, " ").trim();
  if (cleaned.length === 0) return "New conversation";
  return cleaned.length <= 60 ? cleaned : `${cleaned.slice(0, 57)}…`;
}
