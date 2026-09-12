/**
 * Composition root: builds every NYRO component and wires them together.
 *
 * Kept separate from main.ts so tests can build a full, real application
 * (real Core, real DB) without starting a listener or reading process.env.
 */
import { createHttpServer, type ServerDeps } from "./http/server.ts";
import { createPool, type Pool } from "./db/pool.ts";
import { runMigrations } from "./db/migrate.ts";
import { ConversationRepo, ModelRepo, ProviderRepo, RunRepo, SettingsRepo } from "./db/repos.ts";
import { Registry } from "./core/registry.ts";
import { Executor } from "./core/executor.ts";
import { ChatService } from "./core/chat-service.ts";
import { EventBus } from "./core/events.ts";
import { bootstrapProviders } from "./core/bootstrap.ts";
import type { NyroConfig } from "./config.ts";
import { setLogLevel } from "./util/logger.ts";
import type { Server } from "node:http";

export interface NyroApp {
  deps: ServerDeps;
  server: Server;
  pool: Pool;
  shutdown: () => Promise<void>;
}

export async function createApp(config: NyroConfig): Promise<NyroApp> {
  setLogLevel(config.logLevel);

  const pool = createPool(config.databaseUrl);
  await runMigrations(pool);

  const bus = new EventBus();
  const providers = new ProviderRepo(pool, config.secretKey);
  const models = new ModelRepo(pool);
  const conversations = new ConversationRepo(pool);
  const runs = new RunRepo(pool);
  const settings = new SettingsRepo(pool);

  const registry = new Registry(providers, models, bus);
  const executor = new Executor(registry, runs, bus);
  const chat = new ChatService(registry, conversations, executor, bus, settings, runs);

  await bootstrapProviders(providers, config);

  const deps: ServerDeps = { config, pool, providers, models, conversations, runs, settings, registry, chat, bus };
  const server = createHttpServer(deps);

  return {
    deps,
    server,
    pool,
    shutdown: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await pool.end();
    },
  };
}
