import type { SessionInfo, SessionUpdate } from "@agentclientprotocol/sdk";
import type { Plugin } from "@opencode/plugin";
import { statSync } from "node:fs";
import type { AcpClient, AcpSession, ConfigOption } from "./acp/index.js";
import { AcpSessionBusyError } from "./acp/index.js";
import { catalogCommands, selectConfigOption, type AgentEntry, type AgentHub, type Catalog } from "./agent-hub.js";
import type { AgentConfig, Config } from "./config.js";
import { logInfo, logWarn } from "./log.js";
import { buildRebuiltSession, type HistoryModel } from "./projector/history.js";
import type {
  AgentSessionsView,
  DeleteSessionInput,
  ListSessionsInput,
  MutationResult,
  RebuildSessionInput,
  RebuildSessionResult,
  RunCommandInput,
  RunCommandResult,
  SessionCommandView,
  SessionMetaInput,
  SessionMetaView,
  SessionOptionView,
  SessionAgentsView,
  SessionStateInput,
  SessionStateView,
  SetSessionOptionInput,
} from "./rpc.js";

/** Where an OpenCode session points into an ACP agent, stored in its metadata. */
export interface AcpSessionMetadata {
  readonly agent: string;
  readonly session: string;
  readonly cwd: string;
  readonly updatedAt?: string;
}

/** Latest ACP title per OpenCode session, bounded so abandoned sessions do not leak. */
export class SessionTitles {
  private readonly titles = new Map<string, string>();

  constructor(private readonly limit = 500) {}

  remember(sessionID: string, title: string): boolean {
    const value = title.trim();
    if (value.length === 0) return false;
    if (this.titles.get(sessionID) === value) return false;

    this.titles.delete(sessionID);
    this.titles.set(sessionID, value);

    while (this.titles.size > this.limit) {
      const oldest = this.titles.keys().next().value;
      if (oldest === undefined) break;
      this.titles.delete(oldest);
    }
    return true;
  }

  get(sessionID: string): string | undefined {
    return this.titles.get(sessionID);
  }

  clear(): void {
    this.titles.clear();
  }
}

/**
 * Parses `metadata.acp`. Older sessions have no `cwd`; the OpenCode session's
 * own directory is the only safe substitute.
 */
export function readAcpMetadata(metadata: unknown, fallbackCwd?: string): AcpSessionMetadata | undefined {
  if (!isRecord(metadata)) return undefined;
  const acp = metadata["acp"];
  if (!isRecord(acp)) return undefined;

  const agent = text(acp["agent"]);
  const session = text(acp["session"]);
  if (agent === undefined || session === undefined) return undefined;

  const cwd = text(acp["cwd"]) ?? fallbackCwd;
  if (cwd === undefined) return undefined;

  const updatedAt = text(acp["updatedAt"]);
  return { agent, session, cwd, ...(updatedAt === undefined ? {} : { updatedAt }) };
}

/**
 * Writes `metadata.acp` without dropping other keys. OpenCode's `session.update`
 * replaces `metadata` wholesale, so the current value has to be merged first.
 */
export async function writeAcpMetadata(ctx: Plugin.Context, sessionID: string, acp: AcpSessionMetadata): Promise<void> {
  const info = await ctx.session.get({ sessionID });
  await ctx.session.update({
    sessionID,
    metadata: {
      ...(info.metadata ?? {}),
      acp: {
        agent: acp.agent,
        session: acp.session,
        cwd: acp.cwd,
        ...(acp.updatedAt === undefined ? {} : { updatedAt: acp.updatedAt }),
      },
    },
  });
}

/**
 * Owns ACP session metadata, SSOT history rebuilds and the session-level RPCs.
 * `metadata.acp` is the only binding source; there is no separate store.
 */
export class Coordinator {
  constructor(
    private readonly hub: AgentHub,
    private readonly titles: SessionTitles,
  ) {}

