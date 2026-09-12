/**
 * Server-Sent Events (spec §78).
 *
 * SSE rather than WebSockets: the Phase 1 traffic is server→client only, and
 * SSE reconnects and proxies without extra machinery. A WebSocket earns its
 * place when the client needs to push mid-stream — not yet (spec §116).
 */
import type { ServerResponse } from "node:http";

export type SseEvent =
  /** Which model was chosen and why — shown in the UI, never chain-of-thought. */
  | { type: "routing"; data: unknown }
  /** A fallback attempt started. */
  | { type: "attempt"; data: { modelId: string; attemptIndex: number; isFallback: boolean } }
  | { type: "delta"; data: { text: string } }
  | { type: "usage"; data: { inputTokens: number; outputTokens: number; costUsd: number } }
  | { type: "done"; data: { conversationId: string; modelId: string; latencyMs: number } }
  | { type: "error"; data: unknown };

export class SseStream {
  private readonly res: ServerResponse;
  private closed = false;
  private readonly keepAlive: NodeJS.Timeout;

  constructor(res: ServerResponse) {
    this.res = res;
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      // Tells nginx and friends not to buffer, which would defeat streaming.
      "x-accel-buffering": "no",
    });
    // A comment line every 15s so idle proxies do not drop the connection.
    this.keepAlive = setInterval(() => {
      if (!this.closed) this.res.write(": keep-alive\n\n");
    }, 15_000);
    this.keepAlive.unref?.();
  }

  send(event: SseEvent): void {
    if (this.closed) return;
    // Multi-line payloads must repeat the `data:` prefix; JSON has no raw
    // newlines, so one line is always correct here.
    this.res.write(`event: ${event.type}\ndata: ${JSON.stringify(event.data)}\n\n`);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.keepAlive);
    this.res.end();
  }

  get isClosed(): boolean {
    return this.closed;
  }
}
