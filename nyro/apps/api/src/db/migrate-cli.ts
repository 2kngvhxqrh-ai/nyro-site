import { loadConfig } from "../config.ts";
import { createPool } from "./pool.ts";
import { runMigrations } from "./migrate.ts";

const cfg = loadConfig();
const pool = createPool(cfg.databaseUrl);
try {
  const applied = await runMigrations(pool);
  if (applied.length === 0) process.stdout.write("Database already up to date.\n");
  else process.stdout.write(`Applied: ${applied.join(", ")}\n`);
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
} finally {
  await pool.end();
}