  listAgents(config: Config): SessionAgentsView {
    return {
      agents: config.agents.map((agent) => {
        const current = this.hub.availability(agent);
        const canDelete = this.hub.canDelete(agent.id);
        const entry = this.hub.get(agent.id);

        if (current.phase === "disabled") {
          return { id: agent.id, name: agent.name, status: "disabled", reason: "disabled", canDelete };
        }
        if (current.phase === "missing") {
          return { id: agent.id, name: agent.name, status: "stopped", reason: "notRunning", canDelete };
        }
        if (current.phase === "discovering") {
          return { id: agent.id, name: agent.name, status: "unavailable", reason: "discovering", canDelete };
        }
        if (current.phase === "failed") {
          return { id: agent.id, name: agent.name, status: "unavailable", reason: current.reason, canDelete };
        }
        if (current.phase === "stopped") {
          return { id: agent.id, name: agent.name, status: "stopped", reason: current.reason, canDelete };
        }

        if ((entry?.catalog?.models.length ?? 0) === 0) {
          return { id: agent.id, name: agent.name, status: "unavailable", reason: "noModels", canDelete };
        }
        const capabilities = entry?.client?.agentCapabilities;
        if (capabilities?.sessionCapabilities?.list == null) {
          return { id: agent.id, name: agent.name, status: "unsupported", reason: "noList", canDelete };
        }
        if (capabilities.loadSession !== true) {
          return { id: agent.id, name: agent.name, status: "unsupported", reason: "noLoad", canDelete };
        }
        return { id: agent.id, name: agent.name, status: "ready", reason: "", canDelete };
      }),
    };
  }

  async listSessions(config: Config, input: ListSessionsInput): Promise<AgentSessionsView> {
    const agent = config.agents.find((item) => item.id === input.agentID);
    if (agent === undefined) return { sessions: [] };

    const entry = this.hub.get(agent.id);
    if (entry === undefined || entry.client?.state !== "ready") return { sessions: [] };
    const client = entry.client;
    if (client.agentCapabilities?.sessionCapabilities?.list == null) return { sessions: [] };

    let listed: SessionInfo[];
    try {
      listed = await collectSessions(client, input.cwd);
      if (input.cwd !== undefined && listed.length === 0) {
        listed = await collectSessions(client, undefined);
      }
    } catch (error) {
      logWarn("acp", `could not list ${agent.id} sessions: ${message(error)}`);
      throw error;
    }

    // Agents may ignore the `cwd` hint and return sessions from anywhere.
    const root = input.cwd;
    const scoped = root === undefined ? listed : listed.filter((info) => withinPath(info.cwd, root));
    const sessions = scoped.map((info) => ({
      agentID: agent.id,
      id: info.sessionId,
      title: info.title?.trim() ?? "",
      cwd: info.cwd,
      updatedAt: info.updatedAt ?? "",
      available: directoryExists(info.cwd),
    }));

    sessions.sort((a, b) => {
      const left = timeOf(a.updatedAt);
      const right = timeOf(b.updatedAt);
      return left === right ? (a.title || a.cwd).localeCompare(b.title || b.cwd) : right - left;
    });
    return { sessions };
  }

  async sessionMeta(ctx: Plugin.Context, config: Config, input: SessionMetaInput): Promise<SessionMetaView> {
    let info: Awaited<ReturnType<Plugin.Context["session"]["get"]>>;
    try {
      info = await ctx.session.get({ sessionID: input.sessionID });
    } catch {
      return { status: "unavailable" };
    }

    const fallbackCwd = info.location.directory;
    const acp = readAcpMetadata(info.metadata, fallbackCwd);
    const agentID = acp?.agent ?? info.model?.providerID;
    if (agentID === undefined) return { status: "notAcp" };

    const agent = config.agents.find((item) => item.id === agentID);
    if (agent === undefined) return { status: "notAcp" };
    if (acp === undefined) return { status: "unbound", agentID };

    let remoteUpdatedAt: string | undefined;
    const client = this.hub.get(agent.id)?.client;
    if (client?.state === "ready" && client.agentCapabilities?.sessionCapabilities?.list != null) {
      try {
        for await (const remote of client.listAllSessions({ cwd: acp.cwd })) {
          if (remote.sessionId !== acp.session) continue;
          remoteUpdatedAt = remote.updatedAt ?? undefined;
          break;
        }
        if (remoteUpdatedAt === undefined) {
          // Some agents match `cwd` strictly and report nothing for a path that
          // looks identical; list everything before giving up.
          for await (const remote of client.listAllSessions()) {
            if (remote.sessionId !== acp.session) continue;
            remoteUpdatedAt = remote.updatedAt ?? undefined;
            break;
          }
        }
      } catch (error) {
        logWarn("acp", `could not read the remote session timestamp: ${message(error)}`);
      }
    }

    return {
      status: "ok",
      agentID,
      acpSessionID: acp.session,
      cwd: acp.cwd,
      ...(acp.updatedAt === undefined ? {} : { localUpdatedAt: acp.updatedAt }),
      ...(remoteUpdatedAt === undefined ? {} : { remoteUpdatedAt }),
    };
  }

