/**
 * Error taxonomy (spec §79: never hide errors).
 *
 * Every failure carries a machine code, a user-safe message, and a
 * retryability flag the fallback executor uses to decide whether trying a
 * different model could plausibly help.
 */

export type NyroErrorCode =
  | "provider_unreachable"
  | "provider_auth"
  | "provider_rate_limited"
  | "provider_bad_response"
  | "provider_timeout"
  | "model_not_found"
  | "context_too_large"
  | "no_eligible_model"
  | "privacy_violation"
  | "cost_limit_exceeded"
  | "cancelled"
  | "bad_request"
  | "config_error"
  | "db_error"
  | "internal";

/** Codes where retrying on a *different* model is worth doing. */
const RETRYABLE_ON_ANOTHER_MODEL = new Set<NyroErrorCode>([
  "provider_unreachable",
  "provider_auth",
  "provider_rate_limited",
  "provider_bad_response",
  "provider_timeout",
  "model_not_found",
  "context_too_large",
]);

export class NyroError extends Error {
  readonly code: NyroErrorCode;
  readonly component: string;
  readonly detail: string | undefined;
  readonly timestamp: string;

  constructor(code: NyroErrorCode, message: string, opts: { component: string; detail?: string; cause?: unknown } ) {
    super(message, { cause: opts.cause });
    this.name = "NyroError";
    this.code = code;
    this.component = opts.component;
    this.detail = opts.detail;
    this.timestamp = new Date().toISOString();
  }

  get retryable(): boolean {
    return RETRYABLE_ON_ANOTHER_MODEL.has(this.code);
  }

  /** Shape sent to clients. Never includes `detail` — that is for server logs. */
  toPublic(): { error: { code: NyroErrorCode; message: string; component: string; retryable: boolean; timestamp: string } } {
    return {
      error: {
        code: this.code,
        message: this.message,
        component: this.component,
        retryable: this.retryable,
        timestamp: this.timestamp,
      },
    };
  }

  static from(err: unknown, component: string): NyroError {
    if (err instanceof NyroError) return err;
    if (err instanceof Error && err.name === "AbortError") {
      return new NyroError("cancelled", "Request was cancelled.", { component, cause: err });
    }
    const msg = err instanceof Error ? err.message : String(err);
    return new NyroError("internal", "An unexpected internal error occurred.", { component, detail: msg, cause: err });
  }
}

export function httpStatusFor(code: NyroErrorCode): number {
  switch (code) {
    case "bad_request":
    case "context_too_large":
      return 400;
    case "provider_auth":
      return 502;
    case "model_not_found":
      return 404;
    case "no_eligible_model":
    case "privacy_violation":
    case "cost_limit_exceeded":
      return 409;
    case "provider_rate_limited":
      return 429;
    case "cancelled":
      return 499;
    case "provider_unreachable":
    case "provider_timeout":
    case "provider_bad_response":
      return 502;
    default:
      return 500;
  }
}
