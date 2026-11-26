import { RequestError, type SessionConfigOption, type SessionInfo, type SessionUpdate } from "@agentclientprotocol/sdk";
import { Plugin } from "@opencode/plugin";
import { statSync } from "node:fs";
import { AcpStartError } from "./acp/errors.js";
import { AcpClient } from "./acp/client.js";
import { selectOption, type Catalog } from "./acp/catalog.js";
import { AgentRuntime, findExecutable, type AgentState } from "./acp/runtime.js";
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
import { logError, logInfo, logWarn, setLogLevel, type LogLevel } from "./log.js";
import { clearCatalog, loadCatalog, saveCatalog } from "./provider/catalog.js";
import { PACKAGE, registerProviders } from "./provider/register.js";
import {
  AcpSettings,
  AGENT_ID,
  type AbortImportInput,
  type AgentInput,
  type AgentStatus,
  type ImportableAgent,
  type ImportableSession,
  type ImportableView,
  type ImportStatus,
  type MutationResult,
  type PrepareImportResult,
  type SettingsView,
} from "./rpc.js";
import { SessionBindings, type SessionBindingEntry } from "./session/binding.js";
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
    const { registrations, occupied } = await registerProviders(ctx, {
      agents: running,
      bindings,
      titles,
      requestPermission: (params, turn) => permissions.request(params, turn),
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
      importableSessions() {
        return listImportableSessions(ctx, bindings);
      },
      prepareImport(input) {
        const { agentID, sessionID } = input as { agentID: string; sessionID: string };
        return prepareImport(ctx, bindings, agentID, sessionID);
      },
      abortImport(input) {
        return abortImport(ctx, bindings, input as AbortImportInput);
      },
    });

    return async () => {
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

async function listImportableSessions(ctx: Plugin.Context, bindings: SessionBindings): Promise<ImportableView> {
  const agents: ImportableAgent[] = [];
  const sessions: ImportableSession[] = [];
  const live = new Map<string, boolean>();

  for (const agent of state.config.agents) {
    const active = running.get(agent.id);
    const reason = unavailableReason(agent, active);
    if (reason !== undefined || active === undefined) {
      agents.push({ id: agent.id, name: agent.name, status: "unavailable", reason: reason ?? "notRunning" });
      continue;
    }
    if ((active.catalog?.models.length ?? 0) === 0) {
      agents.push({ id: agent.id, name: agent.name, status: "unavailable", reason: "noModels" });
      continue;
    }

    let client: AcpClient;
    try {
      client = await active.runtime.ensureClient();
    } catch (error) {
      logWarn("acp", `could not start ${agent.id} for session listing: ${message(error)}`);
      agents.push({ id: agent.id, name: agent.name, status: "unavailable", reason: "failed" });
      continue;
    }

    if (!client.canListSessions) {
      agents.push({ id: agent.id, name: agent.name, status: "unsupported", reason: "noList" });
      continue;
    }
    if (!client.canLoadSession) {
      agents.push({ id: agent.id, name: agent.name, status: "unsupported", reason: "noLoad" });
      continue;
    }

    let listed: SessionInfo[];
    try {
      listed = await client.listSessions();
    } catch (error) {
      logWarn("acp", `could not list ${agent.id} sessions: ${message(error)}`);
      agents.push({ id: agent.id, name: agent.name, status: "unavailable", reason: "listFailed" });
      continue;
    }

    let entries: SessionBindingEntry[];
    try {
      entries = await bindings.list(agent.id);
    } catch (error) {
      logWarn("acp", `could not read ${agent.id} bindings: ${message(error)}`);
      agents.push({ id: agent.id, name: agent.name, status: "unavailable", reason: "storageFailed" });
      continue;
    }

    const bound = new Map<string, string[]>();
    for (const entry of entries) {
      const ids = bound.get(entry.binding.sessionId) ?? [];
      ids.push(entry.sessionID);
      bound.set(entry.binding.sessionId, ids);
    }

    for (const info of listed) {
      const boundIDs = bound.get(info.sessionId);
      if (boundIDs !== undefined) {
        let isLive = false;
        for (const opencodeID of boundIDs) {
          const exists = live.get(opencodeID) ?? (await sessionExists(ctx, opencodeID));
          live.set(opencodeID, exists);
          if (exists) {
            isLive = true;
            break;
          }
        }
        if (isLive) continue;
      }

      sessions.push({
        agentID: agent.id,
        id: info.sessionId,
        title: info.title?.trim() ?? "",
        cwd: info.cwd,
        updatedAt: info.updatedAt ?? "",
        available: directoryExists(info.cwd),
      });
    }

    agents.push({ id: agent.id, name: agent.name, status: "ready", reason: "" });
  }

  sessions.sort((a, b) => {
    const left = Date.parse(a.updatedAt);
    const right = Date.parse(b.updatedAt);
    const l = Number.isFinite(left) ? left : 0;
    const r = Number.isFinite(right) ? right : 0;
    return l === r ? (a.title || a.cwd).localeCompare(b.title || b.cwd) : r - l;
  });

  return { agents, sessions };
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
