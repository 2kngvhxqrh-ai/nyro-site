/**
 * Custom instructions — a standing system prompt (spec §26).
 *
 * The chat API has always accepted a `systemPrompt` per request, and nothing
 * could set one: every request sent null. This makes that field reachable, and
 * gives it somewhere to live between requests.
 *
 * Kept separate from the routing rules document because it is a different kind
 * of thing: a rule steers WHICH model answers, an instruction steers WHAT the
 * chosen model is told. Merging them would make "clear my instructions" also
 * mean "clear my routing".
 *
 * DELIBERATELY ZOD-FREE. The browser demo bundles this file for the resolution
 * rule below, and importing the validator here pulled 50 kB of zod into a page
 * that has no request bodies to validate. The stored document's schema lives
 * next door in instructions-schema.ts.
 */

export interface Instructions {
  /**
   * Off by default. Instructions that apply the moment they are typed, before
   * the user has decided they want them, are a surprising way to change every
   * answer NYRO gives.
   */
  enabled: boolean;
  text: string;
}

export const DEFAULT_INSTRUCTIONS: Instructions = { enabled: false, text: "" };

/**
 * The system prompt a request actually gets, or null for none.
 *
 * A request that supplies its own systemPrompt REPLACES the stored
 * instructions rather than appending to them. Appending would mean a caller
 * could never send a bare prompt, and "replace" is the rule a reader can hold
 * in their head — concatenation order, separators and precedence are three
 * more things to get wrong.
 *
 * Pure, so the rule can be tested without a database.
 */
export function resolveSystemPrompt(stored: Instructions, requested: string | null): string | null {
  if (requested !== null) {
    const trimmed = requested.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (!stored.enabled) return null;
  const trimmed = stored.text.trim();
  return trimmed.length > 0 ? trimmed : null;
}
