import { RequestError, type SessionConfigOption, type SessionInfo, type SessionUpdate } from "@agentclientprotocol/sdk";
import { Plugin } from "@opencode/plugin";
import { statSync } from "node:fs";
import { AcpStartError } from "./acp/errors.js";
import { AcpClient } from "./acp/client.js";
import { selectOption, valuesOf, type Catalog } from "./acp/catalog.js";
import { AgentRuntime, findExecutable, type AgentState } from "./acp/runtime.js";
import { restoreSession } from "./acp/session.js";
import {
  EMPTY_CONFIG,
  PLUGIN_ID,
  isLogLevel,
  readConfig,
  sameLaunch,
  type AgentConfig,
  type Config,
} from "./config.js";
import { PermissionBroker } from "./interaction/permission.js";
import { ElicitationBroker } from "./interaction/elicitation.js";
import { logError, logInfo, logWarn, setLogLevel, type LogLevel } from "./log.js";
import { clearCatalog, loadCatalog, saveCatalog } from "./provider/catalog.js";
import { PACKAGE, registerProviders } from "./provider/register.js";
import {
  AcpSettings,
  AGENT_ID,
  type AbortImportInput,
  type AgentInput,
  type AgentStatus,
  type DeleteSessionInput,
  type ImportableAgent,
  type ImportableSession,
  type ImportableSessionsInput,
  type ImportAgentsView,
  type ImportSessionsView,
  type ImportStatus,
  type MutationResult,
  type PrepareImportResult,
  type SessionOptionView,
  type SessionOptionsView,
  type SettingsView,
} from "./rpc.js";
import { SessionBindings, type AcpBinding, type SessionBindingEntry } from "./session/binding.js";
import { buildImportPayload, type HistoryModel, type ImportPayload } from "./session/history.js";
import { SessionTitles } from "./session/title.js";

// Storage and processes belong to the server; provider registrations belong to each location.
const SETTINGS_KEY = "acp/settings";
const stateKey = Symbol.for("opencode-acp/server-state/v1");
interface ServerState {
  readonly locations: Map<Plugin.Context, ReadonlySet<string>>;
  readonly running: Map<string, AgentState>;
  readonly contextWindows: WeakMap<AgentRuntime, number>;
  /** Shared across locations so an imported title follows the session. */
  readonly titles: SessionTitles;
  readonly onExit: () => void;
  config: Config;
  queue: Promise<void>;
}

// OpenCode can evaluate a separate copy of the plugin module for each location.
const scope = globalThis as typeof globalThis & { [stateKey]?: ServerState };
const state: ServerState = (scope[stateKey] ??= {
  locations: new Map(),
  running: new Map(),
  contextWindows: new WeakMap(),
  titles: new SessionTitles(),
  onExit: closeAgents,
  config: EMPTY_CONFIG,
  queue: Promise.resolve(),
});
const { locations, running, contextWindows } = state;

