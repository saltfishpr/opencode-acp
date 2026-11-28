import { RequestError } from "@agentclientprotocol/sdk";

/**
 * 所有 SDK 错误的基类。`code` 是稳定的程序化标识，`cause` 保留底层错误。
 */
export class AcpError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

export class AcpSpawnError extends AcpError {
  constructor(
    readonly command: string,
    readonly cwd: string,
    cause: unknown,
  ) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    super("ACP_SPAWN_FAILED", `Failed to spawn "${command}" in "${cwd}": ${detail}`, {
      cause,
    });
  }
}

export class AcpInitializeTimeoutError extends AcpError {
  constructor(readonly timeoutMs: number) {
    super(
      "ACP_INITIALIZE_TIMEOUT",
      `ACP initialize did not complete within ${timeoutMs}ms`,
    );
  }
}

export class AcpTimeoutError extends AcpError {
  constructor(
    readonly method: string,
    readonly timeoutMs: number,
    options?: { cause?: unknown },
  ) {
    super(
      "ACP_REQUEST_TIMEOUT",
      `ACP request "${method}" did not complete within ${timeoutMs}ms`,
      options,
    );
  }
}

export class AcpProtocolVersionError extends AcpError {
  constructor(
    readonly received: number,
    readonly supported: number,
  ) {
    super(
      "ACP_UNSUPPORTED_PROTOCOL_VERSION",
      `Agent selected ACP protocol version ${received}, but this client supports ${supported}`,
    );
  }
}

export class AcpProcessExitedError extends AcpError {
  constructor(
    readonly exitCode: number | null,
    readonly signal: string | null,
    readonly stderr: string,
  ) {
    const status =
      exitCode !== null ? `code ${exitCode}` : signal ? `signal ${signal}` : "unknown status";
    const tail = stderr.trim();
    super(
      "ACP_PROCESS_EXITED",
      `ACP agent process exited (${status})${tail ? `: ${tail.slice(-2000)}` : ""}`,
    );
  }
}

export class AcpNotStartedError extends AcpError {
  constructor() {
    super("ACP_NOT_STARTED", "ACP client has not been started; call start() first");
  }
}

export class AcpDisposedError extends AcpError {
  constructor() {
    super("ACP_DISPOSED", "ACP client has been disposed");
  }
}

export class AcpUnsupportedCapabilityError extends AcpError {
  constructor(readonly capability: string) {
    super(
      "ACP_UNSUPPORTED_CAPABILITY",
      `The agent or client does not support ${capability}`,
    );
  }
}

export class AcpUnsupportedContentError extends AcpError {
  constructor(
    readonly contentType: string,
    readonly capability: string,
  ) {
    super(
      "ACP_UNSUPPORTED_CONTENT",
      `Prompt content type "${contentType}" requires the agent capability ${capability}`,
    );
  }
}

export class AcpInvalidArgumentError extends AcpError {
  constructor(message: string) {
    super("ACP_INVALID_ARGUMENT", message);
  }
}

export class AcpInvalidHostError extends AcpError {
  constructor(message: string) {
    super("ACP_INVALID_HOST", message);
  }
}

export class AcpAuthRequiredError extends AcpError {
  constructor(readonly data?: unknown, message = "The agent requires authentication") {
    super("ACP_AUTH_REQUIRED", message);
  }
}

export class AcpTerminalAuthError extends AcpError {
  constructor(
    readonly methodId: string,
    readonly exitCode: number | null,
    readonly signal: string | null,
  ) {
    super(
      "ACP_TERMINAL_AUTH_FAILED",
      `Terminal authentication method "${methodId}" failed (exit ${exitCode ?? "null"}, signal ${signal ?? "null"})`,
    );
  }
}

export class AcpPendingUpdatesOverflowError extends AcpError {
  constructor(
    readonly limit: number,
    readonly bytes: number,
  ) {
    super(
      "ACP_PENDING_UPDATES_OVERFLOW",
      `Too many session updates arrived before session/new completed (${limit} updates / ${bytes} bytes)`,
    );
  }
}

export class AcpSessionBusyError extends AcpError {
  constructor(message: string) {
    super("ACP_SESSION_BUSY", message);
  }
}

export class AcpReadOnlySessionError extends AcpError {
  constructor(operation: string) {
    super(
      "ACP_READ_ONLY_SESSION",
      `Subagent sessions are read-only; "${operation}" is not permitted`,
    );
  }
}

export class AcpSessionNotFoundError extends AcpError {
  constructor(readonly sessionId: string) {
    super("ACP_SESSION_NOT_FOUND", `Unknown ACP session "${sessionId}"`);
  }
}

export class AcpUnknownConfigOptionError extends AcpError {
  constructor(readonly configId: string) {
    super("ACP_UNKNOWN_CONFIG_OPTION", `Unknown session config option "${configId}"`);
  }
}

export class AcpPaginationError extends AcpError {
  constructor(readonly cursor: string) {
    super("ACP_PAGINATION_LOOP", `session/list repeated pagination cursor "${cursor}"`);
  }
}

export class AcpCancelledError extends AcpError {
  constructor(message = "ACP operation was cancelled") {
    super("ACP_CANCELLED", message);
  }
}

export class AcpRequestError extends AcpError {
  constructor(
    readonly method: string,
    readonly rpcCode: number,
    message: string,
    readonly data?: unknown,
    options?: { cause?: unknown },
  ) {
    super("ACP_REQUEST_FAILED", `ACP request "${method}" failed: ${message}`, options);
  }
}

export class AcpProtocolError extends AcpError {
  constructor(message: string, options?: { cause?: unknown }) {
    super("ACP_PROTOCOL_ERROR", message, options);
  }
}

export class AcpUnstableFeatureError extends AcpError {
  constructor(feature: string) {
    super(
      "ACP_UNSTABLE_FEATURE_DISABLED",
      `Unstable feature "${feature}" requires experimental.unstable to be enabled`,
    );
  }
}

export function isAuthRequiredError(error: unknown): boolean {
  return (
    error instanceof RequestError &&
    error.code === -32000 &&
    (error.data === undefined ||
      error.data === null ||
      typeof error.data === "object")
  );
}

export function mapRequestError(method: string, error: unknown): AcpError {
  if (error instanceof AcpError) {
    return error;
  }

  if (error instanceof RequestError) {
    if (isAuthRequiredError(error)) {
      return new AcpAuthRequiredError(error.data, error.message);
    }
    return new AcpRequestError(method, error.code, error.message, error.data, {
      cause: error,
    });
  }

  if (error instanceof Error) {
    return new AcpRequestError(method, -32603, error.message, undefined, {
      cause: error,
    });
  }

  return new AcpRequestError(method, -32603, String(error), undefined, {
    cause: error,
  });
}
