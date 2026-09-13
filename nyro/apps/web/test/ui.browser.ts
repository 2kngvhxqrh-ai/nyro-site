/**
 * UI checks in a real browser.
 *
 * These exist because a whole class of user-visible bug had no coverage at all,
 * and shipped: at 390px the app rendered 544px wide and was clipped on both
 * edges — half the wordmark gone, the routing preview cut mid-word — while
 * `document.scrollWidth` still equalled the viewport, so nothing reported an
 * overflow. Three separate causes, none of which any unit test could see.
 *
 * The API is stubbed rather than run, so this needs no database and no
 * provider. The fixtures are chosen to REPRODUCE the bugs: a very long
 * conversation title, because `truncate` means `white-space: nowrap`, which
 * means a grid item's min-content width is the entire untruncated title; and a
 * long provider health detail, because that string is arbitrary text from the
 * provider's own health check.
 *
 * NAMED `.browser.ts`, not `.test.ts`, on purpose: `pnpm test` globs
 * `test/*.test.ts`, and a suite that needs a 130MB browser does not belong in
 * the command a contributor runs by reflex. Run it with `pnpm test:ui`.
 * CI runs both, so the coverage is real rather than optional.
 */
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { extname, join, normalize } from "node:path";
import type { AddressInfo } from "node:net";
import { chromium, type Browser, type Page } from "playwright";

const DIST = new URL("../dist/", import.meta.url).pathname;

if (!existsSync(join(DIST, "index.html"))) {
  throw new Error("apps/web/dist is missing. Run `pnpm --filter @nyro/web build` first.");
}
// `pnpm test:ui` builds before running for a reason: this suite reads dist/,
// so a stale build silently tests code that is no longer there. It happened
// once already — a copy fix looked like a failing assertion.

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".woff2": "font/woff2",
  ".svg": "image/svg+xml",
};

/** A long title is the point: it is what made the whole app 544px wide. */
const LONG_TITLE =
  "How do I refactor this TypeScript function so that it streams instead of buffering the entire file in memory?";

const FIXTURES: Record<string, unknown> = {
  "/api/health": {
    state: "healthy",
    checkedAt: "2026-01-01T00:00:00.000Z",
    components: [
      { name: "nyro-core", state: "healthy", detail: "running", latencyMs: null },
      { name: "database", state: "healthy", detail: "postgres reachable", latencyMs: 4 },
      {
        name: "provider:ollama",
        state: "degraded",
        // Arbitrary text from the provider's own health check — this is what
        // pushed the latency value off the side of the app.
        detail: "2 model(s) available but the last probe took longer than expected to answer",
        latencyMs: 1234,
      },
    ],
  },
  "/api/providers": {
    providers: [
      {
        id: "ollama", displayName: "Ollama", presetKey: "ollama", transport: "ollama",
        baseUrl: "http://127.0.0.1:11434", hasApiKey: false, apiKeyHint: null, local: true, enabled: true,
        health: { state: "healthy", detail: "ok", latencyMs: 4, checkedAt: "2026-01-01T00:00:00.000Z" },
      },
    ],
  },
  "/api/providers/presets": { presets: [] },
  "/api/models": {
    models: [
      {
        id: "ollama:qwen2.5-coder:7b", displayName: "qwen2.5-coder:7b", providerId: "ollama",
        modelIdentifier: "qwen2.5-coder:7b", contextWindow: 32768, maxOutputTokens: 4096,
        inputCostPer1m: 0, outputCostPer1m: 0, capabilities: ["chat", "coding"],
        scores: { speed: 6, reasoning: 5, coding: 7, vision: 0, tool_calling: 0 },
        local: true, enabled: true, health: "healthy", traitsSource: "catalog",
      },
    ],
  },
  "/api/stats": {
    totalRuns: 12, failedRuns: 1, cancelledRuns: 2, totalCostUsd: 0.0131, avgLatencyMs: 820,
    perModel: [
      { modelId: "ollama:qwen2.5-coder:7b", runs: 12, failures: 1, cancelled: 2, avgLatencyMs: 820, costUsd: 0.0131 },
    ],
  },
  // Enough rows that the list genuinely overflows its 40vh cap on a phone —
  // with two, a broken scroll region looks identical to a working one.
  "/api/conversations": {
    conversations: Array.from({ length: 25 }, (_, i) => ({
      id: `${String(i).padStart(8, "0")}-1111-4111-8111-111111111111`,
      title: i === 0 ? LONG_TITLE : `Conversation ${i}`,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      messageCount: 2,
    })),
  },
  "/api/instructions": { enabled: false, text: "" },
  "/api/budget": {
    config: { dailyUsd: null, weeklyUsd: null, monthlyUsd: null, perRequestUsd: null, perProviderMonthlyUsd: {}, onExceeded: "local_only" },
    spend: { dayUsd: 0, weekUsd: 0, monthUsd: 0, perProviderMonthUsd: {} },
    status: { action: "allow", message: null, breaches: [] },
    remaining: { dayUsd: null, weekUsd: null, monthUsd: null },
  },
  "/api/performance": {
    enabled: true, minSamples: 5,
    models: [
      { modelId: "ollama:qwen2.5-coder:7b", medianTokensPerSecond: 84.2, successRate: 0.98, samples: 25, measuredSpeedScore: 7.8, inUse: true },
    ],
  },
  "/api/routing-rules": { rules: [] },
};

