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
  message: z.string().min(1, "message must not be empty").max(500_000),
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

export const updateModelSchema = z.object({
  enabled: z.boolean(),
});

export const createConversationSchema = z.object({
  title: z.string().min(1).max(200).default("New conversation"),
});
