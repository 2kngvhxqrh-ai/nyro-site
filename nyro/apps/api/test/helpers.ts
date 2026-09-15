/**
 * Test helpers.
 *
 * `fakeUpstream` starts a REAL HTTP server that speaks a provider's wire
 * protocol. To be precise about what that proves: it exercises our adapter's
 * request shaping, SSE/NDJSON framing, chunk-boundary handling, usage parsing
 * and error mapping against a real socket. It does NOT prove that OpenAI or
 * Anthropic behave as documented — only a live key can do that, and the
 * SETUP doc says so.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface Upstream {
  url: string;
  close: () => Promise<void>;
  /** Requests the adapter actually made — lets a test assert on wire shape. */
  received: Array<{ method: string; path: string; headers: Record<string, string>; body: unknown }>;
}

export type UpstreamHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
  record: Upstream["received"],
) => void;

export async function fakeUpstream(handler: UpstreamHandler): Promise<Upstream> {
  const received: Upstream["received"] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      let body: unknown = {};
      if (raw.length > 0) {
        try { body = JSON.parse(raw); } catch { body = raw; }
      }
      received.push({
        method: req.method ?? "GET",
        path: req.url ?? "/",
        headers: req.headers as Record<string, string>,
        body,
      });
      handler(req, res, body, received);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

/** Writes SSE frames with a real delay so chunk boundaries are genuinely split. */
export async function writeSse(res: ServerResponse, frames: string[]): Promise<void> {
  res.writeHead(200, { "content-type": "text/event-stream" });
  for (const f of frames) {
    res.write(f);
    await new Promise((r) => setTimeout(r, 2));
  }
  res.end();
}

export async function collect<T>(iter: AsyncIterable<T>): Promise<T[]> {
  const out: T[] = [];
  for await (const item of iter) out.push(item);
  return out;
}
