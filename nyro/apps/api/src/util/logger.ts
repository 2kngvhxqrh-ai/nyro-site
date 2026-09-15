import { redact } from "./redact.ts";

export type LogLevel = "debug" | "info" | "warn" | "error";

const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let threshold: LogLevel = (process.env.NYRO_LOG_LEVEL as LogLevel) || "info";

export function setLogLevel(level: LogLevel): void {
  threshold = level;
}

function emit(level: LogLevel, component: string, message: string, fields?: Record<string, unknown>): void {
  if (ORDER[level] < ORDER[threshold]) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    component,
    message,
    ...(fields ? (redact(fields) as Record<string, unknown>) : {}),
  };
  const sink = level === "error" || level === "warn" ? process.stderr : process.stdout;
  sink.write(JSON.stringify(line) + "\n");
}

export function logger(component: string) {
  return {
    debug: (m: string, f?: Record<string, unknown>) => emit("debug", component, m, f),
    info: (m: string, f?: Record<string, unknown>) => emit("info", component, m, f),
    warn: (m: string, f?: Record<string, unknown>) => emit("warn", component, m, f),
    error: (m: string, f?: Record<string, unknown>) => emit("error", component, m, f),
  };
}