export default Plugin.define({
  id: PLUGIN_ID,
  async setup(ctx) {
    const titles = state.titles;
    const bindings = new SessionBindings(ctx.storage);
    const permissions = new PermissionBroker(ctx);
    const elicitations = new ElicitationBroker();
    const { registrations, occupied } = await registerProviders(ctx, {
      agents: running,
      bindings,
      titles,
      requestPermission: (params, turn) => permissions.request(params, turn),
      requestElicitation: (params, turn) => elicitations.request(params, turn),
      onContextWindow(runtime, size) {
        if (contextWindows.get(runtime) === size) return;
        contextWindows.set(runtime, size);
        setTimeout(() => {
          if (running.get(runtime.agent.id)?.runtime === runtime) void reloadProviders();
        }, 0).unref();
      },
    });

    try {
      await enqueue(async () => {
        if (locations.size === 0) {
          state.config = readConfig(await ctx.storage.get(SETTINGS_KEY));
          setLogLevel(state.config.logLevel);
          process.on("exit", state.onExit);
          for (const agent of state.config.agents) await startAgent(ctx, agent);
        }
        locations.set(ctx, occupied);
        await reloadProviders([ctx]);
      });
    } catch (error) {
      permissions.close();
      throw error;
    }

    const rpc = await ctx.rpc.register(AcpSettings, {
      async settings() {
        return enqueue(async () => settingsView());
      },
      saveAgent(input) {
        const { revision, create, agent } = input as { revision: number; create: boolean; agent: AgentInput };
        return mutate(revision, async () => {
          const previous = state.config.agents.find((item) => item.id === agent.id);
          if (create && previous !== undefined) return { status: "duplicate", field: "id" };
          if (!create && previous === undefined) return { status: "notFound" };
          if (!AGENT_ID.test(agent.id)) return { status: "invalid", field: "id" };
          if (!agent.name.trim() || agent.name.includes("\0")) return { status: "invalid", field: "name" };
          const command = agent.command.trim();
          if (!command || command.includes("\0")) return { status: "invalid", field: "command" };
          if (agent.args.some((arg) => arg.includes("\0"))) return { status: "invalid", field: "args" };
          if (create) {
            for (const [location, occupied] of locations) {
              const { data } = await location.provider.list();
              if (
                occupied.has(agent.id) ||
                data.some((provider) => provider.id === agent.id && provider.package !== PACKAGE)
              ) {
                return { status: "duplicate", field: "id" };
              }
            }
          }
          const env: Record<string, string> = Object.create(null);
          for (const [key, value] of Object.entries(agent.env)) {
            if (!key || value?.includes("\0")) return { status: "invalid", field: "env" };
            if (value !== null) env[key] = value;
            else {
              const saved = previous?.env[key];
              if (typeof saved !== "string") return { status: "invalid", field: "env" };
              env[key] = saved;
            }
          }
          const next = { ...agent, name: agent.name.trim(), command, env };
          return saveAgent(ctx, agent.id, previous, {
            ...next,
            enabled: previous?.enabled ?? true,
          });
        });
      },
      setEnabled(input) {
        const { revision, id, enabled } = input as { revision: number; id: string; enabled: boolean };
        return mutate(revision, async () => {
          const agent = state.config.agents.find((item) => item.id === id);
          if (agent === undefined) return { status: "notFound" };
          if (agent.enabled === enabled) return { status: "ok" };
          return saveAgent(ctx, id, agent, { ...agent, enabled });
        });
      },
      removeAgent(input) {
        const { revision, id } = input as { revision: number; id: string };
        return mutate(revision, async () => {
          const agent = state.config.agents.find((item) => item.id === id);
          if (agent === undefined) return { status: "notFound" };
          return saveAgent(ctx, id, agent, undefined);
        });
      },
      retryAgent(input) {
        const { revision, id } = input as { revision: number; id: string };
        return mutate(revision, async () => {
          const agent = state.config.agents.find((item) => item.id === id);
          if (agent === undefined) return { status: "notFound" };
          if (!agent.enabled) return { status: "conflict" };
          const active = running.get(id);
          if (active?.status === "discovering") return { status: "ok" };
          if (active !== undefined && !active.runtime.pause()) return { status: "busy" };
          stopAgent(id);
          await startAgent(ctx, agent);
          await reloadProviders();
          return { status: "ok" };
        });
      },
      setLogLevel(input) {
        const { revision, logLevel } = input as { revision: number; logLevel: LogLevel };
        return mutate(revision, async () => {
          if (!isLogLevel(logLevel)) return { status: "invalid" };
          if (logLevel !== state.config.logLevel) {
            await persist(ctx, { ...state.config, logLevel });
            setLogLevel(logLevel);
          }
          return { status: "ok" };
        });
      },
      importAgents() {
        return Promise.resolve(listImportAgents());
      },
      importableSessions(input) {
        return listImportableSessions(ctx, bindings, input as ImportableSessionsInput);
      },
      prepareImport(input) {
        const { agentID, sessionID } = input as { agentID: string; sessionID: string };
        return prepareImport(ctx, bindings, agentID, sessionID);
      },
      abortImport(input) {
        return abortImport(ctx, bindings, input as AbortImportInput);
      },
      deleteSession(input) {
        return deleteAgentSession(ctx, bindings, input as DeleteSessionInput);
      },
      sessionOptions(input) {
        return readSessionOptions(ctx, bindings, (input as { sessionID: string }).sessionID);
      },
      setSessionOption(input) {
        const { sessionID, configID, value } = input as {
          sessionID: string;
          configID: string;
          value: string | boolean;
        };
        return applySessionOption(ctx, bindings, sessionID, configID, value);
      },
      claimElicitation(input) {
        return Promise.resolve({ claimed: elicitations.claim((input as { requestID: string }).requestID) });
      },
      answerElicitation(input) {
        const { requestID, action, content } = input as {
          requestID: string;
          action: "accept" | "cancel" | "decline";
          content?: Record<string, unknown>;
        };
        const answered = elicitations.answer(requestID, action, content);
        return Promise.resolve<MutationResult>({ status: answered ? "ok" : "notFound" });
      },
      elicitationForm(input) {
        const { requestID, formID } = input as { requestID: string; formID: string };
        return Promise.resolve<MutationResult>({
          status: elicitations.form(requestID, formID) ? "ok" : "notFound",
        });
      },
      pendingElicitations() {
        return Promise.resolve({ requests: elicitations.pendingRequests() });
      },
    });

    elicitations.attach({
      request(view) {
        void rpc.events
          .emit("elicitation", view as unknown as Record<string, unknown>)
          .catch((error: unknown) => logWarn("acp", `could not publish an elicitation: ${message(error)}`));
      },
      cancelled(requestID) {
        return rpc.events
          .emit("elicitationCancelled", { requestID })
          .catch((error: unknown) => logWarn("acp", `could not cancel an elicitation: ${message(error)}`));
      },
    });

    return async () => {
      // Let GUI windows cancel their forms before the RPC channel goes away.
      await elicitations.close();
      await rpc.dispose();
      await enqueue(async () => {
        locations.delete(ctx);
        if (locations.size === 0) {
          process.off("exit", state.onExit);
          closeAgents();
          titles.clear();
        }
      });
      permissions.close();
      await Promise.all(registrations.map((registration) => registration.dispose()));
    };
  },
});

