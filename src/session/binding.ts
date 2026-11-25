import type { Plugin } from "@opencode/plugin"

/** The ACP session that carries one OpenCode session's conversation. */
export interface AcpBinding {
  readonly sessionId: string
  /** Absolute working directory the ACP session was created with. */
  readonly cwd: string
}

/**
 * Persists OpenCode session → ACP session mappings so a plugin reload can
 * resume the agent's own conversation with `session/load` instead of starting
 * from an empty context.
 */
export class SessionBindings {
  constructor(private readonly storage: Plugin.Context["storage"]) {}

  async get(agentID: string, sessionID: string): Promise<AcpBinding | undefined> {
    const value = await this.storage.get(key(agentID, sessionID))
    if (value === null || typeof value !== "object" || Array.isArray(value)) return undefined

    const entry = value as Record<string, unknown>
    const sessionId = entry["sessionId"]
    const cwd = entry["cwd"]
    if (typeof sessionId !== "string" || sessionId.length === 0) return undefined
    if (typeof cwd !== "string" || cwd.length === 0) return undefined

    return { sessionId, cwd }
  }

  async save(agentID: string, sessionID: string, binding: AcpBinding): Promise<void> {
    await this.storage.set(key(agentID, sessionID), { ...binding })
  }

  async remove(agentID: string, sessionID: string): Promise<void> {
    await this.storage.remove(key(agentID, sessionID))
  }
}

/**
 * Returns the working directory OpenCode assigned to the session. Rejects when
 * the session does not exist.
 */
export async function sessionDirectory(ctx: Plugin.Context, sessionID: string): Promise<string> {
  const session = await ctx.session.get({ sessionID })
  return session.location.directory
}

function key(agentID: string, sessionID: string): string {
  return `acp/binding/${agentID}/${sessionID}`
}
