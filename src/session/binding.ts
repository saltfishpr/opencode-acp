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

export interface SessionBindingEntry {
  /** The OpenCode session ID. */
  readonly sessionID: string;
  readonly binding: AcpBinding;
}

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

  /** Every valid binding stored for one agent. */
  async list(agentID: string): Promise<SessionBindingEntry[]> {
    const prefix = prefixOf(agentID);
    const entries: SessionBindingEntry[] = [];
    let after: string | undefined;

    for (;;) {
      const page = await this.storage.scan({
        prefix,
        ...(after === undefined ? {} : { after }),
        limit: 100,
      });

      for (const entry of page.entries) {
        const result = AcpBindingSchema.safeParse(entry.value);
        if (!result.success) continue;
        const sessionID = entry.key.slice(prefix.length);
        if (sessionID.length === 0) continue;
        entries.push({ sessionID, binding: result.data });
      }

      if (page.next === undefined) return entries;
      after = page.next;
    }
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
  return `${prefixOf(agentID)}${sessionID}`;
}

function prefixOf(agentID: string): string {
  return `acp/binding/${agentID}/`;
}
