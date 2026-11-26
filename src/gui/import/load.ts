import type { ServerRef } from "@opencode/plugin/gui";
import {
  AcpSettings,
  type ImportableAgent,
  type ImportableSession,
  type ImportAgentsView,
  type ImportSessionsView,
} from "../../rpc.js";

const AGENT_TIMEOUT_MS = 30_000;
const SESSIONS_TIMEOUT_MS = 60_000;

export type AgentLoad =
  | { readonly server: ServerRef; readonly agents: readonly ImportableAgent[] }
  | { readonly server: ServerRef; readonly failed: true; readonly methodMissing: boolean };

/** Reads every server's agent statuses. Never starts an agent. */
export async function loadImportAgents(servers: readonly ServerRef[]): Promise<AgentLoad[]> {
  return Promise.all(
    servers.map(async (server): Promise<AgentLoad> => {
      try {
        const view = (await server.client
          .rpc(AcpSettings)
          .importAgents({}, { signal: AbortSignal.timeout(AGENT_TIMEOUT_MS) })) as ImportAgentsView;
        return { server, agents: view.agents };
      } catch (error) {
        const type = typeof error === "object" && error !== null && "type" in error ? error.type : undefined;
        return { server, failed: true, methodMissing: type === "rpc.method_not_found" };
      }
    }),
  );
}

/** Lists one agent's sessions. Undefined means the agent could not list them. */
export async function loadImportSessions(
  server: ServerRef,
  agentID: string,
  cwd: string | undefined,
  signal: AbortSignal,
): Promise<readonly ImportableSession[] | undefined> {
  try {
    const view = (await server.client
      .rpc(AcpSettings)
      .importableSessions(
        { agentID, ...(cwd === undefined ? {} : { cwd }) },
        { signal: AbortSignal.any([signal, AbortSignal.timeout(SESSIONS_TIMEOUT_MS)]) },
      )) as ImportSessionsView;
    return view.sessions;
  } catch {
    return undefined;
  }
}