let server: Server;
let browser: Browser;
let baseUrl: string;

before(async () => {
  server = createServer(async (req, res) => {
    const path = (req.url ?? "/").split("?")[0]!;
    const rel = normalize(path === "/" ? "/index.html" : path).replace(/^(\.\.[/\\])+/, "");
    try {
      const body = await readFile(join(DIST, rel));
      res.writeHead(200, { "content-type": TYPES[extname(rel)] ?? "application/octet-stream" });
      res.end(body);
    } catch {
      res.writeHead(404, {});
      res.end("not found");
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;

  // A browser that exists but does not match the installed Playwright is a
  // real situation (this repo's dev container has one). Say which, rather than
  // skipping and reporting green.
  const explicit = process.env["NYRO_CHROMIUM"];
  try {
    browser = await chromium.launch(explicit ? { executablePath: explicit } : {});
  } catch (err) {
    throw new Error(
      `Could not launch Chromium for the layout tests: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}\n` +
        "Install one with `pnpm exec playwright install chromium`, or point NYRO_CHROMIUM at an existing binary.",
    );
  }
});

after(async () => {
  await browser?.close();
  await new Promise<void>((r) => server?.close(() => r()));
});

async function open(width: number, overrides: Record<string, unknown> = {}): Promise<Page> {
  const page = await browser.newPage({ viewport: { width, height: 844 } });
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const body = path in overrides ? overrides[path] : (FIXTURES[path] ?? {});
    await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(body) });
  });
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  await page.waitForTimeout(300);
  return page;
}

/**
 * Content that is CLIPPED — not merely off-screen.
 *
 * The distinction is the whole point: a wide table inside `overflow-x: auto`
 * extends past its box on purpose and you scroll to reach it. The same table
 * inside `overflow: hidden`, or inside a box that cannot scroll at all, has
 * columns nobody can ever see. Only the second is a bug, and an earlier
 * version of this probe reported both.
 */
async function clipped(page: Page): Promise<Array<{ tag: string; cls: string; text: string }>> {
  return page.evaluate(() => {
    const out: Array<{ tag: string; cls: string; text: string }> = [];
    for (const el of document.body.querySelectorAll("*")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0) continue;

      for (let e = el.parentElement; e; e = e.parentElement) {
        const ox = getComputedStyle(e).overflowX;
        if (ox === "visible") continue;
        // Reachable: this ancestor scrolls, so the content is not lost.
        if (ox === "auto" || ox === "scroll") break;
        // clientLeft is the box's own left border; without it every child of a
        // bordered element reads as 1px over, which is the probe being wrong.
        const limit = e.getBoundingClientRect().left + e.clientLeft + e.clientWidth;
        if (r.right > limit + 0.5) {
          out.push({
            tag: el.tagName.toLowerCase(),
            cls: String((el as HTMLElement).className || "").split(/\s+/).slice(0, 4).join(" "),
            text: (el.textContent ?? "").trim().slice(0, 40),
          });
        }
        break;
      }
    }
    return out;
  });
}

const WIDTHS = [360, 390, 768, 1440];
const TABS = ["Chat", "Models", "Health", "Settings"] as const;

