import { usePlugin, type ServerRef } from "@opencode/plugin/gui";
import { createSignal, onCleanup } from "solid-js";
import { definition } from "../definition.js";
import { loadImportAgents, loadImportSessions } from "./load.js";
import { agentKey, rowKey, type ImportAgentNote, type ImportRowData } from "./model.js";

/** Loads agent statuses and their sessions. Never starts an agent. */
export function createImportController(options: { scopeRoot(): string | undefined }) {
  const ctx = usePlugin<typeof definition>();
  const [agents, setAgents] = createSignal<ImportAgentNote[]>([]);
  const [rows, setRows] = createSignal<ImportRowData[]>([]);
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
      setError(ctx.t("import.noServers"));
      setLoading(false);
      return;
    }

    const results = await loadImportAgents(servers);
    if (signal.aborted) return;

    const next: ImportAgentNote[] = [];
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
    if (missing.length > 0) setError(ctx.t("import.updatePluginServers", { servers: missing.join(", ") }));
    else if (failed.length > 0) setError(ctx.t("import.serverFailed", { servers: failed.join(", ") }));

    const ready = next.filter((agent) => agent.status === "ready");
    setReading(Object.fromEntries(ready.map((agent) => [agent.key, true])));
    await Promise.all(ready.map((agent) => fetchSessions(agent, signal, current)));
  }

  async function fetchSessions(agent: ImportAgentNote, signal: AbortSignal, current: number) {
    const sessions = await loadImportSessions(agent.server, agent.id, options.scopeRoot(), signal);
    if (signal.aborted || current !== generation) return;

    setReading((previous) => {
      if (previous[agent.key] !== true) return previous;
      const next = { ...previous };
      delete next[agent.key];
      return next;
    });

    if (sessions === undefined) {
      setAgents((list) =>
        list.map((item): ImportAgentNote =>
          item.key === agent.key ? { ...item, status: "unavailable", reason: "listFailed" } : item,
        ),
      );
      return;
    }

    setAgents((list) =>
      list.map((item): ImportAgentNote =>
        item.key === agent.key && item.status !== "ready" ? { ...item, status: "ready", reason: "" } : item,
      ),
    );

    const mapped: ImportRowData[] = sessions.map((session) => ({
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
