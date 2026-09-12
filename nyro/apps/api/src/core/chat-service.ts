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
import type { ConversationRepo } from "../db/repos.ts";
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

export class ChatService {
  private readonly registry: Registry;
  private readonly conversations: ConversationRepo;
  private readonly executor: Executor;
  private readonly bus: EventBus;

  constructor(registry: Registry, conversations: ConversationRepo, executor: Executor, bus: EventBus) {
    this.registry = registry;
    this.conversations = conversations;
    this.executor = executor;
    this.bus = bus;
  }

  async plan(input: ChatInput, history: ChatMessage[]): Promise<{ decision: RoutingDecision; messages: ChatMessage[] }> {
    const models = await this.registry.routableModels();

    const messages: ChatMessage[] = [];
    if (input.systemPrompt) messages.push({ role: "system", content: input.systemPrompt });
    messages.push(...history);
    messages.push({ role: "user", content: input.message });

    const estimatedInputTokens = estimateMessagesTokens(messages);
    const req: RoutingRequest = {
      mode: input.mode,
      requestedModelId: input.modelId,
      requestedProviderId: input.providerId,
      // "chat" is the one genuine requirement for a chat turn; everything the
      // keyword pass guessed is a preference.
      requiredCapabilities: [...new Set<Capability>(["chat", ...input.requiredCapabilities])],
      preferredCapabilities: inferPreferredCapabilities(input.message),
      privacy: input.privacy,
      estimatedInputTokens,
      // Used only for cost ceilings and context headroom, never billed.
      estimatedOutputTokens: 800,
      maxCostUsd: input.maxCostUsd,
    };

    return { decision: route(models, req), messages };
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

    const stored = await this.conversations.messages(conversationId);
    const history: ChatMessage[] = stored
      .slice(-HISTORY_TURNS)
      .map((m) => ({ role: m.role, content: m.content }));

    const { decision, messages } = await this.plan(input, history);
    callbacks.onRouted?.(decision);
    this.bus.emit({
      type: "router.decided",
      mode: decision.mode,
      chosenModelId: decision.candidates[0]?.model.id ?? null,
      candidateCount: decision.candidates.length,
      rejectedCount: decision.rejected.length,
    });

    // The user turn is saved before execution so a crash mid-answer does not
    // lose what the user typed (spec §141, §142).
    await this.conversations.addMessage(conversationId, "user", input.message, null);

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
