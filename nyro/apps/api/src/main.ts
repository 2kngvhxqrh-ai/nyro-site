/**
 * Process entry point.
 *
 * Startup discovery is fire-and-forget: an unreachable Ollama must not stop
 * NYRO from booting (spec §110, §184).
 */
import { loadConfig } from "./config.ts";
import { createApp } from "./app.ts";
import { logger } from "./util/logger.ts";
import { NyroError } from "./core/errors.ts";

const log = logger("main");

async function start(): Promise<void> {
  const config = loadConfig();
  const app = await createApp(config);

  app.server.listen(config.port, config.host, () => {
    log.info("NYRO API listening", { host: config.host, port: config.port, env: config.env });
  });

  app.deps.registry
    .discoverAll()
    .then((reports) => {
      for (const rep of reports) {
        log.info("startup discovery", {
          provider: rep.providerId,
          ok: rep.ok,
          models: rep.modelsFound,
          health: rep.health,
        });
      }
      if (reports.length === 0) {
        log.warn("no providers configured — add one at /api/providers or set OLLAMA_BASE_URL");
      }
    })
    .catch((err) => log.warn("startup discovery failed", { error: NyroError.from(err, "main").message }));

  let shuttingDown = false;
  for (const sig of ["SIGINT", "SIGTERM"] as const) {
    process.on(sig, () => {
      if (shuttingDown) return;
      shuttingDown = true;
      log.info("shutting down", { signal: sig });
      app.shutdown().then(
        () => process.exit(0),
        () => process.exit(1),
      );
    });
  }
}

start().catch((err) => {
  const e = NyroError.from(err, "main");
  // Startup failures must be legible: a missing env var should say so plainly.
  process.stderr.write(`NYRO failed to start: ${e.message}\n`);
  if (e.detail) process.stderr.write(`  detail: ${e.detail}\n`);
  process.exit(1);
});
