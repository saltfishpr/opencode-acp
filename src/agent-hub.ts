import type {
  AvailableCommand,
  CreateElicitationRequest,
  CreateElicitationResponse,
  RequestPermissionOutcome,
  RequestPermissionRequest,
} from "@agentclientprotocol/sdk";
import type { Plugin } from "@opencode/plugin";
import { accessSync, constants, statSync } from "node:fs";
import { createHash } from "node:crypto";
import { delimiter, resolve } from "node:path";
import { z } from "zod";
import {
  AcpAuthRequiredError,
  AcpClient,
  AcpInitializeTimeoutError,
  AcpProcessExitedError,
  AcpSpawnError,
  AcpTimeoutError,
  type ConfigOption,
  type HostContext,
  type SessionOptionsSnapshot,
} from "./acp/index.js";
import type { AgentConfig, Config } from "./config.js";
import type { TurnContext } from "./interaction/permission.js";
import { logDebug, logError, logInfo, logWarn } from "./log.js";
import type { AgentStatus, SettingsView } from "./rpc.js";

const CatalogThoughtSchema = z
  .object({
    value: z.string(),
    name: z.string(),
  })
  .readonly();

const CatalogModelSchema = z
  .object({
    id: z.string(),
    name: z.string(),
    description: z.string().optional(),
    thoughts: z.array(CatalogThoughtSchema).readonly(),
    /** `thought_level.currentValue` after selecting this model on a fresh session. */
    defaultThought: z.string().optional(),
  })
  .readonly();

const CatalogCommandSchema = z
  .object({
    name: z.string(),
    description: z.string(),
    hint: z.string().optional(),
  })
  .readonly();

const CatalogModeSchema = z
  .object({
    value: z.string(),
    name: z.string(),
  })
  .readonly();

/** The model, mode and command catalog learned from an ACP session. */
export const CatalogSchema = z
  .object({
    models: z.array(CatalogModelSchema).readonly(),
    /** Model the agent selected when the discovery session was created. */
    defaultModel: z.string().optional(),
    /** Modes the agent offers for a new session. */
    modes: z.array(CatalogModeSchema).readonly().default([]),
    /** Mode the agent selected when the discovery session was created. */
    defaultMode: z.string().optional(),
    /** Commands the agent advertised during discovery, used until a session reports its own. */
    commands: z.array(CatalogCommandSchema).readonly().default([]),
  })
  .readonly();

const CatalogCacheSchema = z.object({
  configFingerprint: z.string(),
  catalog: CatalogSchema,
});

export type CatalogThought = z.infer<typeof CatalogThoughtSchema>;
export type CatalogModel = z.infer<typeof CatalogModelSchema>;
export type CatalogCommand = z.infer<typeof CatalogCommandSchema>;
export type CatalogMode = z.infer<typeof CatalogModeSchema>;
export type Catalog = z.infer<typeof CatalogSchema>;

/** The part of each advertised command kept for the catalog and the client. */
export function catalogCommands(commands: readonly AvailableCommand[]): CatalogCommand[] {
  return commands.map((command) => ({
    name: command.name,
    description: command.description,
    ...(command.input == null ? {} : { hint: command.input.hint }),
  }));
}

/**
 * Finds a `select` option by semantic category, falling back to its ID for
 * agents that do not report categories.
 */
export function selectConfigOption(
  options: readonly ConfigOption[],
  category: string,
): Extract<ConfigOption, { type: "select" }> | undefined {
  const byCategory = options.find((option) => option.type === "select" && option.category === category);
  if (byCategory?.type === "select") return byCategory;

  const byId = options.find((option) => option.type === "select" && option.id === category);
  return byId?.type === "select" ? byId : undefined;
}

