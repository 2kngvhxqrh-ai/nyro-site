/**
 * Secret redaction (spec §68, §120).
 *
 * Applied to everything that reaches a log sink or an API response. This is a
 * safety net, not a licence to pass secrets around: the primary rule is that
 * decrypted keys live only inside a provider adapter's request headers.
 */

const SENSITIVE_KEY_RE = /(api[-_]?key|authorization|auth|token|secret|password|passwd|credential|bearer|cookie)/i;

/** Known key shapes, so a leaked literal is caught even in a free-text field. */
const SECRET_VALUE_PATTERNS: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}\b/g,        // OpenAI-style
  /\bsk-ant-[A-Za-z0-9_-]{16,}\b/g,    // Anthropic
  /\bgsk_[A-Za-z0-9]{20,}\b/g,         // Groq
  /\bxai-[A-Za-z0-9]{20,}\b/g,         // xAI
  /\bAIza[A-Za-z0-9_-]{30,}\b/g,       // Google
  /\bBearer\s+[A-Za-z0-9._-]{16,}/gi,
];

export const REDACTED = "[redacted]";

export function redactString(input: string): string {
  let out = input;
  for (const re of SECRET_VALUE_PATTERNS) out = out.replace(re, REDACTED);
  return out;
}

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 8) return "[depth-limit]";
  if (typeof value === "string") return redactString(value);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Error) return redactString(`${value.name}: ${value.message}`);

  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SENSITIVE_KEY_RE.test(k) ? REDACTED : redact(v, depth + 1);
  }
  return out;
}
