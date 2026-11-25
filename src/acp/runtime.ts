import type { AgentConfig } from "../config.js"
import { explain, type AcpExit, type FailureContext } from "./errors.js"
import { AcpClient, type PermissionHandler } from "./client.js"

/** Policy overrides for one agent process; omitted fields keep the client defaults. */
export interface AgentRuntimeOptions {
  readonly requestPermission?: PermissionHandler
}

/** What diagnostics can say about one agent without starting it. */
export interface AgentRuntimeStatus {
  readonly running: boolean
  readonly pid: number | undefined
  readonly contextWindow: number | undefined
  readonly exit: AcpExit | undefined
  readonly failure: FailureContext | undefined
}

/**
 * The runtime currently serving each agent ID.
 *
 * Plugin hot reload can leave a hook from the previous instance registered for
 * a while. Those hooks hold an older `AgentRuntime`, so every public operation
 * delegates to the registry entry instead of the instance's own state.
 */
const current = new Map<string, AgentRuntime>()

/**
 * Owns the ACP process for one configured agent.
 *
 * The process starts on the first turn and is reused by every OpenCode session
 * using that agent. A crashed or closed process is replaced on the next turn;
 * ACP sessions then go through `session/load`.
 */
export class AgentRuntime {
  private client: AcpClient | undefined
  private starting: Promise<AcpClient> | undefined
  private readonly locks = new Map<string, Promise<void>>()
  private closed = false
  private failureMessage: string | undefined

  constructor(
    readonly agent: AgentConfig,
    private readonly options: AgentRuntimeOptions = {},
  ) {
    current.set(this.agent.id, this)
  }

  get id(): string {
    return this.agent.id
  }

  /**
   * Serializes work for one OpenCode session. ACP allows a single prompt per
   * session, and a title or retry request must not interleave with the turn.
   */
  async lock(key: string): Promise<() => void> {
    return this.active.lockOwn(key)
  }

  async ensureClient(): Promise<AcpClient> {
    return this.active.ensureOwnClient()
  }

  get status(): AgentRuntimeStatus {
    return this.active.statusOwn
  }

  /** Last startup failure, in the same wording the assistant shows. */
  get lastFailure(): string | undefined {
    return this.active.failureMessage
  }

  /**
   * Closes this instance's process. The registry entry is removed only when it
   * still points at this instance, so an older cleanup cannot detach a newer
   * runtime that a hot reload just installed.
   */
  close(): void {
    if (current.get(this.id) === this) current.delete(this.id)
    this.closeOwn()
  }

  private get active(): AgentRuntime {
    return current.get(this.id) ?? this
  }

  private async lockOwn(key: string): Promise<() => void> {
    const previous = this.locks.get(key) ?? Promise.resolve()
    let release: () => void = () => {}
    const currentLock = new Promise<void>((resolve) => {
      release = resolve
    })
    const tail = previous.then(() => currentLock)
    this.locks.set(key, tail)
    await previous

    return () => {
      release()
      if (this.locks.get(key) === tail) this.locks.delete(key)
    }
  }

  private async ensureOwnClient(): Promise<AcpClient> {
    if (this.closed) throw new Error(`agent ${this.id} was closed`)
    if (this.client !== undefined && !this.client.isClosed) return this.client
    if (this.starting !== undefined) return this.starting

    this.client = undefined
    this.starting = AcpClient.start({
      command: this.agent.command,
      args: this.agent.args,
      env: this.agent.env,
      name: this.agent.id,
      requestPermission: this.options.requestPermission,
    }).finally(() => {
      this.starting = undefined
    })

    this.client = await this.starting.then(
      (client) => client,
      (error: unknown) => {
        this.failureMessage = explain(error, this.statusOwn.failure)
        throw error
      },
    )
    this.failureMessage = undefined
    return this.client
  }

  private get statusOwn(): AgentRuntimeStatus {
    const client = this.client
    return {
      running: client !== undefined && !client.isClosed,
      pid: client?.pid,
      contextWindow: client?.contextWindow,
      exit: client?.exitInfo,
      failure: client?.failure,
    }
  }

  private closeOwn(): void {
    this.closed = true
    this.client?.close()
    this.client = undefined

    // A close during startup must not leave the just-spawned process behind.
    if (this.starting !== undefined) {
      void this.starting.then(
        (client) => client.close(),
        () => {},
      )
    }
  }
}
