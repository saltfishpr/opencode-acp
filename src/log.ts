/** Verbosity of the plugin's own log lines. */
export type LogLevel = "silent" | "error" | "warn" | "info" | "debug"

const RANK: Record<LogLevel, number> = { silent: 0, error: 1, warn: 2, info: 3, debug: 4 }

let current: LogLevel = "info"

/** Sets the threshold used by `logInfo` and `logDebug`. Warnings always print. */
export function setLogLevel(level: LogLevel): void {
  current = level
}

export function logDebug(prefix: string, message: string): void {
  if (RANK[current] >= RANK.debug) console.log(`[${prefix}] ${message}`)
}

export function logInfo(prefix: string, message: string): void {
  if (RANK[current] >= RANK.info) console.log(`[${prefix}] ${message}`)
}

/** Warnings are diagnostics, so `silent` only suppresses informational lines. */
export function logWarn(prefix: string, message: string): void {
  console.warn(`[${prefix}] ${message}`)
}
