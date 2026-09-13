/**
 * Validation for the stored instructions document.
 *
 * Split from instructions.ts so the demo can bundle the resolution rule
 * without bundling zod — see the note there.
 */
import { z } from "zod";
import type { Instructions } from "./instructions.ts";

export const instructionsSchema: z.ZodType<Instructions, z.ZodTypeDef, unknown> = z.object({
  enabled: z.boolean().default(false),
  // Matches the per-request systemPrompt ceiling; a larger one would be
  // accepted here and rejected there.
  text: z.string().max(50_000).default(""),
});
