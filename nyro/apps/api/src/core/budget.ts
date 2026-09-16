/**
 * Cost control (spec §66, §87, §101).
 *
 * NYRO records what every model run costs. That is not the same as protecting
 * the user: without a ceiling, one runaway task on a paid provider produces a
 * bill nobody approved. This module turns recorded spend into an enforced
 * limit, checked BEFORE a model is called.
 *
 * The design choice worth stating: exceeding a budget does not have to mean
 * stopping. `local_only` degrades to free local models instead, which keeps
 * NYRO useful when the money runs out (spec §1.5, §184). Blocking outright is
 * available for people who would rather be interrupted than surprised.
 */
import { z } from "zod";
import type { PrivacyClass, RoutingMode } from "./types.ts";

export const budgetConfigSchema = z.object({
  /** null = no cap. Values are USD. */
  dailyUsd: z.number().min(0).nullable().default(null),
  weeklyUsd: z.number().min(0).nullable().default(null),
  monthlyUsd: z.number().min(0).nullable().default(null),
  /** Applied to a single request's estimate, before it runs. */
  perRequestUsd: z.number().min(0).nullable().default(null),
  /** providerId → monthly cap. Lets one expensive provider be fenced off. */
  perProviderMonthlyUsd: z.record(z.number().min(0)).default({}),
  /**
   * What happens when a period cap is already exceeded:
   *  - "local_only": keep working, but only on free local models
   *  - "block":      refuse, with an error naming the cap that was hit
   */
  onExceeded: z.enum(["local_only", "block"]).default("local_only"),
});

export type BudgetConfig = z.infer<typeof budgetConfigSchema>;

export const DEFAULT_BUDGET: BudgetConfig = {
  dailyUsd: null,
  weeklyUsd: null,
  monthlyUsd: null,
  perRequestUsd: null,
  perProviderMonthlyUsd: {},
  // Off by default. A budget the user did not set must never silently block
  // their work; they opt in.
  onExceeded: "local_only",
};

export interface SpendSnapshot {
  dayUsd: number;
  weekUsd: number;
  monthUsd: number;
  /** providerId → spend this month. */
  perProviderMonthUsd: Record<string, number>;
}

export type BudgetPeriod = "daily" | "weekly" | "monthly" | "provider";

export interface BudgetBreach {
  period: BudgetPeriod;
  /** For "provider", which one. */
  providerId?: string;
  limitUsd: number;
  spentUsd: number;
}

export interface BudgetVerdict {
  /** Every cap currently exceeded. Empty when within budget. */
  breaches: BudgetBreach[];
  /** How the request must be constrained as a result. */
  action: "allow" | "force_local" | "block";
  /** Per-request ceiling to hand the router, if one is configured. */
  maxCostUsd: number | null;
  /** One short sentence for the UI. Null when nothing is constrained. */
  message: string | null;
}

/**
 * Formats an amount for a user-facing explanation.
 *
 * Two decimals is right for dollars and useless for fractions of a cent: a
 * $0.0008 cap rendered as "$0.00 of $0.00" tells the reader nothing, which
 * defeats the point of saying why their request was constrained. Small values
 * therefore get the precision they need to be distinguishable.
 */
function money(n: number): string {
  if (n === 0) return "$0";
  if (n < 0.01) return `$${n.toFixed(5).replace(/0+$/, "").replace(/\.$/, "")}`;
  if (n < 1) return `$${n.toFixed(3).replace(/0+$/, "").replace(/\.$/, "")}`;
  return `$${n.toFixed(2)}`;
}

/**
 * Decides what a request is allowed to do, given the budget and spend so far.
 *
 * Pure, like the router, so the enforcement rules are testable without a
 * database or a clock.
 */
export function evaluateBudget(
  config: BudgetConfig,
  spend: SpendSnapshot,
  request: { privacy: PrivacyClass; mode: RoutingMode },
): BudgetVerdict {
  const breaches: BudgetBreach[] = [];

  if (config.dailyUsd !== null && spend.dayUsd >= config.dailyUsd) {
    breaches.push({ period: "daily", limitUsd: config.dailyUsd, spentUsd: spend.dayUsd });
  }
  if (config.weeklyUsd !== null && spend.weekUsd >= config.weeklyUsd) {
    breaches.push({ period: "weekly", limitUsd: config.weeklyUsd, spentUsd: spend.weekUsd });
  }
  if (config.monthlyUsd !== null && spend.monthUsd >= config.monthlyUsd) {
    breaches.push({ period: "monthly", limitUsd: config.monthlyUsd, spentUsd: spend.monthUsd });
  }
  for (const [providerId, limit] of Object.entries(config.perProviderMonthlyUsd)) {
    const spent = spend.perProviderMonthUsd[providerId] ?? 0;
    if (spent >= limit) {
      breaches.push({ period: "provider", providerId, limitUsd: limit, spentUsd: spent });
    }
  }

  if (breaches.length === 0) {
    return { breaches, action: "allow", maxCostUsd: config.perRequestUsd, message: null };
  }

  // A request that was already going to stay local costs nothing, so a budget
  // must not block it. Refusing free work because paid work ran out would be
  // a bug, not a safeguard.
  const alreadyFree = request.privacy === "local_only" || request.privacy === "sensitive" || request.mode === "local_only";
  if (alreadyFree) {
    return { breaches, action: "allow", maxCostUsd: config.perRequestUsd, message: null };
  }

  // A per-provider breach only removes that provider; it is not a reason to
  // stop using the others.
  const onlyProviderBreaches = breaches.every((b) => b.period === "provider");
  if (onlyProviderBreaches) {
    const names = breaches.map((b) => b.providerId).join(", ");
    return {
      breaches,
      action: "allow",
      maxCostUsd: config.perRequestUsd,
      message: `Monthly cap reached for ${names}; those models are excluded.`,
    };
  }

  const worst = breaches.find((b) => b.period !== "provider")!;
  const label = `${worst.period} budget (${money(worst.spentUsd)} of ${money(worst.limitUsd)})`;

  if (config.onExceeded === "block") {
    return {
      breaches,
      action: "block",
      maxCostUsd: config.perRequestUsd,
      message: `Your ${label} is used up. Raise the limit in Settings, or switch this request to local-only.`,
    };
  }

  return {
    breaches,
    action: "force_local",
    maxCostUsd: config.perRequestUsd,
    message: `Your ${label} is used up, so this is running on local models only.`,
  };
}

/** Provider ids whose own monthly cap is exhausted, for the router to exclude. */
export function exhaustedProviders(config: BudgetConfig, spend: SpendSnapshot): string[] {
  return Object.entries(config.perProviderMonthlyUsd)
    .filter(([id, limit]) => (spend.perProviderMonthUsd[id] ?? 0) >= limit)
    .map(([id]) => id);
}
