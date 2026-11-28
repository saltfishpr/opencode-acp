export interface AcpLogger {
  debug?(message: string, details?: unknown): void;
  info?(message: string, details?: unknown): void;
  warn?(message: string, details?: unknown): void;
  error?(message: string, error?: unknown): void;
}

const noop = (): void => {};

export function createLogger(logger?: AcpLogger): Required<AcpLogger> {
  return {
    debug: logger?.debug ?? noop,
    info: logger?.info ?? noop,
    warn: logger?.warn ?? noop,
    error: logger?.error ?? noop,
  };
}
