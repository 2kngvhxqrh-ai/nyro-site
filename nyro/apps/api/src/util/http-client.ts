/**
 * One place where NYRO talks HTTP to a model provider.
 *
 * Centralised so timeout, cancellation, and error classification behave
 * identically for every adapter — if Groq starts returning 429s, every adapter
 * already maps that to `provider_rate_limited` without new code.
 */
import { NyroError, type NyroErrorCode } from "../core/errors.ts";

export interface ProviderRequest {
  url: string;
  method?: "GET" | "POST";
  headers?: Record<string, string>;
  body?: unknown;
  timeoutMs: number;
  signal?: AbortSignal;
  /** Used only for error messages and logs. */
  component: string;
}

function classify(status: number): NyroErrorCode {
  if (status === 401 || status === 403) return "provider_auth";
  if (status === 404) return "model_not_found";
  if (status === 408 || status === 504) return "provider_timeout";
  if (status === 429) return "provider_rate_limited";
  if (status === 413 || status === 422) return "context_too_large";
  return "provider_bad_response";
}

/** Truncated so a huge HTML error page cannot blow up a log line. */
async function readErrorBody(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 600);
  } catch {
    return "<unreadable body>";
  }
}

export async function providerFetch(req: ProviderRequest): Promise<Response> {
  const timeout = AbortSignal.timeout(req.timeoutMs);
  const signal = req.signal ? AbortSignal.any([req.signal, timeout]) : timeout;

  let res: Response;
  try {
    res = await fetch(req.url, {
      method: req.method ?? "GET",
      headers: {
        "content-type": "application/json",
        ...(req.headers ?? {}),
      },
      body: req.body === undefined ? undefined : JSON.stringify(req.body),
      signal,
    });
  } catch (cause) {
    // The caller's own signal firing is a cancellation; the timeout is not.
    if (req.signal?.aborted) {
      throw new NyroError("cancelled", "Request was cancelled.", { component: req.component, cause });
    }
    if (timeout.aborted) {
      throw new NyroError("provider_timeout", `Provider did not respond within ${req.timeoutMs}ms.`, {
        component: req.component,
        cause,
      });
    }
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new NyroError("provider_unreachable", `Could not reach provider at ${safeOrigin(req.url)}.`, {
      component: req.component,
      detail,
      cause,
    });
  }

  if (!res.ok) {
    const code = classify(res.status);
    const body = await readErrorBody(res);
    throw new NyroError(code, `Provider returned HTTP ${res.status}.`, {
      component: req.component,
      detail: body,
    });
  }
  return res;
}

/** Origin only — never echo a URL that might carry a key in its query string. */
export function safeOrigin(url: string): string {
  try {
    return new URL(url).origin;
  } catch {
    return "<invalid url>";
  }
}

/**
 * Yields complete lines from a byte stream, handling chunk boundaries.
 *
 * Cancellation contract: when `signal` aborts, the underlying fetch body throws
 * an AbortError mid-iteration. That is an expected terminal state, not a
 * failure, so it is swallowed here and iteration simply ends. Adapters then
 * check `signal.aborted` after the loop and emit a `done: cancelled` chunk.
 * This keeps cancellation identical across every transport — without it,
 * aborting an Ollama stream and an OpenAI stream would behave differently.
 */
export async function* readLines(res: Response, signal?: AbortSignal): AsyncGenerator<string> {
  if (!res.body) return;
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for await (const chunk of res.body) {
      buffer += decoder.decode(chunk as Uint8Array, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, "");
        buffer = buffer.slice(nl + 1);
        if (line.length > 0) yield line;
      }
    }
  } catch (err) {
    // Only the caller's own cancellation is swallowed; a genuine transport
    // failure (reset connection, truncated body) must still surface.
    if (signal?.aborted) return;
    throw err;
  }
  buffer += decoder.decode();
  const tail = buffer.trim();
  if (tail.length > 0) yield tail;
}