function settingsView(): SettingsView {
  const { config } = state;
  return {
    revision: config.revision,
    logLevel: config.logLevel,
    agents: config.agents.map(({ id, name, command, args, env, enabled }) => {
      const active = running.get(id);
      const exited = active?.runtime.status.exit !== undefined;
      const status: AgentStatus = !enabled
        ? "disabled"
        : active === undefined
          ? "missing"
          : exited
            ? "failed"
            : active.status;
      return {
        id,
        name,
        command,
        args,
        enabled,
        status,
        envKeys: Object.keys(env),
        modelCount: active?.catalog?.models.length ?? 0,
        failure: active?.failure || (exited ? "exited" : ""),
      };
    }),
  };
}

function listImportAgents(): ImportAgentsView {
  return {
    agents: state.config.agents.map((agent) => importAgentView(agent, running.get(agent.id))),
  };
}

/** Describes one agent without starting it. */
function importAgentView(agent: AgentConfig, active: AgentState | undefined): ImportableAgent {
  const base = { id: agent.id, name: agent.name };
  if (!agent.enabled) return { ...base, status: "disabled", reason: "disabled" };
  if (active === undefined) return { ...base, status: "unavailable", reason: "notRunning" };
  if (active.status === "discovering") return { ...base, status: "unavailable", reason: "discovering" };
  if (active.status === "failed") return { ...base, status: "unavailable", reason: active.failure || "failed" };
  if (!active.runtime.status.running)
    return { ...base, status: "stopped", reason: active.runtime.status.exit !== undefined ? "exited" : "notRunning" };
  if ((active.catalog?.models.length ?? 0) === 0) return { ...base, status: "unavailable", reason: "noModels" };

  const capabilities = active.runtime.sessionCapabilities;
  if (capabilities === undefined || !capabilities.list) return { ...base, status: "unsupported", reason: "noList" };
  if (!capabilities.load) return { ...base, status: "unsupported", reason: "noLoad" };
  return { ...base, status: "ready", reason: "" };
}

