import type { AcpClient } from "./client.js";
import { logWarn } from "../log.js";

export interface RestoreResult {
  readonly restored: boolean;
  /** Failure of the last attempt; absent when a needed capability was missing. */
  readonly failure?: unknown;
}

/**
 * Makes a bound ACP session usable in this process.
 *
 * Resume is tried first: the agent keeps the conversation but does not replay
 * it. Load is the fallback for agents that can only restore from storage.
 * Callers decide what an unrestored session means; importing history does not
 * use this path because it needs the replayed updates.
 */
export async function restoreSession(client: AcpClient, sessionId: string, cwd: string): Promise<RestoreResult> {
  if (client.hasSession(sessionId)) return { restored: true };

  let failure: unknown;
  if (client.canResumeSession) {
    try {
      await client.resumeSession(sessionId, cwd);
      return { restored: true };
    } catch (error) {
      failure = error;
      logWarn("acp", `session/resume failed for ${sessionId}: ${message(error)}`);
    }
  }

  if (client.canLoadSession) {
    try {
      await client.loadSession(sessionId, cwd);
      return { restored: true };
    } catch (error) {
      failure = error;
      logWarn("acp", `session/load failed for ${sessionId}: ${message(error)}`);
    }
  }

  return { restored: false, failure };
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
