/**
 * Token estimation.
 *
 * NOT a tokenizer. This is a deliberate approximation used for routing
 * decisions and pre-flight cost ceilings, where being within ~25% is enough.
 * Actual billed usage always comes from the provider response and is what gets
 * persisted in model_runs. Do not use this for anything the user is charged on.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  // ~4 chars/token for English prose; nudged up for code-like density.
  const base = text.length / 4;
  const symbolRatio = (text.match(/[{}()<>[\];=+*/\\|_#]/g)?.length ?? 0) / text.length;
  return Math.ceil(base * (1 + symbolRatio));
}

export function estimateMessagesTokens(messages: Array<{ role: string; content: string }>): number {
  // +4 tokens/message is the usual allowance for role framing overhead.
  return messages.reduce((sum, m) => sum + estimateTokens(m.content) + 4, 0);
}
