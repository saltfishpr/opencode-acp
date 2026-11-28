import { usePlugin, type ServerRef } from "@opencode/plugin/gui";
import { createSignal, onCleanup } from "solid-js";
import { AcpRpc, type AgentSessionView, type SessionAgentView } from "../../rpc.js";
import { definition } from "../definition.js";
import { waitForLocation } from "../shared/location.js";
import { agentKey, rowKey, type SessionAgentNote, type SessionRowData } from "./model.js";

const AGENTS_TIMEOUT_MS = 30_000;
const SESSIONS_TIMEOUT_MS = 60_000;

type AgentLoad =
  | { readonly server: ServerRef; readonly agents: readonly SessionAgentView[] }
  | { readonly server: ServerRef; readonly failed: true; readonly methodMissing: boolean };

/** Loads agent statuses and their sessions. Never starts an agent. */
export function createSessionListController(options: { scopeRoot(): string | undefined }) {
  const ctx = usePlugin<typeof definition>();
  const [agents, setAgents] = createSignal<SessionAgentNote[]>([]);
  const [rows, setRows] = createSignal<SessionRowData[]>([]);
  const [reading, setReading] = createSignal<Record<string, boolean>>({});
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string>();

  let controller = new AbortController();
  let generation = 0;

  const targets = () =>
    ctx.servers
      .list()
      .map((id) => ctx.servers.get(id))
      .filter((server): server is ServerRef => server !== undefined && server.connected && server.compatible);

  onCleanup(() => controller.abort());

  async function load() {
    const servers = targets();
    controller.abort();
    controller = new AbortController();
    const signal = controller.signal;
    const current = ++generation;

    setLoading(true);
    setError(undefined);
    setRows([]);
    setAgents([]);
    setReading({});

    if (servers.length === 0) {
      setError(ctx.t("sessions.noServers"));
      setLoading(false);
      return;
    }

    const results = await loadAgents(servers, signal);
    if (signal.aborted || current !== generation) return;

    const next: SessionAgentNote[] = [];
    const failed: string[] = [];
    const missing: string[] = [];
    for (const result of results) {
      if ("failed" in result) {
        (result.methodMissing ? missing : failed).push(result.server.name);
        continue;
      }
      for (const agent of result.agents) {
        next.push({ ...agent, server: result.server, key: agentKey(result.server.id, agent.id) });
      }
    }

    setAgents(next);
    setLoading(false);
    if (missing.length > 0) setError(ctx.t("sessions.updatePluginServers", { servers: missing.join(", ") }));
    else if (failed.length > 0) setError(ctx.t("sessions.serverFailed", { servers: failed.join(", ") }));

    const ready = next.filter((agent) => agent.status === "ready");
    setReading(Object.fromEntries(ready.map((agent) => [agent.key, true])));
    await Promise.all(ready.map((agent) => fetchSessions(agent, signal, current)));
  }

  async function fetchSessions(agent: SessionAgentNote, signal: AbortSignal, current: number) {
    const sessions = await loadSessions(agent.server, agent.id, options.scopeRoot(), signal);
    if (signal.aborted || current !== generation) return;

    setReading((previous) => {
      if (previous[agent.key] !== true) return previous;
      const next = { ...previous };
      delete next[agent.key];
      return next;
    });

    if (sessions === undefined) {
      setAgents((list) =>
        list.map((item): SessionAgentNote =>
          item.key === agent.key ? { ...item, status: "unavailable", reason: "listFailed" } : item,
        ),
      );
      return;
    }

    setAgents((list) =>
      list.map((item): SessionAgentNote =>
        item.key === agent.key && item.status !== "ready" ? { ...item, status: "ready", reason: "" } : item,
      ),
    );

    const mapped: SessionRowData[] = sessions.map((session) => ({
      ...session,
      server: agent.server,
      key: rowKey(agent.server.id, session.agentID, session.id),
    }));
    setRows((list) => [
      ...list.filter((row) => !(row.server.id === agent.server.id && row.agentID === agent.id)),
      ...mapped,
    ]);
  }

  /** Re-reads sessions for agents that already listed them, keeping the agent list. */
  async function reload() {
    const signal = controller.signal;
    const current = ++generation;
    const ready = agents().filter(
      (agent) => agent.status === "ready" || (agent.status === "unavailable" && agent.reason === "listFailed"),
    );
    setReading(Object.fromEntries(ready.map((agent) => [agent.key, true])));
    setRows((list) =>
      list.filter((row) => !ready.some((agent) => agent.server.id === row.server.id && agent.id === row.agentID)),
    );
    await Promise.all(ready.map((agent) => fetchSessions(agent, signal, current)));
  }

  return {
    agents,
    rows,
    reading,
    loading,
    error,
    setError,
    signal: () => controller.signal,
    load,
    reload,
  };
}

async function loadAgents(servers: readonly ServerRef[], signal: AbortSignal): Promise<AgentLoad[]> {
  return Promise.all(
    servers.map(async (server): Promise<AgentLoad> => {
      try {
        const view = await server.client
          .rpc(AcpRpc)
          .listAgents({}, { signal: AbortSignal.any([signal, AbortSignal.timeout(AGENTS_TIMEOUT_MS)]) });
        return { server, agents: view.agents };
      } catch (error) {
        return { server, failed: true, methodMissing: errorType(error) === "rpc.method_not_found" };
      }
    }),
  );
}

async function loadSessions(
  server: ServerRef,
  agentID: string,
  cwd: string | undefined,
  signal: AbortSignal,
): Promise<readonly AgentSessionView[] | undefined> {
  if (cwd !== undefined) await waitForLocation(server, cwd, signal);
  try {
    const view = await server.client.rpc(AcpRpc).listSessions(
      { agentID, ...(cwd === undefined ? {} : { cwd }) },
      {
        ...(cwd === undefined ? {} : { location: { directory: cwd } }),
        signal: AbortSignal.any([signal, AbortSignal.timeout(SESSIONS_TIMEOUT_MS)]),
      },
    );
    return view.sessions;
  } catch {
    return undefined;
  }
}

function errorType(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("type" in error)) return undefined;
  return typeof error.type === "string" ? error.type : undefined;
}
