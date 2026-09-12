import pg from "pg";
import { NyroError } from "../core/errors.ts";
import { logger } from "../util/logger.ts";

const log = logger("db");

/**
 * Postgres numerics come back as strings by default so precision is not lost.
 * NYRO's numerics are costs and token counts that comfortably fit a double, and
 * every consumer expects a number, so we parse them here once.
 */
pg.types.setTypeParser(pg.types.builtins.NUMERIC, (v: string) => Number.parseFloat(v));
pg.types.setTypeParser(pg.types.builtins.INT8, (v: string) => Number.parseInt(v, 10));

export type Pool = pg.Pool;

export function createPool(connectionString: string): Pool {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 5_000,
  });
  // An idle-client error would otherwise be an unhandled 'error' event and kill the process.
  pool.on("error", (err) => log.error("idle client error", { error: err.message }));
  return pool;
}

export async function pingDb(pool: Pool): Promise<{ ok: true; latencyMs: number } | { ok: false; detail: string }> {
  const started = Date.now();
  try {
    await pool.query("select 1");
    return { ok: true, latencyMs: Date.now() - started };
  } catch (err) {
    return { ok: false, detail: err instanceof Error ? err.message : String(err) };
  }
}

export function dbError(err: unknown, what: string): NyroError {
  return new NyroError("db_error", `Database operation failed: ${what}.`, {
    component: "db",
    detail: err instanceof Error ? err.message : String(err),
    cause: err,
  });
}
