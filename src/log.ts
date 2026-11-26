export const LOG_LEVELS = ["silent", "error", "warn", "info", "debug"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

const RANK: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 };

const levelKey = Symbol.for("opencode-acp/log-level");
const scope = globalThis as typeof globalThis & { [levelKey]?: LogLevel };

export function setLogLevel(level: LogLevel): void {
  scope[levelKey] = level;
}

export function logDebug(prefix: string, message: string): void {
  if (RANK[scope[levelKey] ?? "info"] >= RANK.debug) console.log(`[${prefix}] ${message}`);
}

export function logInfo(prefix: string, message: string): void {
  if (RANK[scope[levelKey] ?? "info"] >= RANK.info) console.log(`[${prefix}] ${message}`);
}

export function logWarn(prefix: string, message: string): void {
  if (RANK[scope[levelKey] ?? "info"] >= RANK.warn) console.warn(`[${prefix}] ${message}`);
}

export function logError(prefix: string, message: string): void {
  if (RANK[scope[levelKey] ?? "info"] >= RANK.error) console.error(`[${prefix}] ${message}`);
}
