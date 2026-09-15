/**
 * Budget tests (spec §66, §87).
 *
 * These protect the user's money. The two that matter most are the ones that
 * say a budget must NOT fire: refusing free local work because a paid budget
 * ran out would be a bug wearing a safeguard's clothes, and so would blocking
 * a whole account because one provider hit its own cap.
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_BUDGET,
  evaluateBudget,
  exhaustedProviders,
  budgetConfigSchema,
  type BudgetConfig,
  type SpendSnapshot,
} from "../src/core/budget.ts";

function cfg(over: Partial<BudgetConfig> = {}): BudgetConfig {
  return { ...DEFAULT_BUDGET, ...over };
}
function spend(over: Partial<SpendSnapshot> = {}): SpendSnapshot {
  return { dayUsd: 0, weekUsd: 0, monthUsd: 0, perProviderMonthUsd: {}, ...over };
}
const NORMAL = { privacy: "normal", mode: "auto" } as const;

describe("no budget configured", () => {
  test("the default allows everything", () => {
    const v = evaluateBudget(DEFAULT_BUDGET, spend({ dayUsd: 9999 }), NORMAL);
    assert.equal(v.action, "allow");
    assert.equal(v.breaches.length, 0);
    assert.equal(v.message, null);
  });

  test("a budget the user never set never blocks their work", () => {
    // Budgets are opt-in. An unconfigured NYRO must behave exactly as before.
    assert.equal(DEFAULT_BUDGET.dailyUsd, null);
    assert.equal(DEFAULT_BUDGET.monthlyUsd, null);
    assert.equal(evaluateBudget(DEFAULT_BUDGET, spend(), NORMAL).action, "allow");
  });
});

describe("period caps", () => {
  test("under the cap is allowed", () => {
    const v = evaluateBudget(cfg({ dailyUsd: 5 }), spend({ dayUsd: 4.99 }), NORMAL);
    assert.equal(v.action, "allow");
  });

  test("exactly at the cap counts as exhausted", () => {
    // Spending the last cent of a $5 budget means $5 is gone, not that one
    // more request is free.
    const v = evaluateBudget(cfg({ dailyUsd: 5 }), spend({ dayUsd: 5 }), NORMAL);
    assert.notEqual(v.action, "allow");
  });

  test("default behaviour degrades to local rather than stopping", () => {
    const v = evaluateBudget(cfg({ dailyUsd: 5 }), spend({ dayUsd: 6 }), NORMAL);
    assert.equal(v.action, "force_local");
    assert.match(v.message ?? "", /daily budget/);
  });

  test("block mode refuses and names the cap and the amounts", () => {
    const v = evaluateBudget(cfg({ dailyUsd: 5, onExceeded: "block" }), spend({ dayUsd: 6.5 }), NORMAL);
    assert.equal(v.action, "block");
    assert.match(v.message ?? "", /\$6\.50 of \$5\.00/);
  });

  test("sub-cent amounts stay distinguishable in the message", () => {
    // "$0.00 of $0.00" is what two-decimal formatting produces here, and it
    // tells the reader nothing about why their request was constrained.
    const v = evaluateBudget(
      cfg({ dailyUsd: 0.001, onExceeded: "block" }),
      spend({ dayUsd: 0.0037 }),
      NORMAL,
    );
    assert.ok(!/\$0\.00 of \$0\.00/.test(v.message ?? ""), `unreadable amounts: ${v.message}`);
    assert.match(v.message ?? "", /\$0\.0037/);
    assert.match(v.message ?? "", /\$0\.001/);
  });

  test("dollar amounts still read normally", () => {
    const v = evaluateBudget(cfg({ dailyUsd: 5, onExceeded: "block" }), spend({ dayUsd: 12.5 }), NORMAL);
    assert.match(v.message ?? "", /\$12\.50 of \$5\.00/);
  });

  test("weekly and monthly caps are enforced independently", () => {
    assert.equal(evaluateBudget(cfg({ weeklyUsd: 10 }), spend({ weekUsd: 10 }), NORMAL).action, "force_local");
    assert.equal(evaluateBudget(cfg({ monthlyUsd: 20 }), spend({ monthUsd: 25 }), NORMAL).action, "force_local");
  });

  test("every breached period is reported, not only the first", () => {
    const v = evaluateBudget(
      cfg({ dailyUsd: 1, weeklyUsd: 2, monthlyUsd: 3 }),
      spend({ dayUsd: 5, weekUsd: 5, monthUsd: 5 }),
      NORMAL,
    );
    assert.deepEqual(v.breaches.map((b) => b.period).sort(), ["daily", "monthly", "weekly"]);
  });
});

describe("a budget must not block free work", () => {
  for (const request of [
    { privacy: "local_only", mode: "auto" },
    { privacy: "sensitive", mode: "auto" },
    { privacy: "normal", mode: "local_only" },
  ] as const) {
    test(`privacy=${request.privacy} mode=${request.mode} is allowed even when over budget`, () => {
      const v = evaluateBudget(
        cfg({ dailyUsd: 1, onExceeded: "block" }),
        spend({ dayUsd: 999 }),
        request,
      );
      assert.equal(v.action, "allow", "a request that costs nothing was blocked by a spending limit");
      assert.equal(v.message, null);
    });
  }
});

describe("per-provider caps", () => {
  test("one exhausted provider does not stop the others", () => {
    const v = evaluateBudget(
      cfg({ perProviderMonthlyUsd: { openai: 10 } }),
      spend({ perProviderMonthUsd: { openai: 12 } }),
      NORMAL,
    );
    assert.equal(v.action, "allow", "an account-wide stop for one provider's cap");
    assert.match(v.message ?? "", /openai/);
  });

  test("exhaustedProviders lists exactly the ones over their cap", () => {
    const config = cfg({ perProviderMonthlyUsd: { openai: 10, anthropic: 50 } });
    const s = spend({ perProviderMonthUsd: { openai: 11, anthropic: 5 } });
    assert.deepEqual(exhaustedProviders(config, s), ["openai"]);
  });

  test("a provider with no recorded spend is not exhausted", () => {
    assert.deepEqual(exhaustedProviders(cfg({ perProviderMonthlyUsd: { groq: 5 } }), spend()), []);
  });

  test("a period breach still wins over a provider-only breach", () => {
    const v = evaluateBudget(
      cfg({ dailyUsd: 1, perProviderMonthlyUsd: { openai: 10 } }),
      spend({ dayUsd: 2, perProviderMonthUsd: { openai: 11 } }),
      NORMAL,
    );
    assert.equal(v.action, "force_local");
  });
});

describe("per-request ceiling", () => {
  test("is passed through for the router to enforce", () => {
    assert.equal(evaluateBudget(cfg({ perRequestUsd: 0.05 }), spend(), NORMAL).maxCostUsd, 0.05);
  });

  test("survives a breach, so both limits apply together", () => {
    const v = evaluateBudget(cfg({ perRequestUsd: 0.05, dailyUsd: 1 }), spend({ dayUsd: 2 }), NORMAL);
    assert.equal(v.maxCostUsd, 0.05);
  });
});

describe("config validation", () => {
  test("rejects a negative limit", () => {
    assert.equal(budgetConfigSchema.safeParse({ dailyUsd: -1 }).success, false);
  });

  test("accepts an empty object and fills unlimited defaults", () => {
    const parsed = budgetConfigSchema.parse({});
    assert.equal(parsed.dailyUsd, null);
    assert.equal(parsed.onExceeded, "local_only");
  });

  test("rejects an unknown onExceeded action", () => {
    assert.equal(budgetConfigSchema.safeParse({ onExceeded: "explode" }).success, false);
  });
});
