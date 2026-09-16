/**
 * Every method on the API client must be called by something.
 *
 * Three bugs in a row came from the same shape: a capability built and
 * documented on the server, wired all the way into `api.ts`, and reached by no
 * component. `systemPrompt` was accepted by /api/chat since Phase 1 and always
 * sent as null. `/api/route/preview` — the one view that makes a router
 * legible — sat unused for the entire project. Neither was broken; both were
 * invisible, which is worse, because nothing fails and nobody looks.
 *
 * A dead client method is the cheapest possible detector for that shape, so
 * this test fails when one appears. If a method is genuinely for external
 * callers rather than this UI, it does not belong in the browser's client.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const SRC = new URL("../src/", import.meta.url).pathname;

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await filesUnder(full)));
    else if (/\.(ts|tsx)$/.test(entry.name)) out.push(full);
  }
  return out;
}

describe("the API client has no dead methods", () => {
  test("every method on `api` is called somewhere in apps/web/src", async () => {
    const clientPath = join(SRC, "api.ts");
    const client = await readFile(clientPath, "utf8");

    const start = client.indexOf("export const api = {");
    assert.notEqual(start, -1, "could not find the exported `api` object");
    const end = client.indexOf("\n};", start);
    assert.notEqual(end, -1, "could not find the end of the `api` object");

    const methods = [...new Set([...client.slice(start, end).matchAll(/^ {2}([a-zA-Z][a-zA-Z0-9]*):/gm)].map((m) => m[1]!))];
    assert.ok(methods.length > 10, `only found ${methods.length} methods; the parse is probably wrong`);

    const others = (await filesUnder(SRC)).filter((f) => f !== clientPath);
    const callers = (await Promise.all(others.map((f) => readFile(f, "utf8")))).join("\n");

    const dead = methods.filter((m) => {
      // `api\n  .previewRoute(...)` is the same call as `api.previewRoute(...)`;
      // a naive `api.<name>` search misses it and passes a dead method.
      const used = new RegExp(String.raw`\bapi\s*\.\s*${m}\b`).test(callers);
      return !used;
    });

    assert.deepEqual(
      dead,
      [],
      `these API client methods are called by nothing: ${dead.join(", ")}. ` +
        `Either wire them into the UI or take them out of the browser's client.`,
    );
  });
});
