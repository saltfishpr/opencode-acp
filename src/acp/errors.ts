import { RequestError } from "@agentclientprotocol/sdk"

/** Where starting an ACP agent failed. */
export type AcpStartStage = "spawn" | "handshake"

/** A spawn or handshake failure, kept distinguishable from agent-level errors. */
export class AcpStartError extends Error {
  constructor(
    readonly stage: AcpStartStage,
    readonly command: string,
    readonly cause: unknown,
    /** Set when the process exited before the handshake finished. */
    readonly exit?: AcpExit,
  ) {
    super(cause instanceof Error ? cause.message : String(cause))
    this.name = "AcpStartError"
  }
}

/** How the agent process ended, when it did. */
export interface AcpExit {
  readonly code: number | null
  readonly signal: NodeJS.Signals | null
}

export interface FailureContext {
  /** The configured command, used in spawn errors. */
  readonly command?: string
  /** Set when the process has already exited. */
  readonly exit?: AcpExit
  /** True when the plugin closed the process itself, so an exit is not a failure. */
  readonly closedByUser?: boolean
}

/**
 * Turns an ACP, process or protocol error into a short Chinese explanation.
 *
 * Callers log the raw error separately; this string is what the assistant text
 * shows, so it names the next action where one exists.
 */
export function explain(error: unknown, context: FailureContext = {}): string {
  if (error instanceof AcpStartError) return explainStart(error, context)

  if (error instanceof RequestError) {
    if (error.code === -32000) {
      return `远端 agent 尚未登录或没有可用凭据（${error.message}）。请先在终端运行一次该 CLI 完成登录，或在插件配置里补充凭据`
    }
    if (error.code === -32002) {
      return `远端 ACP 会话不存在或已失效（${error.message}），下一轮会新建会话`
    }
    if (error.code === -32800) return "ACP 请求已取消"
    return `${error.message}（ACP ${error.code}）`
  }

  if (isAbort(error)) {
    return "等待 agent 响应超时（ACP 握手或会话请求超过了插件允许的时间）"
  }

  if (context.exit !== undefined && !context.closedByUser) {
    return `ACP agent 进程已退出（${describeExit(context.exit)}），下一轮会重新启动`
  }

  if (isEnoent(error)) {
    const command = context.command ?? "配置里的 command"
    return `找不到 agent 可执行文件 ${command}，请检查插件配置或安装对应 CLI`
  }

  return `${message(error)}（详细日志见 server 输出中的 [acp] 行）`
}

/** Log line for a process that ended on its own, outside a request. */
export function describeExit(exit: AcpExit): string {
  if (exit.signal !== null) return `signal ${exit.signal}`
  if (exit.code !== null) return `code ${exit.code}`
  return "unknown status"
}

function explainStart(error: AcpStartError, context: FailureContext): string {
  if (error.stage === "spawn") {
    if (isEnoent(error.cause)) {
      return `找不到 agent 可执行文件 ${error.command}，请检查插件配置或安装对应 CLI`
    }
    return `无法启动 agent（${error.command}）：${message(error.cause)}`
  }

  const exit = error.exit ?? context.exit
  if (exit !== undefined && !context.closedByUser) {
    return `agent 启动后未完成 ACP 握手就退出了（${describeExit(exit)}）。请确认 ${error.command} 能正常运行`
  }

  if (isAbort(error.cause)) {
    return `agent 启动后 60 秒内没有完成 ACP 握手（${error.command}）。网络不可达时请检查代理设置`
  }

  return `与 agent 的 ACP 握手失败（${error.command}）：${message(error.cause)}`
}

function isAbort(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "name" in error &&
    (error.name === "AbortError" || error.name === "TimeoutError")
  )
}

function isEnoent(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT"
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