describe("the app never scrolls sideways", () => {
  for (const width of WIDTHS) {
    test(`no horizontal overflow at ${width}px, on every tab`, async () => {
      const page = await open(width);
      try {
        for (const tab of TABS) {
          await page.getByRole("button", { name: tab, exact: true }).click();
          await page.waitForTimeout(350);

          const m = await page.evaluate(() => {
            const main = document.querySelector("main")!;
            return {
              doc: document.documentElement.scrollWidth - window.innerWidth,
              // `main` scrolling sideways drags the header and tab bar with it.
              main: main.scrollWidth - main.clientWidth,
            };
          });
          assert.equal(m.doc, 0, `${tab} at ${width}px: the page scrolls sideways by ${m.doc}px`);
          assert.equal(m.main, 0, `${tab} at ${width}px: the content area scrolls sideways by ${m.main}px`);

          const out = await clipped(page);
          assert.deepEqual(
            out, [],
            `${tab} at ${width}px: ${out.length} element(s) clipped with no way to scroll to them: ` +
              out.map((o) => `${o.tag}.${o.cls} ("${o.text}")`).join("; "),
          );
        }
      } finally {
        await page.close();
      }
    });
  }
});

describe("a long conversation title cannot resize the app", () => {
  test("the sidebar truncates instead of setting the layout width", async () => {
    // The exact bug: a grid item defaults to min-width:auto and `truncate`
    // means white-space:nowrap, so the longest title became the app's width.
    const page = await open(390);
    try {
      const m = await page.evaluate(() => {
        const aside = document.querySelector("aside")!;
        return { asideWidth: aside.getBoundingClientRect().width, win: window.innerWidth };
      });
      assert.ok(
        m.asideWidth <= m.win,
        `the conversation list is ${Math.round(m.asideWidth)}px wide in a ${m.win}px viewport`,
      );
    } finally {
      await page.close();
    }
  });

  test("the list stays inside its box instead of painting over the chat", async () => {
    // It had no height, so `flex-1 overflow-y-auto` never bounded anything and
    // the rows rendered on top of the chat column below.
    const page = await open(390);
    try {
      const m = await page.evaluate(() => {
        const aside = document.querySelector("aside")!;
        const wrap = aside.parentElement!;
        return {
          overshoot: aside.getBoundingClientRect().bottom - wrap.getBoundingClientRect().bottom,
          scrolls: (() => {
            const list = aside.querySelector("div.overflow-y-auto");
            return list ? list.scrollHeight > list.clientHeight : false;
          })(),
        };
      });
      assert.ok(m.overshoot <= 1, `the conversation list hangs ${Math.round(m.overshoot)}px below its container`);
      assert.equal(m.scrolls, true, "the list is not scrollable, so long histories are unreachable");
    } finally {
      await page.close();
    }
  });
});

describe("wide tables scroll inside themselves", () => {
  test("every over-wide table has its own scroller, not the page", async () => {
    const page = await open(390);
    try {
      for (const tab of ["Models", "Health", "Settings"]) {
        await page.getByRole("button", { name: tab, exact: true }).click();
        await page.waitForTimeout(350);
        const bad = await page.evaluate(() => {
          const out: string[] = [];
          for (const t of document.querySelectorAll("table")) {
            const parent = t.parentElement!;
            if (t.getBoundingClientRect().width <= parent.clientWidth + 1) continue;
            const ox = getComputedStyle(parent).overflowX;
            if (ox !== "auto" && ox !== "scroll") out.push(t.parentElement!.className || "(table parent)");
          }
          return out;
        });
        assert.deepEqual(bad, [], `${tab}: a table wider than its parent has no horizontal scroller`);
      }
    } finally {
      await page.close();
    }
  });
});

