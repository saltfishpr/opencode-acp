import type { Plugin } from "@opencode/plugin";
import { z } from "zod";

/** The ACP session that carries one OpenCode session's conversation. */
const AcpBindingSchema = z
  .object({
    sessionId: z.string().min(1),
    /** Absolute working directory the ACP session was created with. */
    cwd: z.string().min(1),
  })
  .readonly();

export type AcpBinding = z.infer<typeof AcpBindingSchema>;

/**
 * Persists OpenCode session → ACP session mappings so a plugin reload can
 * resume the agent's own conversation with `session/load` instead of starting
 * from an empty context.
 */
export class SessionBindings {
  constructor(private readonly storage: Plugin.Context["storage"]) {}

  async get(agentID: string, sessionID: string): Promise<AcpBinding | undefined> {
    const result = AcpBindingSchema.safeParse(await this.storage.get(key(agentID, sessionID)));
    return result.success ? result.data : undefined;
  }

  async save(agentID: string, sessionID: string, binding: AcpBinding): Promise<void> {
    await this.storage.set(key(agentID, sessionID), { ...binding });
  }

  async remove(agentID: string, sessionID: string): Promise<void> {
    await this.storage.remove(key(agentID, sessionID));
  }
}

/**
 * Returns the working directory OpenCode assigned to the session. Rejects when
 * the session does not exist.
 */
export async function sessionDirectory(ctx: Plugin.Context, sessionID: string): Promise<string> {
  const session = await ctx.session.get({ sessionID });
  return session.location.directory;
}

function key(agentID: string, sessionID: string): string {
  return `acp/binding/${agentID}/${sessionID}`;
}