async function listImportableSessions(
  ctx: Plugin.Context,
  bindings: SessionBindings,
  input: ImportableSessionsInput,
): Promise<ImportSessionsView> {
  const agent = state.config.agents.find((item) => item.id === input.agentID);
  if (agent === undefined) return { sessions: [] };

  const active = running.get(agent.id);
  if (active === undefined || importAgentView(agent, active).status !== "ready") return { sessions: [] };

  let client: AcpClient;
  try {
    client = await active.runtime.ensureClient();
  } catch (error) {
    logWarn("acp", `could not start ${agent.id} for session listing: ${message(error)}`);
    return { sessions: [] };
  }

  let listed: SessionInfo[];
  try {
    listed = await client.listSessions(input.cwd);
  } catch (error) {
    logWarn("acp", `could not list ${agent.id} sessions: ${message(error)}`);
    throw error;
  }

  // An agent may treat `cwd` as an exact match. Retry unfiltered so sessions in
  // subdirectories still appear; the local filter below keeps the scope.
  if (input.cwd !== undefined && listed.length === 0) {
    try {
      listed = await client.listSessions();
    } catch (error) {
      logWarn("acp", `could not list ${agent.id} sessions: ${message(error)}`);
      throw error;
    }
  }

  // Covers agents that ignore the `cwd` hint and sessions in subdirectories.
  const scoped = input.cwd === undefined ? listed : listed.filter((info) => withinPath(info.cwd, input.cwd!));

  let entries: SessionBindingEntry[];
  try {
    entries = await bindings.list(agent.id);
  } catch (error) {
    logWarn("acp", `could not read ${agent.id} bindings: ${message(error)}`);
    throw error;
  }

  const bound = new Map<string, string[]>();
  for (const entry of entries) {
    const ids = bound.get(entry.binding.sessionId) ?? [];
    ids.push(entry.sessionID);
    bound.set(entry.binding.sessionId, ids);
  }

  const live = await liveSessions(ctx, scoped, bound);

  const sessions: ImportableSession[] = [];
  for (const info of scoped) {
    const boundIDs = bound.get(info.sessionId);
    if (boundIDs !== undefined && boundIDs.some((id) => live.has(id))) continue;
    sessions.push({
      agentID: agent.id,
      id: info.sessionId,
      title: info.title?.trim() ?? "",
      cwd: info.cwd,
      updatedAt: info.updatedAt ?? "",
      available: directoryExists(info.cwd),
    });
  }

  sessions.sort((a, b) => {
    const left = Date.parse(a.updatedAt);
    const right = Date.parse(b.updatedAt);
    const l = Number.isFinite(left) ? left : 0;
    const r = Number.isFinite(right) ? right : 0;
    return l === r ? (a.title || a.cwd).localeCompare(b.title || b.cwd) : r - l;
  });

  return { sessions };
}

/**
 * OpenCode session IDs that still exist for the directories holding bound
 * sessions. One list call per directory replaces one get per binding.
 */
async function liveSessions(
  ctx: Plugin.Context,
  sessions: readonly SessionInfo[],
  bound: ReadonlyMap<string, readonly string[]>,
): Promise<ReadonlySet<string>> {
  const live = new Set<string>();
  const directories = new Set<string>();
  for (const info of sessions) {
    if (bound.has(info.sessionId)) directories.add(info.cwd);
  }

  for (const directory of directories) {
    let cursor: string | undefined;
    for (let page = 0; page < 10; page++) {
      try {
        const response = await ctx.session.list({
          directory,
          limit: 1000,
          ...(cursor === undefined ? {} : { cursor }),
        });
        for (const session of response.data) live.add(session.id);
        const next = response.cursor.next ?? undefined;
        if (next === undefined || next === cursor) break;
        cursor = next;
      } catch (error) {
        logWarn("acp", `could not check OpenCode sessions in ${directory}: ${message(error)}`);
        break;
      }
    }
  }

  return live;
}