describe("the first run, before any provider works", () => {
  /** A fresh install: the bootstrapped provider exists and is unreachable. */
  const NOTHING_WORKS = {
    "/api/models": { models: [] },
    "/api/conversations": { conversations: [] },
    "/api/route/preview": {
      estimatedInputTokens: 7,
      // No candidates AND nothing rejected: nothing was even considered.
      decision: { mode: "auto", chosen: null, fallbacks: [], rejected: [] },
      budget: { action: "allow", message: null, breaches: [] },
    },
  };

  test("says to add a provider, not to relax privacy", async () => {
    // The advice used to be "relax privacy or the model pin" in both cases,
    // which on a fresh install sends you to fix a problem you do not have.
    const page = await open(1440, NOTHING_WORKS);
    try {
      await page.getByPlaceholder(/Message NYRO/).fill("hello, is anyone there");
      await page.waitForTimeout(900);
      const text = await page.locator("main").innerText();
      assert.match(text, /No models are available yet\. Add a provider/);
      assert.doesNotMatch(text, /relax privacy/i);
    } finally {
      await page.close();
    }
  });

  test("but still says so when models exist and were all excluded", async () => {
    // The other half of the distinction: here there IS something to relax.
    const page = await open(1440, {
      "/api/conversations": { conversations: [] },
      "/api/route/preview": {
        estimatedInputTokens: 7,
        decision: {
          mode: "auto", chosen: null, fallbacks: [],
          rejected: [{ modelId: "openai:gpt-4o-mini", reason: "request is local-only and this model is not local" }],
        },
        budget: { action: "allow", message: null, breaches: [] },
      },
    });
    try {
      await page.getByPlaceholder(/Message NYRO/).fill("something private");
      await page.waitForTimeout(900);
      const text = await page.locator("main").innerText();
      assert.match(text, /Every available model was excluded/);
      assert.doesNotMatch(text, /Add a provider on the Models page and run discovery/);
    } finally {
      await page.close();
    }
  });

  test("an empty install still renders every tab without error", async () => {
    const page = await open(390, NOTHING_WORKS);
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    try {
      for (const tab of TABS) {
        await page.getByRole("button", { name: tab, exact: true }).click();
        await page.waitForTimeout(300);
        const out = await clipped(page);
        assert.deepEqual(out, [], `${tab} on a fresh install clips ${out.length} element(s)`);
      }
      assert.deepEqual(errors, []);
    } finally {
      await page.close();
    }
  });
});

describe("when the API goes away mid-session", () => {
  test("the page survives, says so, and offers a way back", async () => {
    // Realistic: you stop the server, or Postgres dies under it. The page is
    // already open and working when the API stops answering.
    const page = await open(1440);
    const pageErrors: string[] = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    try {
      await page.route("**/api/**", (route) => route.abort("connectionrefused"));

      await page.getByPlaceholder(/Message NYRO/).fill("does this fail gracefully");
      await page.waitForTimeout(900);
      await page.getByRole("button", { name: "Send" }).click();
      await page.waitForTimeout(1500);

      const chat = await page.locator("main").innerText();
      assert.doesNotMatch(chat, /Working…/, "the composer is stuck pretending a request is in flight");
      assert.match(chat, /Could not reach the NYRO API/, "the failure was not explained");

      // Settings sat on "Loading…" forever: the error was captured and an
      // early return rendered a placeholder in front of it.
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.waitForTimeout(900);
      const settings = await page.locator("main").innerText();
      assert.doesNotMatch(settings, /Loading…/, "Settings is stuck on a spinner in front of a known failure");
      assert.match(settings, /Could not load your spending limits/);
      assert.equal(await page.getByRole("button", { name: "Retry" }).count(), 1, "no way to retry");

      assert.deepEqual(pageErrors, [], "the outage threw in the page");
    } finally {
      await page.close();
    }
  });

  test("and recovers when it comes back", async () => {
    const page = await open(1440);
    try {
      // Keep a reference: unroute("**/api/**") with no handler removes EVERY
      // handler for that pattern, including the fixtures, so "the API came
      // back" would actually mean "the API is now a 404".
      const offline = (route: Parameters<Parameters<Page["route"]>[1]>[0]) => route.abort("connectionrefused");
      await page.route("**/api/**", offline);
      await page.getByRole("button", { name: "Settings", exact: true }).click();
      await page.waitForTimeout(900);
      assert.match(await page.locator("main").innerText(), /Could not load your spending limits/);

      await page.unroute("**/api/**", offline);
      await page.getByRole("button", { name: "Retry" }).click();
      await page.waitForTimeout(900);
      const after = await page.locator("main").innerText();
      assert.doesNotMatch(after, /Could not load your spending limits/, "Retry did not recover");
      // Case-insensitive: these headings are uppercased by CSS, and innerText
      // reports what is painted, not what is in the source.
      assert.match(after, /spent so far/i, "the panel did not come back");
      // The stale failure used to survive the reload and sit above the data.
      assert.doesNotMatch(after, /Failed to fetch/i, "a stale error survived a successful reload");
    } finally {
      await page.close();
    }
  });
});

