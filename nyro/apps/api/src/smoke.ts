/**
 * Live provider smoke test.
 *
 * NOT part of `pnpm test`, deliberately. Everything in the test suite runs
 * against local servers speaking each vendor's wire protocol, which proves
 * NYRO's adapters and nothing about the vendors. This is the one thing that
 * closes that gap, and it cannot be automated into CI because it needs the
 * user's real API keys and spends their real money.
 *
 *   pnpm smoke              every enabled provider
 *   pnpm smoke -- ollama    just one
 *
 * It is deliberately tiny: one model listing and one ~10-token completion per
 * provider. It prints what it will cost before spending anything, and it never
 * prints a key.
 */
import { loadConfig } from "./config.ts";
import { createPool } from "./db/pool.ts";
import { ProviderRepo, ModelRepo } from "./db/repos.ts";
import { createProvider } from "./providers/index.ts";
import { NyroError } from "./core/errors.ts";
import { estimateCostDefault } from "./providers/provider.ts";

const PROMPT = "Reply with the single word: ready";
/** Keep the spend trivially small; this is a connectivity check, not a benchmark. */
const MAX_OUTPUT_TOKENS = 16;

interface Result {
  providerId: string;
  reachable: boolean;
  modelsListed: number;
  chatModel: string | null;
  chatOk: boolean;
  reply: string | null;
  latencyMs: number | null;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  error: string | null;
}

function line(s = ""): void {
  process.stdout.write(`${s}\n`);
}

async function smokeOne(
  providerId: string,
  providers: ProviderRepo,
  models: ModelRepo,
): Promise<Result> {
  const result: Result = {
    providerId, reachable: false, modelsListed: 0, chatModel: null, chatOk: false,
    reply: null, latencyMs: null, inputTokens: 0, outputTokens: 0, costUsd: 0, error: null,
  };

  const cfg = await providers.getConfig(providerId);
  if (!cfg) {
    result.error = "not configured";
    return result;
  }

  const adapter = createProvider(cfg);

  const health = await adapter.healthCheck();
  result.reachable = health.state === "healthy" || health.state === "degraded";
  if (!result.reachable) {
    result.error = health.detail;
    return result;
  }

  try {
    result.modelsListed = (await adapter.listModels()).length;
  } catch (err) {
    result.error = NyroError.from(err, "smoke").message;
    return result;
  }

  // Use the cheapest registered model for this provider, so a smoke test never
  // reaches for the expensive one.
  const registered = (await models.list()).filter((m) => m.providerId === providerId && m.enabled);
  const cheapest = registered.sort((a, b) => a.outputCostPer1m - b.outputCostPer1m)[0];
  if (!cheapest) {
    result.error = "no enabled models in the registry — run discovery first";
    return result;
  }
  result.chatModel = cheapest.modelIdentifier;

  const t0 = Date.now();
  try {
    const res = await adapter.chat({
      modelIdentifier: cheapest.modelIdentifier,
      messages: [{ role: "user", content: PROMPT }],
      maxOutputTokens: MAX_OUTPUT_TOKENS,
    });
    result.latencyMs = Date.now() - t0;
    result.chatOk = true;
    result.reply = res.content.trim().slice(0, 60);
    result.inputTokens = res.usage.inputTokens;
    result.outputTokens = res.usage.outputTokens;
    result.costUsd = estimateCostDefault(res.usage, cheapest.inputCostPer1m, cheapest.outputCostPer1m).totalCostUsd;
  } catch (err) {
    result.latencyMs = Date.now() - t0;
    const e = NyroError.from(err, "smoke");
    result.error = `${e.code}: ${e.message}`;
  }
  return result;
}

async function main(): Promise<void> {
  const only = process.argv.slice(2).filter((a) => !a.startsWith("-"));
  const cfg = loadConfig();
  const pool = createPool(cfg.databaseUrl);
  const providers = new ProviderRepo(pool, cfg.secretKey);
  const models = new ModelRepo(pool);

  try {
    const all = (await providers.listPublic()).filter((p) => p.enabled);
    const targets = only.length > 0 ? all.filter((p) => only.includes(p.id)) : all;

    if (targets.length === 0) {
      line("No enabled providers to test.");
      line(only.length > 0 ? `  (nothing matched: ${only.join(", ")})` : "  Add one in the Models page first.");
      return;
    }

    const paid = targets.filter((p) => !p.local);
    line("");
    line(`Live smoke test — ${targets.length} provider(s): ${targets.map((p) => p.id).join(", ")}`);
    line(`One model listing and one ~${MAX_OUTPUT_TOKENS}-token completion each.`);
    if (paid.length > 0) {
      // Reads correctly for one as well as many: this is the sentence that
      // comes immediately before spending someone's money.
      line(
        `${paid.length} paid provider${paid.length === 1 ? "" : "s"} in that list, ` +
          "so this will spend a small amount of real money.",
      );
    }
    line("");

    const results: Result[] = [];
    for (const p of targets) {
      process.stdout.write(`  ${p.id} … `);
      const r = await smokeOne(p.id, providers, models);
      results.push(r);
      if (r.chatOk) {
        process.stdout.write(`ok  ${r.latencyMs}ms  ${r.inputTokens}→${r.outputTokens} tok  $${r.costUsd.toFixed(5)}\n`);
        process.stdout.write(`      model: ${r.chatModel}\n`);
        process.stdout.write(`      reply: ${JSON.stringify(r.reply)}\n`);
      } else {
        process.stdout.write(`FAILED\n`);
        process.stdout.write(`      ${r.error}\n`);
      }
    }

    const ok = results.filter((r) => r.chatOk);
    const total = results.reduce((s, r) => s + r.costUsd, 0);
    line("");
    line(`${ok.length}/${results.length} provider(s) answered. Spent $${total.toFixed(5)}.`);
    if (ok.length < results.length) {
      line("");
      line("A failure here is real: it means NYRO could not talk to that provider");
      line("with the credentials and base URL you configured.");
      process.exitCode = 1;
    }
    line("");
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  const e = NyroError.from(err, "smoke");
  process.stderr.write(`Smoke test failed to run: ${e.message}\n`);
  process.exit(1);
});