async function prepareImport(
  ctx: Plugin.Context,
  bindings: SessionBindings,
  agentID: string,
  acpSessionID: string,
): Promise<PrepareImportResult> {
  const failed = (status: ImportStatus, reason: string): PrepareImportResult => ({
    status,
    sessionID: "",
    reason,
  });

  const agent = state.config.agents.find((item) => item.id === agentID);
  if (agent === undefined) return failed("notFound", "agent");

  const active = running.get(agentID);
  const unavailable = unavailableReason(agent, active);
  if (unavailable !== undefined || active === undefined) return failed("unavailable", unavailable ?? "notRunning");
  if ((active.catalog?.models.length ?? 0) === 0) return failed("unavailable", "noModels");

  let client: AcpClient;
  try {
    client = await active.runtime.ensureClient();
  } catch (error) {
    logWarn("acp", `could not start ${agentID} for import: ${message(error)}`);
    return failed("unavailable", "failed");
  }

  if (!client.canListSessions) return failed("unsupported", "noList");
  if (!client.canLoadSession) return failed("unsupported", "noLoad");

  let listed: SessionInfo[];
  try {
    listed = await client.listSessions();
  } catch (error) {
    logWarn("acp", `could not list ${agentID} sessions for import: ${message(error)}`);
    return failed("unavailable", "listFailed");
  }

  const info = listed.find((item) => item.sessionId === acpSessionID);
  if (info === undefined) return failed("notFound", "session");
  if (!directoryExists(info.cwd)) return failed("notFound", "directoryMissing");

  let entries: SessionBindingEntry[];
  try {
    entries = await bindings.list(agentID);
  } catch (error) {
    logWarn("acp", `could not read ${agentID} bindings for import: ${message(error)}`);
    return failed("saveFailed", "storage");
  }

  const stale: string[] = [];
  for (const entry of entries) {
    if (entry.binding.sessionId !== acpSessionID) continue;
    if (await sessionExists(ctx, entry.sessionID)) return failed("alreadyBound", "");
    stale.push(entry.sessionID);
  }

  const pending = active.runtime.lock(`import:${acpSessionID}`);
  if (pending === undefined) return failed("unavailable", "busy");
  const release = await pending;

  try {
    const history: SessionUpdate[] = [];
    try {
      await loadForImport(client, acpSessionID, info.cwd, history);
    } catch (error) {
      logWarn("acp", `could not load ${acpSessionID} for import: ${message(error)}`);
      return failed("loadFailed", "load");
    }

    const model = chooseModel(agentID, active.catalog, client.configOptions(acpSessionID));
    if (model === undefined) return failed("unavailable", "noModels");

    const opencodeSessionID = newSessionID();
    let payload: ImportPayload;
    try {
      payload = await buildImportPayload({
        agentID,
        agentName: agent.name,
        acpSessionID,
        opencodeSessionID,
        cwd: info.cwd,
        title: info.title?.trim() ?? "",
        updatedAt: info.updatedAt ?? "",
        model,
        updates: history,
      });
    } catch (error) {
      logWarn("acp", `could not build the import payload for ${acpSessionID}: ${message(error)}`);
      return failed("loadFailed", "history");
    }

    try {
      await bindings.save(agentID, opencodeSessionID, { sessionId: acpSessionID, cwd: info.cwd });
    } catch (error) {
      logWarn("acp", `could not save the import binding for ${acpSessionID}: ${message(error)}`);
      return failed("saveFailed", "binding");
    }

    if (payload.title.length > 0) state.titles.remember(opencodeSessionID, payload.title);
    for (const staleID of stale) {
      await bindings.remove(agentID, staleID).catch((error: unknown) => {
        logWarn("acp", `could not remove stale binding ${staleID}: ${message(error)}`);
      });
    }

    logInfo("acp", `prepared import of ${acpSessionID} as ${opencodeSessionID}`);
    return {
      status: "ok",
      sessionID: opencodeSessionID,
      reason: "",
      payload: {
        info: payload.info,
        messages: payload.messages,
        location: payload.location,
      },
    };
  } finally {
    release();
  }
}

async function abortImport(
  ctx: Plugin.Context,
  bindings: SessionBindings,
  input: AbortImportInput,
): Promise<MutationResult> {
  if (await sessionExists(ctx, input.opencodeSessionID)) return { status: "ok" };

  try {
    await bindings.remove(input.agentID, input.opencodeSessionID);
  } catch (error) {
    logWarn("acp", `could not remove the import binding ${input.opencodeSessionID}: ${message(error)}`);
    return { status: "saveFailed" };
  }

  const active = running.get(input.agentID);
  if (active !== undefined && active.runtime.status.running) {
    try {
      const client = await active.runtime.ensureClient();
      if (client.hasSession(input.sessionID)) await client.closeSession(input.sessionID);
    } catch (error) {
      logWarn("acp", `could not close the imported ACP session ${input.sessionID}: ${message(error)}`);
    }
  }

  return { status: "ok" };
}

async function loadForImport(
  client: AcpClient,
  sessionID: string,
  cwd: string,
  history: SessionUpdate[],
): Promise<void> {
  try {
    await client.loadSession(sessionID, cwd, history);
  } catch (error) {
    if (!client.hasSession(sessionID) || !client.canCloseSession) throw error;
    await client.closeSession(sessionID);
    history.length = 0;
    await client.loadSession(sessionID, cwd, history);
  }
}