describe("a transcript longer than one page", () => {
  test("says how many earlier messages are not shown", async () => {
    // A transcript that simply starts mid-conversation is indistinguishable
    // from one that began there. Worse, the version of this that returned the
    // OLDEST page made the transcript end early instead, which looks exactly
    // like a conversation you never continued.
    const messages = Array.from({ length: 200 }, (_, i) => ({
      id: `${String(i).padStart(8, "0")}-1111-4111-8111-111111111111`,
      role: i % 2 === 0 ? "user" : "assistant",
      content: i % 2 === 0 ? `question ${i}` : `answer ${i}`,
      modelId: i % 2 === 0 ? null : "ollama:llama3.2:1b",
      finishReason: null,
    }));
    const page = await open(1440, {
      "/api/conversations/00000000-1111-4111-8111-111111111111/messages": { messages, total: 260 },
    });
    try {
      await page.getByRole("button", { name: /How do I refactor/ }).first().click();
      await page.waitForTimeout(900);
      const text = await page.locator("main").innerText();
      assert.match(text, /60 earlier messages are not shown/);
      assert.match(text, /still stored/);
      // And the newest turn is the one at the bottom.
      assert.match(text, /answer 199/);
    } finally {
      await page.close();
    }
  });

  test("says nothing when the whole conversation fits", async () => {
    const messages = [
      { id: "a", role: "user", content: "short question", modelId: null, finishReason: null },
      { id: "b", role: "assistant", content: "short answer", modelId: "ollama:llama3.2:1b", finishReason: null },
    ];
    const page = await open(1440, {
      "/api/conversations/00000000-1111-4111-8111-111111111111/messages": { messages, total: 2 },
    });
    try {
      await page.getByRole("button", { name: /How do I refactor/ }).first().click();
      await page.waitForTimeout(900);
      assert.doesNotMatch(await page.locator("main").innerText(), /earlier message/);
    } finally {
      await page.close();
    }
  });
});

describe("a conversation list longer than one page", () => {
  test("says it is showing a page, and where the rest are", async () => {
    // The sidebar shows the 50 most recent. Without saying so, a user with
    // hundreds of conversations sees a list that looks like all of them.
    const page = await open(1440, { "/api/conversations": { ...(FIXTURES["/api/conversations"] as object), total: 412 } });
    try {
      const text = await page.locator("aside").innerText();
      assert.match(text, /Showing the 25 most recent of 412/);
      assert.match(text, /search finds them/i);
      assert.match(text, /export/i, "it does not say where to get the rest");
    } finally {
      await page.close();
    }
  });

  test("says nothing when the list is complete", async () => {
    const page = await open(1440);
    try {
      assert.doesNotMatch(await page.locator("aside").innerText(), /most recent of/);
    } finally {
      await page.close();
    }
  });
});

describe("search that matched more than it shows", () => {
  test("says these are the best matches, not all of them", async () => {
    const hits = Array.from({ length: 30 }, (_, i) => ({
      id: `${String(i).padStart(8, "0")}-1111-4111-8111-111111111111`,
      title: `match ${i}`,
      updatedAt: "2026-01-01T00:00:00.000Z",
      messageCount: 2,
      snippet: "a <b>match</b> in the text",
      matches: 1,
    }));
    const page = await open(1440, { "/api/search": { query: "match", results: hits, more: true } });
    try {
      await page.getByPlaceholder(/Search conversations/).fill("match");
      await page.waitForTimeout(900);
      const text = await page.locator("aside").innerText();
      assert.match(text, /best matches, not all of them/);
    } finally {
      await page.close();
    }
  });

  test("says nothing when the search fits", async () => {
    const page = await open(1440, {
      "/api/search": {
        query: "match",
        results: [{ id: "a", title: "only match", updatedAt: "2026-01-01T00:00:00.000Z", messageCount: 2, snippet: null, matches: 1 }],
        more: false,
      },
    });
    try {
      await page.getByPlaceholder(/Search conversations/).fill("match");
      await page.waitForTimeout(900);
      assert.doesNotMatch(await page.locator("aside").innerText(), /best matches/);
    } finally {
      await page.close();
    }
  });
});
