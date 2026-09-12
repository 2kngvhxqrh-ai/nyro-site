/**
 * Static serving tests.
 *
 * The traversal cases are the point. NYRO's .env holds the master key that
 * decrypts every provider API key, so a static server that can be walked out
 * of with "../" is a credential disclosure, not a cosmetic bug.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "net";
import { resolveWithinRoot, serveStatic } from "../src/http/static.ts";

let rootDir: string;
let parentDir: string;
let server: Server;
let baseUrl: string;

before(async () => {
  parentDir = await mkdtemp(join(tmpdir(), "nyro-static-"));
  rootDir = join(parentDir, "public");
  await mkdir(join(rootDir, "assets"), { recursive: true });

  await writeFile(join(rootDir, "index.html"), "<div id=root></div>");
  await writeFile(join(rootDir, "assets", "index-ABCDEF12.js"), "console.log(1)");
  await writeFile(join(rootDir, "assets", "app.css"), "body{}");
  // A secret OUTSIDE the served root — exactly what traversal would target.
  await writeFile(join(parentDir, ".env"), "NYRO_SECRET_KEY=super-secret-value");

  server = createServer((req, res) => {
    void serveStatic(rootDir, new URL(req.url ?? "/", "http://x").pathname, res).then((r) => {
      if (!r.served) {
        res.writeHead(404, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "not found" }));
      }
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((r) => server.close(() => r()));
  await rm(parentDir, { recursive: true, force: true });
});

describe("path traversal is refused", () => {
  const escapes = [
    "/../.env",
    "/../../etc/passwd",
    "/assets/../../.env",
    "/%2e%2e/.env",
    "/%2e%2e%2f.env",
    "/..%2f.env",
    "/....//.env",
    "/assets/%2e%2e%2f%2e%2e%2f.env",
  ];

  for (const p of escapes) {
    test(`refuses ${p}`, () => {
      const resolved = resolveWithinRoot(rootDir, p);
      if (resolved !== null) {
        assert.ok(
          resolved.startsWith(resolve(rootDir)),
          `"${p}" resolved outside the root: ${resolved}`,
        );
      }
    });
  }

  test("no traversal request ever returns the secret file over HTTP", async () => {
    for (const p of escapes) {
      const res = await fetch(`${baseUrl}${p}`);
      const body = await res.text();
      assert.ok(!body.includes("super-secret-value"), `"${p}" leaked .env contents`);
    }
  });

  test("a NUL byte in the path is refused", () => {
    assert.equal(resolveWithinRoot(rootDir, "/index.html\0.png"), null);
  });

  test("malformed percent-encoding is refused rather than throwing", () => {
    assert.equal(resolveWithinRoot(rootDir, "/%E0%A4%A"), null);
  });

  test("a sibling directory sharing the root's prefix is not reachable", () => {
    // "/tmp/x/public-secrets" must not pass a naive startsWith("/tmp/x/public").
    const sneaky = resolveWithinRoot(rootDir, "/../public-secrets/key.txt");
    assert.ok(sneaky === null || sneaky.startsWith(resolve(rootDir) + "/"));
  });
});

describe("serving real files", () => {
  test("serves index.html at the root", async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/html/);
    assert.match(await res.text(), /id=root/);
  });

  test("serves an asset with the right content type", async () => {
    const res = await fetch(`${baseUrl}/assets/app.css`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /text\/css/);
  });

  test("hashed assets are cached immutably; index.html is not", async () => {
    const asset = await fetch(`${baseUrl}/assets/index-ABCDEF12.js`);
    assert.match(asset.headers.get("cache-control") ?? "", /immutable/);
    const index = await fetch(`${baseUrl}/`);
    assert.match(index.headers.get("cache-control") ?? "", /no-cache/);
  });

  test("sets nosniff", async () => {
    const res = await fetch(`${baseUrl}/assets/app.css`);
    assert.equal(res.headers.get("x-content-type-options"), "nosniff");
  });

  test("an extensionless path falls back to index.html so client routes work", async () => {
    const res = await fetch(`${baseUrl}/models`);
    assert.equal(res.status, 200);
    assert.match(await res.text(), /id=root/);
  });

  test("a missing asset with an extension is NOT masked by the SPA fallback", async () => {
    // Returning index.html for a missing .js is how "unexpected token <"
    // debugging sessions start.
    const res = await fetch(`${baseUrl}/assets/missing.js`);
    assert.equal(res.status, 404);
  });

  test("/api paths are never served statically", async () => {
    const res = await fetch(`${baseUrl}/api/health`);
    assert.equal(res.status, 404);
    assert.match(await res.text(), /not found/i);
  });
});
