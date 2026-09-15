/**
 * The README's capability table must cite suites that exist.
 *
 * It used to grade each row "working" or "working, tested", which
 * distinguished nothing — every row was tested, so the weaker label was
 * misinformation in the cautious direction. Each row now names the suite that
 * covers it, which is a stronger claim and therefore needs checking: I had
 * already written `executor` into the pull request description, and there has
 * never been an `executor` suite in this repository.
 *
 * A citation nobody verifies is indistinguishable from one that is invented.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";

const README = new URL("../../../README.md", import.meta.url).pathname;
const API_TESTS = new URL("./", import.meta.url).pathname;
const WEB_TESTS = new URL("../../web/test/", import.meta.url).pathname;

async function suiteNames(): Promise<Set<string>> {
  const names = new Set<string>();
  for (const dir of [API_TESTS, WEB_TESTS]) {
    for (const f of await readdir(dir)) {
      // `markdown.test.ts` is the "markdown" suite; `ui.browser.ts` is
      // "ui.browser", because the browser suite is deliberately not a
      // `.test.ts` (pnpm test must not glob a suite that needs Chromium).
      if (f.endsWith(".test.ts")) names.add(f.slice(0, -".test.ts".length));
      else if (f.endsWith(".ts")) names.add(f.slice(0, -".ts".length));
    }
  }
  return names;
}

describe("the README capability table", () => {
  test("every suite it cites is a suite that exists", async () => {
    const rows = (await readFile(README, "utf8"))
      .split("\n")
      .filter((l) => l.startsWith("| ") && l.endsWith(" |") && !l.startsWith("| Capability") && !l.startsWith("|---"));
    assert.ok(rows.length > 15, `expected the capability table, found ${rows.length} rows`);

    const available = await suiteNames();
    const missing: string[] = [];
    for (const row of rows) {
      const cited = row.split("|")[2]!.trim();
      for (const name of cited.split(",").map((s) => s.trim()).filter(Boolean)) {
        if (!available.has(name)) missing.push(`${name} (cited by "${row.split("|")[1]!.trim().slice(0, 44)}")`);
      }
    }
    assert.deepEqual(
      missing, [],
      `the README cites suites that do not exist: ${missing.join("; ")}. ` +
        `Available: ${[...available].sort().join(", ")}.`,
    );
  });
});