/** Resolve against the selected server's PATH without running the executable. */
export function findExecutable(agent: AgentConfig): string | undefined {
  const { command } = agent;
  const paths =
    command.includes("/") || command.includes("\\")
      ? [resolve(command)]
      : (agent.env["PATH"] ?? process.env["PATH"] ?? "")
          .split(delimiter)
          .filter(Boolean)
          .map((directory) => resolve(directory, command));
  const extensions =
    process.platform === "win32" && !/\.[^/\\]+$/.test(command)
      ? (process.env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD").split(";")
      : [""];

  for (const path of paths) {
    for (const extension of extensions) {
      const candidate = `${path}${extension}`;
      try {
        accessSync(candidate, constants.X_OK);
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        continue;
      }
    }
  }
  return undefined;
}

/** A running turn on one location, used to answer the agent's reverse requests. */
export interface ActiveTurnRegistration {
  readonly turn: TurnContext;
  readonly requestPermission: (
    params: RequestPermissionRequest,
    turn: TurnContext,
  ) => Promise<RequestPermissionOutcome>;
  readonly requestElicitation: (
    params: CreateElicitationRequest,
    turn: TurnContext,
  ) => Promise<CreateElicitationResponse>;
}

/** One configured agent, including its process, model catalog and session locks. */
export interface AgentEntry {
  agent: AgentConfig;
  executable: string;
  client?: AcpClient;
  starting?: Promise<AcpClient>;
  catalog?: Catalog;
  status: "discovering" | "ready" | "failed";
  failure: string;
  contextWindow?: number;
  locks: Map<string, Promise<void>>;
  paused: boolean;
  closed: boolean;
}

export type Availability =
  | {
      readonly phase: "running";
      readonly exited: boolean;
      readonly entry: AgentEntry;
    }
  | {
      readonly phase: "disabled" | "missing" | "discovering" | "failed" | "stopped";
      readonly reason: string;
      readonly exited: boolean;
    };

export interface AgentHubOptions {
  /** Called when a process reports capabilities the provider catalog has to reflect. */
  readonly onProviderChange?: () => void;
}

/**
 * Owns every configured agent process. OpenCode evaluates one plugin module per
 * location, but the hub and its processes are shared through `ServerState`, so
 * reverse requests are routed by (agent, ACP session) to the owning location.
 */
export class AgentHub {
  private readonly entries = new Map<string, AgentEntry>();
  private readonly turns = new Map<string, ActiveTurnRegistration>();
  private readonly capabilities = new Map<string, { image: boolean; audio: boolean }>();

  constructor(private readonly options: AgentHubOptions = {}) {}

  get(agentID: string): AgentEntry | undefined {
    return this.entries.get(agentID);
  }

  all(): ReadonlyMap<string, AgentEntry> {
    return this.entries;
  }

  registerTurn(agentID: string, acpSessionID: string, registration: ActiveTurnRegistration): () => void {
    const key = turnKey(agentID, acpSessionID);
    this.turns.set(key, registration);
    return () => {
      if (this.turns.get(key) === registration) this.turns.delete(key);
    };
  }

  async ensureClient(agentID: string): Promise<AcpClient> {
    const entry = this.entries.get(agentID);
    if (entry === undefined) throw new Error(`agent ${agentID} is not running`);
    if (entry.closed) throw new Error(`agent ${agentID} was closed`);

    const client = entry.client;
    if (client !== undefined && client.state === "ready") return client;
    if (entry.starting !== undefined) return entry.starting;

    if (client !== undefined) {
      await client.dispose().catch(() => {});
      entry.client = undefined;
    }

    const starting = this.startClient(entry).finally(() => {
      if (entry.starting === starting) entry.starting = undefined;
    });
    entry.starting = starting;

    const next = await starting;
    entry.client = next;
    this.reportCapabilities(entry);
    return next;
  }

  /** Serializes work for one session. Returns undefined while settings are changing. */
  lock(agentID: string, key: string): Promise<() => void> | undefined {
    const entry = this.entries.get(agentID);
    if (entry === undefined || entry.closed || entry.paused) return undefined;
    return this.lockTurn(entry, key);
  }

  /** Pauses new turns only if this agent has no admitted turns. */
  pause(agentID: string): boolean {
    const entry = this.entries.get(agentID);
    if (entry === undefined) return true;
    if (entry.locks.size !== 0) return false;
    entry.paused = true;
    return true;
  }

  resume(agentID: string): void {
    const entry = this.entries.get(agentID);
    if (entry !== undefined) entry.paused = false;
  }

  noteContextWindow(agentID: string, size: number): void {
    const entry = this.entries.get(agentID);
    if (entry === undefined || entry.contextWindow === size) return;
    entry.contextWindow = size;
    this.options.onProviderChange?.();
  }

  canDelete(agentID: string): boolean {
    return this.entries.get(agentID)?.client?.agentCapabilities?.sessionCapabilities?.delete != null;
  }

  /**
   * Learns the model list, each model's thinking levels, the modes and the
   * commands the agent advertises. Zero-session when `session/options` can
   * answer the catalog.
   */
  async discoverCatalog(client: AcpClient, cwd: string): Promise<Catalog> {
    const capabilities = client.agentCapabilities;
    const supportsOptions = client.experimental !== null && hasSessionOptions(capabilities);
    const experimental = client.experimental;

    if (supportsOptions && experimental !== null) {
      const initial = await experimental.getSessionOptions({ cwd });
      const modeInfo = catalogModes(initial);
      const modelOption = selectConfigOption(initial.configOptions, "model");
      if (modelOption === undefined) return { models: [], ...modeInfo, commands: [] };

      const models = catalogModels(modelOption);
      const thoughts = selectConfigOption(initial.configOptions, "thought_level");
      const only = models[0];
      if (models.length === 1 && only !== undefined) {
        return {
          models: [
            {
              ...only,
              thoughts: catalogThoughts(thoughts),
              ...(thoughts === undefined ? {} : { defaultThought: thoughts.currentValue }),
            },
          ],
          defaultModel: modelOption.currentValue,
          ...modeInfo,
          commands: [],
        };
      }
      if (models.length <= 1 || thoughts === undefined) {
        return { models, defaultModel: modelOption.currentValue, ...modeInfo, commands: [] };
      }
    }

    const session = await client.newSession({ cwd });
    try {
      return await probeCatalog(session);
    } finally {
      await releaseSession(client, session.sessionId);
    }
  }

  async startAgent(ctx: Plugin.Context, agent: AgentConfig): Promise<void> {
    if (!agent.enabled) return;

    const executable = findExecutable(agent);
    if (executable === undefined) return;

    const entry: AgentEntry = {
      agent,
      executable,
      catalog: await loadCatalog(ctx.storage, agent),
      status: "discovering",
      failure: "",
      locks: new Map(),
      paused: false,
      closed: false,
    };
    this.entries.set(agent.id, entry);

    void (async () => {
      try {
        const client = await this.ensureClient(agent.id);
        const catalog = await this.discoverCatalog(client, process.cwd());
        if (this.entries.get(agent.id) !== entry) return;

        if (catalog.models.length === 0) {
          entry.status = "failed";
          entry.failure = "noModels";
          this.options.onProviderChange?.();
          return;
        }

        entry.catalog = catalog;
        entry.status = "ready";
        await saveCatalog(ctx.storage, agent, catalog);
        this.options.onProviderChange?.();
        logInfo("acp", `${agent.id} offers ${catalog.models.length} models`);
      } catch (error) {
        if (this.entries.get(agent.id) !== entry) return;
        entry.status = "failed";
        entry.failure = failureOf(error);
        logWarn("acp", `Model discovery failed for ${agent.id}: ${message(error)}`);
        this.options.onProviderChange?.();
      }
    })();
  }

  stopAgent(agentID: string): void {
    const entry = this.entries.get(agentID);
    this.entries.delete(agentID);
    if (entry === undefined) return;

    entry.closed = true;
    void entry.client?.dispose().catch(() => {});
    if (entry.starting !== undefined) {
      void entry.starting.then(
        (client) => client.dispose(),
        () => {},
      );
    }
  }

  stopAll(): void {
    for (const agentID of [...this.entries.keys()]) this.stopAgent(agentID);
  }

  /**
   * One view of whether an agent can take work, so the settings page, the
   * session list and the import flow do not each re-derive it.
   */
  availability(agent: AgentConfig): Availability {
    if (!agent.enabled) return { phase: "disabled", reason: "disabled", exited: false };

    const entry = this.entries.get(agent.id);
    if (entry === undefined) return { phase: "missing", reason: "notRunning", exited: false };

    const client = entry.client;
    const exited = client?.state === "exited";
    if (entry.status === "failed") {
      return { phase: "failed", reason: entry.failure || "failed", exited };
    }
    if (client === undefined || client.state !== "ready") {
      return { phase: "stopped", reason: exited ? "exited" : "notRunning", exited };
    }
    if (entry.status === "discovering") {
      return { phase: "discovering", reason: "discovering", exited };
    }
    return { phase: "running", exited, entry };
  }

  settingsView(config: Config): SettingsView {
    return {
      revision: config.revision,
      logLevel: config.logLevel,
      agents: config.agents.map((agent) => {
        const current = this.availability(agent);
        let status: AgentStatus;
        if (current.phase === "running") status = "ready";
        else if (current.phase === "stopped") {
          status = current.exited ? "failed" : (this.entries.get(agent.id)?.status ?? "missing");
        } else status = current.phase;

        const entry = this.entries.get(agent.id);
        const catalog = entry?.catalog;
        return {
          id: agent.id,
          name: agent.name,
          command: agent.command,
          args: [...agent.args],
          enabled: agent.enabled,
          status,
          envKeys: Object.keys(agent.env),
          modelCount: catalog?.models.length ?? 0,
          failure: entry?.failure || (current.exited ? "exited" : ""),
          modes: [...(catalog?.modes ?? [])],
          // The agent's own startup mode stands in until the user picks one.
          defaultMode: agent.defaultMode || catalog?.defaultMode || "",
        };
      }),
    };
  }

  private async startClient(entry: AgentEntry): Promise<AcpClient> {
    const client = new AcpClient({
      command: entry.executable,
      args: [...entry.agent.args],
      env: entry.agent.env,
      clientInfo: { name: "opencode-acp", version: "0.0.0" },
      experimental: { unstable: true },
      logger: {
        debug: (value) => logDebug("acp", value),
        info: (value) => logInfo("acp", value),
        warn: (value) => logWarn("acp", value),
        error: (value) => logError("acp", value),
      },
      host: {
        permission: (params, hostCtx) => this.routePermission(entry.agent.id, params, hostCtx),
        elicitation: {
          modes: ["form"],
          create: (params, hostCtx) => this.routeElicitation(entry.agent.id, params, hostCtx),
        },
        // Declares `session.notices`; notices are projected through session.subscribe.
        notice: () => {},
      },
    });
    await client.start();
    return client;
  }

  private routePermission(
    agentID: string,
    params: RequestPermissionRequest,
    hostCtx: HostContext,
  ): Promise<RequestPermissionOutcome> {
    const registration = this.turns.get(turnKey(agentID, params.sessionId));
    if (registration === undefined) return Promise.resolve({ outcome: "cancelled" });

    const turn = withSignal(registration.turn, hostCtx.signal);
    return registration.requestPermission(params, turn);
  }

  private routeElicitation(
    agentID: string,
    params: CreateElicitationRequest,
    hostCtx: HostContext,
  ): Promise<CreateElicitationResponse> {
    const sessionID = hostCtx.sessionId;
    if (sessionID === undefined) return Promise.resolve({ action: "decline" });

    const registration = this.turns.get(turnKey(agentID, sessionID));
    if (registration === undefined) return Promise.resolve({ action: "decline" });

    const turn = withSignal(registration.turn, hostCtx.signal);
    return registration.requestElicitation(params, turn);
  }

  private reportCapabilities(entry: AgentEntry): void {
    const prompt = entry.client?.agentCapabilities?.promptCapabilities;
    const next = { image: prompt?.image === true, audio: prompt?.audio === true };
    const previous = this.capabilities.get(entry.agent.id);
    if (previous?.image === next.image && previous?.audio === next.audio) return;

    this.capabilities.set(entry.agent.id, next);
    this.options.onProviderChange?.();
  }

  private async lockTurn(entry: AgentEntry, key: string): Promise<() => void> {
    const previous = entry.locks.get(key) ?? Promise.resolve();
    let release: () => void = () => {};
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    entry.locks.set(key, tail);
    await previous;

    return () => {
      release();
      if (entry.locks.get(key) === tail) entry.locks.delete(key);
    };
  }
}

async function probeCatalog(session: import("./acp/index.js").AcpSession): Promise<Catalog> {
  const initial = session.getSnapshot();
  const modeInfo = catalogModes(initial);
  const modelOption = selectConfigOption(initial.configOptions, "model");
  if (modelOption === undefined) return { models: [], ...modeInfo, commands: [] };

  const defaultModel = modelOption.currentValue;
  const models: CatalogModel[] = [];

  for (const value of modelOption.options) {
    await session.setConfigOption(modelOption.id, value.value);
    const snapshot = session.getSnapshot();
    const thoughts = selectConfigOption(snapshot.configOptions, "thought_level");
    models.push({
      id: value.value,
      name: value.name,
      ...(value.description === null ? {} : { description: value.description }),
      thoughts: catalogThoughts(thoughts),
      ...(thoughts === undefined ? {} : { defaultThought: thoughts.currentValue }),
    });
  }

  return {
    models,
    defaultModel,
    ...modeInfo,
    commands: catalogCommands(session.getSnapshot().availableCommands),
  };
}

/**
 * Reads the modes a fresh session starts with, from either the config option or
 * the legacy mode state.
 */
export function catalogModes(snapshot: SessionOptionsSnapshot): { modes: CatalogMode[]; defaultMode?: string } {
  if (snapshot.hasConfigOptions) {
    const option = selectConfigOption(snapshot.configOptions, "mode");
    if (option === undefined) return { modes: [] };
    return {
      modes: option.options.map(({ value, name }) => ({ value, name })),
      ...(option.currentValue.length === 0 ? {} : { defaultMode: option.currentValue }),
    };
  }

  if (snapshot.modes === null) return { modes: [] };
  return {
    modes: snapshot.modes.availableModes.map(({ id, name }) => ({ value: id, name })),
    ...(snapshot.modes.currentModeId.length === 0 ? {} : { defaultMode: snapshot.modes.currentModeId }),
  };
}

function hasSessionOptions(capabilities: AcpClient["agentCapabilities"]): boolean {
  const value: unknown = capabilities?.sessionCapabilities;
  return typeof value === "object" && value !== null && "options" in value && value.options != null;
}

function catalogModels(option: Extract<ConfigOption, { type: "select" }>): CatalogModel[] {
  return option.options.map((value) => ({
    id: value.value,
    name: value.name,
    ...(value.description === null ? {} : { description: value.description }),
    thoughts: [],
  }));
}

function catalogThoughts(option: Extract<ConfigOption, { type: "select" }> | undefined): CatalogThought[] {
  if (option === undefined) return [];
  return option.options.map((value) => ({ value: value.value, name: value.name }));
}

async function releaseSession(client: AcpClient, sessionID: string): Promise<void> {
  const capabilities = client.agentCapabilities?.sessionCapabilities;
  try {
    if (capabilities?.delete != null) {
      await client.deleteSession(sessionID);
      return;
    }
    if (capabilities?.close != null) await client.closeSession(sessionID);
  } catch (error) {
    logWarn("acp", `could not clean up discovery session ${sessionID}: ${message(error)}`);
  }
}

function withSignal(turn: TurnContext, signal: AbortSignal): TurnContext {
  return {
    sessionID: turn.sessionID,
    agentName: turn.agentName,
    cwd: turn.cwd,
    signal: AbortSignal.any([turn.signal, signal]),
  };
}

function turnKey(agentID: string, acpSessionID: string): string {
  return `${agentID}\0${acpSessionID}`;
}

function failureOf(error: unknown): string {
  if (error instanceof AcpAuthRequiredError) return "login";
  if (error instanceof AcpProcessExitedError) return "exited";
  if (error instanceof AcpInitializeTimeoutError || error instanceof AcpTimeoutError) return "timeout";
  if (error instanceof AcpSpawnError) return "spawn";
  return "discovery";
}

function catalogKey(agentID: string): string {
  return `acp/catalog/by-agent/${agentID}`;
}

function configFingerprint({ command, args, env }: AgentConfig): string {
  const entries = Object.keys(env)
    .sort()
    .map((key) => [key, env[key]]);
  return createHash("sha256")
    .update(JSON.stringify([command, args, entries]))
    .digest("hex");
}

/** Loads the catalog cached by a previous run, when the launch config still matches. */
export async function loadCatalog(
  storage: Plugin.Context["storage"],
  agent: AgentConfig,
): Promise<Catalog | undefined> {
  try {
    const result = CatalogCacheSchema.safeParse(await storage.get(catalogKey(agent.id)));
    if (result.success && result.data.configFingerprint === configFingerprint(agent)) {
      return result.data.catalog;
    }
  } catch (error) {
    logWarn("acp", `could not read the cached model catalog: ${message(error)}`);
  }
  return undefined;
}

export async function saveCatalog(
  storage: Plugin.Context["storage"],
  agent: AgentConfig,
  catalog: Catalog,
): Promise<void> {
  try {
    await storage.set(catalogKey(agent.id), {
      configFingerprint: configFingerprint(agent),
      catalog,
    });
  } catch (error) {
    logWarn("acp", `could not cache the model catalog: ${message(error)}`);
  }
}

export async function clearCatalog(storage: Plugin.Context["storage"], agentID: string): Promise<void> {
  try {
    await storage.remove(catalogKey(agentID));
  } catch (error) {
    logWarn("acp", `could not remove the cached model catalog: ${message(error)}`);
  }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