function chooseModel(
  agentID: string,
  catalog: Catalog | undefined,
  options: readonly SessionConfigOption[],
): HistoryModel | undefined {
  if (catalog === undefined) return undefined;

  const remote = selectOption(options, "model")?.currentValue;
  const model =
    catalog.models.find((item) => item.id === remote) ??
    catalog.models.find((item) => item.id === catalog.defaultModel) ??
    catalog.models[0];
  if (model === undefined) return undefined;

  const thought = selectOption(options, "thought_level")?.currentValue;
  const variant =
    thought !== undefined && thought !== "default" && model.thoughts.some((item) => item.value === thought)
      ? thought
      : undefined;

  return { providerID: agentID, id: model.id, ...(variant === undefined ? {} : { variant }) };
}

interface ResolvedSession {
  readonly client: AcpClient;
  readonly sessionId: string;
}

type SessionResolution = ResolvedSession | { readonly status: "notAcp" | "unbound" | "unavailable" };

/**
 * Finds the ACP agent, client and ACP session behind an OpenCode session.
 * Reloads the ACP session when the process no longer has it.
 */
async function resolveAcpSession(
  ctx: Plugin.Context,
  bindings: SessionBindings,
  sessionID: string,
): Promise<SessionResolution> {
  let providerID: string | undefined;
  try {
    const session = await ctx.session.get({ sessionID });
    providerID = session.model?.providerID;
  } catch {
    return { status: "unavailable" };
  }

  const agent = providerID === undefined ? undefined : state.config.agents.find((item) => item.id === providerID);
  if (agent === undefined) return { status: "notAcp" };

  const active = running.get(agent.id);
  if (active === undefined || !active.runtime.status.running || active.status === "failed") {
    return { status: "unavailable" };
  }

  let binding: AcpBinding | undefined;
  try {
    binding = await bindings.get(agent.id, sessionID);
  } catch (error) {
    logWarn("acp", `could not read the binding for ${sessionID}: ${message(error)}`);
    return { status: "unavailable" };
  }
  if (binding === undefined) return { status: "unbound" };

  let client: AcpClient;
  try {
    client = await active.runtime.ensureClient();
  } catch (error) {
    logWarn("acp", `could not start ${agent.id} for session settings: ${message(error)}`);
    return { status: "unavailable" };
  }

  if (!client.hasSession(binding.sessionId)) {
    const restored = await restoreSession(client, binding.sessionId, binding.cwd);
    if (!restored.restored) return { status: "unavailable" };
  }

  return { client, sessionId: binding.sessionId };
}

async function deleteAgentSession(
  ctx: Plugin.Context,
  bindings: SessionBindings,
  input: DeleteSessionInput,
): Promise<MutationResult> {
  const agent = state.config.agents.find((item) => item.id === input.agentID);
  const active = running.get(input.agentID);
  if (agent === undefined || active === undefined) return { status: "notFound" };

  let client: AcpClient;
  try {
    client = await active.runtime.ensureClient();
  } catch (error) {
    logWarn("acp", `could not start ${input.agentID} for session deletion: ${message(error)}`);
    return { status: "saveFailed" };
  }
  if (!client.canDeleteSession) return { status: "unsupported" };

  let entries: SessionBindingEntry[];
  try {
    entries = await bindings.list(input.agentID);
  } catch (error) {
    logWarn("acp", `could not read ${input.agentID} bindings for deletion: ${message(error)}`);
    return { status: "saveFailed" };
  }

  const stale: string[] = [];
  for (const entry of entries) {
    if (entry.binding.sessionId !== input.sessionID) continue;
    if (await sessionExists(ctx, entry.sessionID)) return { status: "conflict" };
    stale.push(entry.sessionID);
  }

  for (const staleID of stale) {
    try {
      await bindings.remove(input.agentID, staleID);
    } catch (error) {
      logWarn("acp", `could not remove the stale binding ${staleID}: ${message(error)}`);
      return { status: "saveFailed" };
    }
  }

  try {
    await client.deleteSession(input.sessionID);
    logInfo("acp", `deleted ACP session ${input.sessionID}`);
    return { status: "ok" };
  } catch (error) {
    logWarn("acp", `could not delete the ACP session ${input.sessionID}: ${message(error)}`);
    return { status: "saveFailed" };
  }
}