  async rebuildSession(
    _ctx: Plugin.Context,
    config: Config,
    input: RebuildSessionInput,
  ): Promise<RebuildSessionResult> {
    const failed = (status: RebuildSessionResult["status"], reason: string): RebuildSessionResult => ({
      status,
      sessionID: "",
      reason,
      updatedAt: "",
    });

    const agent = config.agents.find((item) => item.id === input.agentID);
    if (agent === undefined) return failed("notFound", "agent");

    const entry = this.hub.get(agent.id);
    if (entry === undefined) return failed("unavailable", "notRunning");
    if ((entry.catalog?.models.length ?? 0) === 0) return failed("unavailable", "noModels");

    let client: AcpClient;
    try {
      client = await this.hub.ensureClient(agent.id);
    } catch (error) {
      logWarn("acp", `could not start ${agent.id} for rebuild: ${message(error)}`);
      return failed("unavailable", "failed");
    }

    if (client.agentCapabilities?.loadSession !== true) return failed("unsupported", "noLoad");

    let remote: SessionInfo | undefined;
    if (client.agentCapabilities?.sessionCapabilities?.list != null) {
      try {
        for await (const info of client.listAllSessions()) {
          if (info.sessionId !== input.acpSessionID) continue;
          remote = info;
          break;
        }
      } catch (error) {
        if (input.cwd === undefined) {
          logWarn("acp", `could not list ${agent.id} sessions for rebuild: ${message(error)}`);
          return failed("unavailable", "listFailed");
        }
        logWarn("acp", `could not list ${agent.id} sessions for rebuild: ${message(error)}`);
      }
    }
    if (remote === undefined && input.cwd === undefined) return failed("notFound", "session");

    const cwd = input.cwd ?? remote?.cwd;
    if (cwd === undefined) return failed("notFound", "session");
    if (!directoryExists(cwd)) return failed("notFound", "directoryMissing");

    const lock = this.hub.lock(agent.id, input.acpSessionID);
    if (lock === undefined) return failed("unavailable", "busy");
    const release = await lock;

    try {
      let updates: SessionUpdate[];
      try {
        updates = await replaySession(client, input.acpSessionID, cwd);
      } catch (error) {
        if (error instanceof AcpSessionBusyError) {
          logWarn("acp", `ACP session ${input.acpSessionID} is still active; rebuild skipped`);
          return { status: "loadFailed", sessionID: "", reason: "busy", updatedAt: "" };
        }
        logWarn("acp", `could not load ${input.acpSessionID} for rebuild: ${message(error)}`);
        return failed("loadFailed", "load");
      }

      const session = client.getSession(input.acpSessionID);
      if (session === undefined) return failed("loadFailed", "load");

      const model = historyModel(agent.id, entry.catalog, session.getSnapshot().configOptions);
      if (model === undefined) return failed("unavailable", "noModels");

      const opencodeSessionID = newSessionID();
      let payload: Awaited<ReturnType<typeof buildRebuiltSession>>;
      try {
        payload = await buildRebuiltSession({
          agentID: agent.id,
          acpSessionID: input.acpSessionID,
          opencodeSessionID,
          cwd,
          title: remote?.title?.trim() ?? "",
          updatedAt: remote?.updatedAt ?? "",
          model,
          updates,
        });
      } catch (error) {
        logWarn("acp", `could not build the rebuilt session for ${input.acpSessionID}: ${message(error)}`);
        return failed("loadFailed", "history");
      }

      if (payload.title.length > 0) this.titles.remember(opencodeSessionID, payload.title);
      logInfo("acp", `rebuilt ACP session ${input.acpSessionID} as ${opencodeSessionID}`);
      return {
        status: "ok",
        sessionID: opencodeSessionID,
        reason: "",
        updatedAt: payload.updatedAt ?? "",
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

  async sessionState(ctx: Plugin.Context, config: Config, input: SessionStateInput): Promise<SessionStateView> {
    const empty = (status: SessionStateView["status"]): SessionStateView => ({
      status,
      options: [],
      commands: [],
    });

    let info: Awaited<ReturnType<Plugin.Context["session"]["get"]>>;
    try {
      info = await ctx.session.get({ sessionID: input.sessionID });
    } catch {
      return empty("unavailable");
    }

    const acp = readAcpMetadata(info.metadata, info.location.directory);
    const agentID = acp?.agent ?? info.model?.providerID;
    if (agentID === undefined) return empty("notAcp");

    const agent = config.agents.find((item) => item.id === agentID);
    if (agent === undefined) return empty("notAcp");
    if (acp === undefined) {
      return {
        status: "unbound",
        agentID,
        agentName: agent.name,
        options: [],
        commands: [...(this.hub.get(agent.id)?.catalog?.commands ?? [])],
      };
    }

    const entry = this.hub.get(agent.id);
    if (entry === undefined) {
      return {
        status: "unavailable",
        agentID,
        agentName: agent.name,
        acpSessionID: acp.session,
        cwd: acp.cwd,
        options: [],
        commands: [],
      };
    }

    const cached: SessionCommandView[] = [...(entry.catalog?.commands ?? [])];
    const base = { agentID, agentName: agent.name, acpSessionID: acp.session, cwd: acp.cwd };

    let client: AcpClient | undefined = entry.client;
    let session = client?.getSession(acp.session);

    if (input.ensureLoaded === true) {
      try {
        client = await this.hub.ensureClient(agent.id);
        session = await loadOrResume(client, acp.session, acp.cwd);
      } catch (error) {
        logWarn("acp", `could not load ${acp.session} for session state: ${message(error)}`);
        return { status: "unavailable", ...base, options: [], commands: cached };
      }
    }

    if (client === undefined || session === undefined) {
      return { status: "cached", ...base, options: [], commands: cached };
    }
    if (input.ensureLoaded !== true && session.getSnapshot().lifecycle !== "active") {
      return { status: "cached", ...base, options: [], commands: cached };
    }

    const snapshot = session.getSnapshot();
    return {
      status: "ok",
      ...base,
      options: optionViews(snapshot.hasConfigOptions, snapshot.configOptions, snapshot.modes),
      commands: catalogCommands(snapshot.availableCommands),
    };
  }

  async setSessionOption(ctx: Plugin.Context, config: Config, input: SetSessionOptionInput): Promise<MutationResult> {
    const state = await this.sessionState(ctx, config, { sessionID: input.sessionID, ensureLoaded: true });
    if (state.status !== "ok" || state.agentID === undefined || state.acpSessionID === undefined) {
      return { status: "notFound" };
    }

    const client = this.hub.get(state.agentID)?.client;
    const session = client?.getSession(state.acpSessionID);
    if (client === undefined || session === undefined) return { status: "notFound" };

    try {
      if (input.configID === "__mode") {
        if (typeof input.value !== "string") return { status: "invalid" };
        await session.setMode(input.value);
        return { status: "ok" };
      }

      const option = session.getSnapshot().configOptions.find((item) => item.id === input.configID);
      if (option === undefined) return { status: "notFound" };
      if (option.type === "boolean" && typeof input.value !== "boolean") return { status: "invalid" };
      if (option.type === "select" && typeof input.value !== "string") return { status: "invalid" };

      await session.setConfigOption(input.configID, input.value);
      return { status: "ok" };
    } catch (error) {
      logWarn("acp", `could not set ${input.configID} on ${state.acpSessionID}: ${message(error)}`);
      return { status: "saveFailed" };
    }
  }

  async runCommand(ctx: Plugin.Context, config: Config, input: RunCommandInput): Promise<RunCommandResult> {
    const state = await this.sessionState(ctx, config, { sessionID: input.sessionID });
    if (state.status === "notAcp" || state.status === "unavailable") return { status: state.status };
    if (!state.commands.some((command) => command.name === input.name)) return { status: "notFound" };

    const text = input.input.length === 0 ? `/${input.name}` : `/${input.name} ${input.input}`;
    try {
      await ctx.session.prompt({
        sessionID: input.sessionID,
        text,
        ...(input.delivery === undefined ? {} : { delivery: input.delivery }),
      });
      return { status: "ok" };
    } catch (error) {
      logWarn("acp", `could not run /${input.name} in ${input.sessionID}: ${message(error)}`);
      return { status: "failed", message: message(error) };
    }
  }

  async deleteSession(config: Config, input: DeleteSessionInput): Promise<MutationResult> {
    const agent = config.agents.find((item) => item.id === input.agentID);
    const entry = this.hub.get(input.agentID);
    if (agent === undefined || entry === undefined) return { status: "notFound" };

    let client: AcpClient;
    try {
      client = await this.hub.ensureClient(input.agentID);
    } catch (error) {
      logWarn("acp", `could not start ${input.agentID} for session deletion: ${message(error)}`);
      return { status: "saveFailed" };
    }
    if (client.agentCapabilities?.sessionCapabilities?.delete == null) {
      return { status: "unsupported" };
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
}

async function collectSessions(client: AcpClient, cwd: string | undefined): Promise<SessionInfo[]> {
  const sessions: SessionInfo[] = [];
  for await (const info of client.listAllSessions(cwd === undefined ? undefined : { cwd })) {
    sessions.push(info);
  }
  return sessions;
}

/**
 * Replays a session by subscribing before `session/load`, then collecting the
 * updates that reach the newly registered session, in protocol order.
 */
async function replaySession(client: AcpClient, sessionID: string, cwd: string): Promise<SessionUpdate[]> {
  const existing = client.getSession(sessionID);
  if (existing !== undefined && client.agentCapabilities?.sessionCapabilities?.close != null) {
    await client.closeSession(sessionID).catch((error: unknown) => {
      logWarn("acp", `could not close ${sessionID} before replay: ${message(error)}`);
    });
  }

  const updates: SessionUpdate[] = [];
  let unsubscribeSession: (() => void) | undefined;

  const unsubscribeClient = client.subscribe((event) => {
    if (event.type !== "session" || event.action !== "created" || event.sessionId !== sessionID) return;
    if (unsubscribeSession !== undefined) return;

    const session = client.getSession(sessionID);
    unsubscribeSession = session?.subscribe((item) => {
      if (item.type === "update") updates.push(item.update);
    });
  });

  try {
    await client.loadSession({ sessionId: sessionID, cwd });
    return updates;
  } finally {
    unsubscribeSession?.();
    unsubscribeClient();
  }
}

async function loadOrResume(client: AcpClient, sessionID: string, cwd: string): Promise<AcpSession> {
  const existing = client.getSession(sessionID);
  if (existing?.getSnapshot().lifecycle === "active") return existing;

  const capabilities = client.agentCapabilities?.sessionCapabilities;
  if (capabilities?.resume != null) {
    return client.resumeSession({ sessionId: sessionID, cwd });
  }
  if (client.agentCapabilities?.loadSession === true) {
    return client.loadSession({ sessionId: sessionID, cwd });
  }
  throw new Error(`session ${sessionID} cannot be restored`);
}

function optionViews(
  hasConfigOptions: boolean,
  options: readonly ConfigOption[],
  modes: {
    currentModeId: string;
    availableModes: readonly { id: string; name: string; description?: string | null }[];
  } | null,
): SessionOptionView[] {
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
      values: option.options.map((value) => ({
        value: value.value,
        name: value.name,
        ...(value.description == null ? {} : { description: value.description }),
      })),
    };
  });

  if (!hasConfigOptions && modes !== null) {
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
function isModelOption(option: ConfigOption): boolean {
  return [option.id, option.category ?? ""].some((value) => value === "model" || value === "thought_level");
}

function historyModel(
  agentID: string,
  catalog: Catalog | undefined,
  options: readonly ConfigOption[],
): HistoryModel | undefined {
  if (catalog === undefined) return undefined;

  const remote = selectConfigOption(options, "model")?.currentValue;
  const model =
    catalog.models.find((item) => item.id === remote) ??
    catalog.models.find((item) => item.id === catalog.defaultModel) ??
    catalog.models[0];
  if (model === undefined) return undefined;

  const thought = selectConfigOption(options, "thought_level")?.currentValue;
  const variant =
    thought !== undefined && thought !== "default" && model.thoughts.some((item) => item.value === thought)
      ? thought
      : undefined;

  return { providerID: agentID, id: model.id, ...(variant === undefined ? {} : { variant }) };
}

function newSessionID(): string {
  return `ses_${crypto.randomUUID().replaceAll("-", "")}`;
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

function timeOf(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
