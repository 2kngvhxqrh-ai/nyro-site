import type { Pool } from "./pool.ts";
import { dbError } from "./pool.ts";
import { MIGRATIONS } from "./migrations.ts";
import { logger } from "../util/logger.ts";

const log = logger("db:migrate");

export async function runMigrations(pool: Pool): Promise<string[]> {
  const applied: string[] = [];
  const client = await pool.connect();
  try {
    await client.query(`
      create table if not exists nyro_migrations (
        id         text primary key,
        applied_at timestamptz not null default now()
      )
    `);
    const { rows } = await client.query<{ id: string }>("select id from nyro_migrations");
    const done = new Set(rows.map((r) => r.id));

    for (const m of MIGRATIONS) {
      if (done.has(m.id)) continue;
      // Each migration is all-or-nothing; a failure leaves the DB untouched.
      await client.query("begin");
      try {
        await client.query(m.sql);
        await client.query("insert into nyro_migrations (id) values ($1)", [m.id]);
        await client.query("commit");
        applied.push(m.id);
        log.info("migration applied", { id: m.id });
      } catch (err) {
        await client.query("rollback");
        throw dbError(err, `applying migration ${m.id}`);
      }
    }
    return applied;
  } finally {
    client.release();
  }
}
