/**
 * Configuration. Read once at startup; failures are loud and immediate
 * rather than surfacing later as a confusing runtime error.
 */
import { parseMasterKey } from "./util/crypto.ts";
import { NyroError } from "./core/errors.ts";
import type { LogLevel } from "./util/logger.ts";

export interface NyroConfig {
  env: string;
  port: number;
  host: string;
  databaseUrl: string;
  secretKey: Buffer;
  logLevel: LogLevel;
  /** Origins permitted by CORS. The Vite dev server needs this; production serves same-origin. */
  corsOrigins: string[];
  /** Bootstraps an Ollama provider row on first run when set (spec §119). */
  ollamaBaseUrl: string | null;
  defaultModelHint: string | null;
  enableMockProvider: boolean;
  requestTimeoutMs: number;
}

function required(name: string): string {
  const v = process.env[name];
  if (!v || v.trim() === "") {
    throw new NyroError("config_error", `Required environment variable ${name} is not set.`, { component: "config" });
  }
  return v.trim();
}

function optional(name: string): string | null {
  const v = process.env[name];
  return v && v.trim() !== "" ? v.trim() : null;
}

function intOr(name: string, fallback: number): number {
  const raw = optional(name);
  if (raw === null) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) {
    throw new NyroError("config_error", `${name} must be a positive integer (got "${raw}").`, { component: "config" });
  }
  return n;
}

export function loadConfig(): NyroConfig {
  return {
    env: optional("NYRO_ENV") ?? "development",
    port: intOr("NYRO_PORT", 8787),
    host: optional("NYRO_HOST") ?? "127.0.0.1",
    databaseUrl: required("DATABASE_URL"),
    secretKey: parseMasterKey(process.env["NYRO_SECRET_KEY"]),
    logLevel: (optional("NYRO_LOG_LEVEL") as LogLevel | null) ?? "info",
    corsOrigins: (optional("NYRO_CORS_ORIGINS") ?? "http://localhost:5173")
      .split(",")
      .map((s) => s.trim())
      .filter((s) => s.length > 0),
    ollamaBaseUrl: optional("OLLAMA_BASE_URL"),
    defaultModelHint: optional("DEFAULT_MODEL"),
    enableMockProvider: (optional("NYRO_ENABLE_MOCK_PROVIDER") ?? "false").toLowerCase() === "true",
    requestTimeoutMs: intOr("NYRO_PROVIDER_TIMEOUT_MS", 120_000),
  };
}