async function readSessionOptions(
  ctx: Plugin.Context,
  bindings: SessionBindings,
  sessionID: string,
): Promise<SessionOptionsView> {
  const resolved = await resolveAcpSession(ctx, bindings, sessionID);
  if ("status" in resolved) return { status: resolved.status, options: [], commands: [] };
  return {
    status: "ok",
    options: sessionOptionViews(resolved.client, resolved.sessionId),
    commands: commandViews(resolved.client, resolved.sessionId),
  };
}

/** Commands the agent advertised for this session; read-only in the settings page. */
function commandViews(client: AcpClient, sessionId: string) {
  return client.commands(sessionId).map((command) => ({
    name: command.name,
    description: command.description,
    ...(command.input == null ? {} : { hint: command.input.hint }),
  }));
}

/** Combines config options with the legacy mode state into one list. */
function sessionOptionViews(client: AcpClient, sessionId: string): SessionOptionView[] {
  const options = client.configOptions(sessionId);
  // The model picker owns model and thinking level: the next turn's
  // `applySelection` would overwrite any change made here.
  const visible = options.filter((option) => !isModelOption(option));

  const views: SessionOptionView[] = visible.map((option) => {
    const base = {
      id: option.id,
      name: option.name,
      ...(option.description == null ? {} : { description: option.description }),
      ...(option.category == null ? {} : { category: option.category }),
    };

    if (option.type === "boolean") return { ...base, type: "boolean", current: option.currentValue };

    return {
      ...base,
      type: "select",
      current: option.currentValue,
      values: valuesOf(option).map((value) => ({
        value: value.value,
        name: value.name,
        ...(value.description == null ? {} : { description: value.description }),
      })),
    };
  });

  const hasMode = selectOption(options, "mode") !== undefined;
  const modes = client.modes(sessionId);
  if (!hasMode && modes !== undefined) {
    views.unshift({
      id: "__mode",
      name: "Mode",
      category: "mode",
      type: "select",
      current: modes.currentModeId,
      values: modes.availableModes.map((mode) => ({
        value: mode.id,
        name: mode.name,
        ...(mode.description == null ? {} : { description: mode.description }),
      })),
    });
  }

  return views;
}

/** Model and thinking level belong to the model picker, not the session settings. */
function isModelOption(option: SessionConfigOption): boolean {
  return [option.id, option.category ?? ""].some((value) => value === "model" || value === "thought_level");
}

async function applySessionOption(
  ctx: Plugin.Context,
  bindings: SessionBindings,
  sessionID: string,
  configID: string,
  value: string | boolean,
): Promise<MutationResult> {
  const resolved = await resolveAcpSession(ctx, bindings, sessionID);
  if ("status" in resolved) return { status: "notFound" };

  try {
    if (configID === "__mode") {
      if (typeof value !== "string") return { status: "invalid" };
      await resolved.client.setMode(resolved.sessionId, value);
      return { status: "ok" };
    }

    const option = resolved.client.configOptions(resolved.sessionId).find((item) => item.id === configID);
    if (option === undefined) return { status: "notFound" };
    if (option.type === "boolean" && typeof value !== "boolean") return { status: "invalid" };
    if (option.type === "select" && typeof value !== "string") return { status: "invalid" };

    await resolved.client.setConfigOption(resolved.sessionId, configID, value);
    return { status: "ok" };
  } catch (error) {
    logWarn("acp", `could not set ${configID} on ${resolved.sessionId}: ${message(error)}`);
    return { status: "saveFailed" };
  }
}

function newSessionID(): string {
  return `ses_${crypto.randomUUID().replaceAll("-", "")}`;
}

function unavailableReason(agent: AgentConfig, active: AgentState | undefined): string | undefined {
  if (!agent.enabled) return "disabled";
  if (active === undefined) return "notRunning";
  if (active.status === "discovering") return "discovering";
  if (active.status === "failed") return active.failure || "failed";
  if (!active.runtime.status.running) return active.runtime.status.exit !== undefined ? "exited" : "notRunning";
  return undefined;
}

async function sessionExists(ctx: Plugin.Context, sessionID: string): Promise<boolean> {
  try {
    await ctx.session.get({ sessionID });
    return true;
  } catch {
    return false;
  }
}

function directoryExists(directory: string): boolean {
  try {
    return statSync(directory).isDirectory();
  } catch {
    return false;
  }
}

/** Comparable form of an absolute path, so `/a/` and `/a` match. */
function pathKey(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/, "") || "/";
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
}

