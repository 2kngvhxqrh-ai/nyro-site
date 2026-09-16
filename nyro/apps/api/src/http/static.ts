/**
 * Static file serving for the built web app.
 *
 * When NYRO_STATIC_DIR is set, the API serves the UI itself. That makes the
 * whole system one process on one origin: no second server, no dev proxy, and
 * no CORS — the browser's requests to /api are same-origin by construction.
 *
 * Security note: this resolves every request path against the root and refuses
 * anything that escapes it. A static server that can be walked out of with
 * "../" hands over the entire filesystem, including .env.
 */
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";
import type { ServerResponse } from "node:http";

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".ico": "image/x-icon",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".map": "application/json; charset=utf-8",
};

export interface StaticResult {
  served: boolean;
}

/**
 * Resolves a URL path to a real file inside `root`, or null if it escapes.
 * Returning null rather than throwing keeps traversal attempts from being
 * distinguishable from ordinary 404s.
 */
export function resolveWithinRoot(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null; // malformed percent-encoding
  }
  // A NUL byte can truncate a path in some syscalls; reject outright.
  if (decoded.includes("\0")) return null;

  const rootAbs = resolve(root);
  const candidate = resolve(join(rootAbs, normalize(decoded)));

  // Must be the root itself or strictly inside it. The separator check stops
  // "/srv/app-secrets" from passing a naive startsWith("/srv/app").
  if (candidate !== rootAbs && !candidate.startsWith(rootAbs + sep)) return null;
  return candidate;
}

/**
 * Second containment check, after symlinks are resolved.
 *
 * `resolveWithinRoot` works on the path string, which is enough for "../" but
 * not for a symlink *inside* the root pointing outward — that path never
 * contains "..", so string resolution accepts it. NYRO_STATIC_DIR is
 * user-configurable, so the served directory is not guaranteed to be a
 * symlink-free build output.
 *
 * Returns false when the file does not exist; the caller treats that as a miss.
 */
async function isRealPathWithinRoot(root: string, candidate: string): Promise<boolean> {
  try {
    // The root may itself sit under a symlink (/tmp on macOS), so resolve both.
    const [realRoot, realCandidate] = await Promise.all([realpath(root), realpath(candidate)]);
    return realCandidate === realRoot || realCandidate.startsWith(realRoot + sep);
  } catch {
    return false;
  }
}

async function sendFile(res: ServerResponse, filePath: string, status = 200): Promise<boolean> {
  let info;
  try {
    info = await stat(filePath);
  } catch {
    return false;
  }
  if (!info.isFile()) return false;

  const type = TYPES[extname(filePath).toLowerCase()] ?? "application/octet-stream";
  // Hashed asset filenames change on every build, so they can be cached hard.
  // index.html must not be, or a deploy would not reach an open browser.
  const immutable = /-[A-Za-z0-9_]{8,}\.(js|css)$/.test(filePath);

  res.writeHead(status, {
    "content-type": type,
    "content-length": info.size,
    "cache-control": immutable ? "public, max-age=31536000, immutable" : "no-cache",
    // The UI is same-origin only; nothing should frame it.
    "x-content-type-options": "nosniff",
  });
  createReadStream(filePath).pipe(res);
  return true;
}

/**
 * Serves a static asset, falling back to index.html so client-side routes work.
 * Returns { served: false } when the request should be handled elsewhere.
 */
export async function serveStatic(root: string, urlPath: string, res: ServerResponse): Promise<StaticResult> {
  // /api is never static; the caller routes it first, but be explicit.
  if (urlPath.startsWith("/api/")) return { served: false };

  const direct = resolveWithinRoot(root, urlPath === "/" ? "/index.html" : urlPath);
  if (direct === null) {
    // Traversal attempt: answer exactly like a miss.
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return { served: true };
  }

  if ((await isRealPathWithinRoot(root, direct)) && (await sendFile(res, direct))) {
    return { served: true };
  }

  // SPA fallback for a path with no file extension (a client-side route).
  if (extname(urlPath) === "") {
    const index = resolveWithinRoot(root, "/index.html");
    if (index && (await isRealPathWithinRoot(root, index)) && (await sendFile(res, index))) {
      return { served: true };
    }
  }

  return { served: false };
}
