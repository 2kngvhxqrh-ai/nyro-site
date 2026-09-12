/**
 * A ~90-line router over node:http.
 *
 * Express would add a dependency tree to solve a problem this size (spec §116).
 * If middleware needs grow past this, that is the moment to reconsider — not now.
 */
import type { IncomingMessage, ServerResponse } from "node:http";

export interface RequestContext {
  req: IncomingMessage;
  res: ServerResponse;
  params: Record<string, string>;
  query: URLSearchParams;
  url: URL;
}

export type Handler = (ctx: RequestContext) => Promise<void> | void;

interface Route {
  method: string;
  segments: string[];
  handler: Handler;
}

export class HttpRouter {
  private routes: Route[] = [];

  add(method: string, pattern: string, handler: Handler): this {
    this.routes.push({
      method: method.toUpperCase(),
      segments: pattern.split("/").filter((s) => s.length > 0),
      handler,
    });
    return this;
  }

  get(p: string, h: Handler) { return this.add("GET", p, h); }
  post(p: string, h: Handler) { return this.add("POST", p, h); }
  put(p: string, h: Handler) { return this.add("PUT", p, h); }
  delete(p: string, h: Handler) { return this.add("DELETE", p, h); }

  match(method: string, pathname: string): { handler: Handler; params: Record<string, string> } | null {
    const parts = pathname.split("/").filter((s) => s.length > 0);
    for (const route of this.routes) {
      if (route.method !== method.toUpperCase()) continue;
      if (route.segments.length !== parts.length) continue;

      const params: Record<string, string> = {};
      let ok = true;
      for (let i = 0; i < route.segments.length; i++) {
        const seg = route.segments[i]!;
        const part = parts[i]!;
        if (seg.startsWith(":")) params[seg.slice(1)] = decodeURIComponent(part);
        else if (seg !== part) { ok = false; break; }
      }
      if (ok) return { handler: route.handler, params };
    }
    return null;
  }
}

/** Bounded body read — an unbounded one is a trivial memory DoS (spec §69). */
export async function readJsonBody(req: IncomingMessage, maxBytes = 1_000_000): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > maxBytes) throw new Error(`Request body exceeds ${maxBytes} bytes.`);
    chunks.push(buf);
  }
  if (total === 0) return {};
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Request body is not valid JSON.");
  }
}

export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "cache-control": "no-store",
  });
  res.end(payload);
}