function withinPath(target: string, root: string): boolean {
  const key = pathKey(root);
  const value = pathKey(target);
  return key === "/" ? value.startsWith("/") : value === key || value.startsWith(`${key}/`);
}

function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const pending = state.queue.then(operation);
  state.queue = pending.then(
    () => {},
    () => {},
  );
  return pending;
}

function mutate(revision: number, operation: () => Promise<MutationResult>): Promise<MutationResult> {
  return enqueue(async () => {
    if (revision !== state.config.revision) return { status: "conflict" };
    try {
      return await operation();
    } catch (error) {
      logError("acp", `Could not update settings: ${message(error)}`);
      return { status: "saveFailed" };
    }
  });
}

async function persist(ctx: Plugin.Context, value: Config): Promise<void> {
  const next = { ...value, revision: state.config.revision + 1 };
  await ctx.storage.set(SETTINGS_KEY, {
    ...next,
    agents: next.agents.map((agent) => ({ ...agent, args: [...agent.args], env: { ...agent.env } })),
  });
  state.config = next;
}

async function saveAgent(
  ctx: Plugin.Context,
  id: string,
  previous: AgentConfig | undefined,
  next: AgentConfig | undefined,
): Promise<MutationResult> {
  const active = running.get(id);
  const launchChanged = previous !== undefined && next !== undefined && !sameLaunch(previous, next);
  const restart = launchChanged || previous?.enabled !== next?.enabled;
  if (restart && active !== undefined && !active.runtime.pause()) return { status: "busy" };

  try {
    const agents = state.config.agents.flatMap((agent) =>
      agent.id === id ? (next === undefined ? [] : [next]) : [agent],
    );
    if (previous === undefined && next !== undefined) agents.push(next);
    await persist(ctx, { ...state.config, agents });
  } catch (error) {
    active?.runtime.resume();
    throw error;
  }

  if (restart) {
    stopAgent(id);
    if (next !== undefined) await startAgent(ctx, next);
  } else if (active !== undefined && next !== undefined) {
    active.name = next.name;
  }
  if (next === undefined) await clearCatalog(ctx.storage, id);
  await reloadProviders();
  return { status: "ok" };
}

async function startAgent(ctx: Plugin.Context, agent: AgentConfig): Promise<void> {
  if (!agent.enabled) return;
  const path = findExecutable(agent);
  if (path === undefined) return;
  const active: AgentState = {
    runtime: new AgentRuntime(agent, path, () => {
      setTimeout(() => void reloadProviders(), 0).unref();
    }),
    name: agent.name,
    catalog: await loadCatalog(ctx.storage, agent),
    status: "discovering",
    failure: "",
  };
  running.set(agent.id, active);

  void (async () => {
    try {
      const client = await active.runtime.ensureClient();
      const catalog = await client.discoverModels(process.cwd());
      await enqueue(async () => {
        if (running.get(agent.id) !== active) return;
        if (catalog.models.length === 0) {
          active.status = "failed";
          active.failure = "noModels";
          return;
        }
        active.catalog = catalog;
        await reloadProviders();
        active.status = "ready";
        await saveCatalog(ctx.storage, agent, catalog);
        logInfo("acp", `${agent.id} offers ${catalog.models.length} models`);
      });
    } catch (error) {
      if (running.get(agent.id) !== active) return;
      active.status = "failed";
      const cause = error instanceof AcpStartError ? error.cause : error;
      active.failure =
        cause instanceof RequestError && cause.code === -32000
          ? "login"
          : error instanceof AcpStartError && error.exit !== undefined
            ? "exited"
            : cause instanceof Error && (cause.name === "AbortError" || cause.name === "TimeoutError")
              ? "timeout"
              : error instanceof AcpStartError && error.stage === "spawn"
                ? "spawn"
                : "discovery";
      logWarn("acp", `Model discovery failed for ${agent.id}: ${message(error)}`);
    }
  })();
}

function stopAgent(id: string): void {
  const active = running.get(id);
  running.delete(id);
  active?.runtime.close();
}

function closeAgents(): void {
  for (const id of running.keys()) stopAgent(id);
}

async function reloadProviders(targets: Iterable<Plugin.Context> = locations.keys()): Promise<void> {
  await Promise.all(
    [...targets].map((ctx) =>
      ctx.provider.reload().catch((error: unknown) => {
        logError("acp", `Could not refresh providers: ${message(error)}`);
      }),
    ),
  );
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
