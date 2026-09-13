/**
 * Input validation (spec §69).
 *
 * Every request body is parsed through zod before it reaches Core. Core's types
 * can then be trusted rather than defensively re-checked at each layer.
 */
import { z } from "zod";
import { CAPABILITIES, PRIVACY_CLASSES, ROUTING_MODES } from "../core/types.ts";
import { SUPPORTED_TRANSPORTS } from "../providers/index.ts";

export const chatRequestSchema = z.object({
  // A regenerate takes its prompt from the stored conversation, so the caller
  // has nothing meaningful to send here.
  message: z.string().max(500_000).default(""),
  /** Re-answer the last turn rather than adding a new one (spec §58, §103). */
  regenerate: z.boolean().default(false),
  conversationId: z.string().uuid().nullable().default(null),
  mode: z.enum(ROUTING_MODES).default("auto"),
  privacy: z.enum(PRIVACY_CLASSES).default("normal"),
  /** Explicit override, e.g. "ollama:llama3.2:1b" (spec §148). */
  modelId: z.string().min(1).nullable().default(null),
  providerId: z.string().min(1).nullable().default(null),
  systemPrompt: z.string().max(50_000).nullable().default(null),
  temperature: z.number().min(0).max(2).nullable().default(null),
  maxCostUsd: z.number().min(0).nullable().default(null),
  requiredCapabilities: z.array(z.enum(CAPABILITIES)).default([]),
});

export type ChatRequestInput = z.infer<typeof chatRequestSchema>;

/** A normal turn still needs a message; only a regenerate may omit one. */
export const chatRequestRefined = chatRequestSchema.refine(
  (v) => v.regenerate || v.message.trim().length > 0,
  { message: "message must not be empty", path: ["message"] },
);

/** Provider ids become part of model ids, so keep them URL- and id-safe. */
const providerIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z0-9][a-z0-9_-]*$/, "id must be lowercase letters, digits, hyphen or underscore");

export const upsertProviderSchema = z.object({
  id: providerIdSchema,
  displayName: z.string().min(1).max(120),
  presetKey: z.string().min(1).max(64),
  transport: z.enum(SUPPORTED_TRANSPORTS as [string, ...string[]]),
  baseUrl: z.string().max(500).default(""),
  /** Omit to keep the stored key; null clears it; a string replaces it. */
  apiKey: z.string().max(500).nullable().optional(),
  local: z.boolean().default(false),
  enabled: z.boolean().default(true),
  requestTimeoutMs: z.number().int().min(1_000).max(600_000).default(120_000),
  extra: z.record(z.string()).default({}),
});

/**
 * Every field is optional: this is a patch, and omitting a field must leave it
 * alone rather than reset it. Supplying any trait marks the model as
 * user-edited so discovery stops overwriting it.
 */
export const updateModelSchema = z.object({
  enabled: z.boolean().optional(),
  displayName: z.string().min(1).max(200).optional(),
  contextWindow: z.number().int().min(256).max(20_000_000).optional(),
  maxOutputTokens: z.number().int().min(16).max(1_000_000).optional(),
  // Costs are per 1M tokens. Zero is legitimate (local models are free).
  inputCostPer1m: z.number().min(0).max(100_000).optional(),
  outputCostPer1m: z.number().min(0).max(100_000).optional(),
  capabilities: z.array(z.enum(CAPABILITIES)).optional(),
  scores: z
    .object({
      speed: z.number().min(0).max(10),
      reasoning: z.number().min(0).max(10),
      coding: z.number().min(0).max(10),
      vision: z.number().min(0).max(10),
      tool_calling: z.number().min(0).max(10),
    })
    .optional(),
});

export const createConversationSchema = z.object({
  title: z.string().min(1).max(200).default("New conversation"),
});
