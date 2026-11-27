import { spawn, type ChildProcess } from "node:child_process";
import { Readable, Writable } from "node:stream";
import {
  client,
  ndJsonStream,
  PROTOCOL_VERSION,
  RequestError,
  type AvailableCommand,
  type ClientConnection,
  type ContentBlock,
  type CreateElicitationRequest,
  type CreateElicitationResponse,
  type InitializeResponse,
  type PromptCapabilities,
  type PromptResponse,
  type RequestPermissionRequest,
  type RequestPermissionResponse,
  type SessionConfigOption,
  type SessionInfo,
  type SessionModeState,
  type SessionUpdate,
} from "@agentclientprotocol/sdk";
import { elicitationSession } from "../interaction/elicitation.js";
import { logInfo, logWarn } from "../log.js";
import { selectOption, valuesOf, type Catalog, type CatalogModel } from "./catalog.js";
import { AcpStartError, describeExit, type AcpExit, type FailureContext } from "./errors.js";

/** Identifies the OpenCode session and turn that an ACP request belongs to. */
export interface AcpTurnContext {
  readonly sessionID: string;
  /** Display name of the ACP agent, used in dialogs. */
  readonly agentName: string;
  /** Absolute working directory the ACP session was created with. */
  readonly cwd: string;
  /** Aborts when the turn is cancelled or ends. */
  readonly signal: AbortSignal;
}

/** Answers one reverse request from the agent. */
export type PermissionHandler = (
  params: RequestPermissionRequest,
  turn: AcpTurnContext,
) => Promise<RequestPermissionResponse> | RequestPermissionResponse;

/** Asks the user for structured input requested by the agent. */
export type ElicitationHandler = (
  params: CreateElicitationRequest,
  turn: AcpTurnContext,
) => Promise<CreateElicitationResponse> | CreateElicitationResponse;

interface AcpPromptContext {
  readonly sessionID: string;
  readonly cwd: string;
  readonly requestPermission: PermissionHandler;
  readonly requestElicitation: ElicitationHandler;
}

/** How to launch one ACP agent process. */
export interface AcpClientOptions {
  readonly command: string;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  /** Prefix for log lines, typically the provider ID. */
  readonly name: string;
  /** Human-readable agent name shown in dialogs; defaults to `name`. */
  readonly displayName?: string;
}

/** How long a protocol handshake may take before the agent is considered broken. */
const HANDSHAKE_TIMEOUT_MS = 60_000;

/** How long to wait for `session/prompt` to settle after `session/cancel`. */
const CANCEL_TIMEOUT_MS = 10_000;

/** Bound for one `session/set_config_option` round trip; it only changes local state. */
const CONFIG_TIMEOUT_MS = 15_000;

/** Bound for `session/close` on the short-lived discovery session. */
const CLOSE_TIMEOUT_MS = 5_000;

/** Bound for `session/set_mode`. */
const MODE_TIMEOUT_MS = 15_000;

/** Bound for `session/resume`, which starts a stored session without replaying it. */
const RESUME_TIMEOUT_MS = 60_000;

/** Bound for `session/delete`. */
const DELETE_TIMEOUT_MS = 15_000;

/** Upper bound on session updates buffered while no turn is running. */
const PENDING_LIMIT = 100;

/** Bound for one `session/list` page; agents may answer from local storage. */
const LIST_TIMEOUT_MS = 60_000;

/** Safety bounds for a cursor loop that never ends. */
const LIST_PAGE_LIMIT = 50;
const LIST_SESSION_LIMIT = 5_000;

/** Everything learned about one ACP session. */
interface SessionState {
  configs: readonly SessionConfigOption[];
  modes: SessionModeState | undefined;
  commands: readonly AvailableCommand[];
  title: string | undefined;
  /** Session-level updates received while no turn was running. */
  pending: SessionUpdate[];
  /** Collects replayed `session/load` updates for history import. */
  recorder: SessionUpdate[] | undefined;
  /** Replayed updates are dropped instead of buffered while loading. */
  replaying: boolean;
  loaded: boolean;
  /** Created by this process, so cleanup may delete it. */
  owned: boolean;
  queue: UpdateQueue | undefined;
  turn: TurnState | undefined;
}

function sessionOf(sessions: Map<string, SessionState>, sessionId: string): SessionState {
  let session = sessions.get(sessionId);
  if (session === undefined) {
    session = {
      configs: [],
      modes: undefined,
      commands: [],
      title: undefined,
      pending: [],
      recorder: undefined,
      replaying: false,
      loaded: false,
      owned: false,
      queue: undefined,
      turn: undefined,
    };
    sessions.set(sessionId, session);
  }
  return session;
}

/**
 * One running ACP agent process plus its JSON-RPC connection.
 *
 * The process is shared by every OpenCode session that uses this agent; ACP
 * sessions are addressed by ID. Call `close()` when the plugin unloads so the
 * child does not outlive the server.
 */
export class AcpClient {
  private readonly child: ChildProcess;
  private readonly connection: ClientConnection;
  /** Per-session state, keyed by ACP session ID. One record means one cleanup point. */
  private readonly sessions: Map<string, SessionState>;
  private readonly name: string;
  private readonly displayName: string;
  private readonly command: string;
  readonly initialize: InitializeResponse;

  /** Set when the process ends on its own, for error messages. */
  exitInfo: AcpExit | undefined;
  /** True once `close()` has been called, so an exit is expected. */
  closedByUser = false;
  private readonly usage: ContextWindow;

  private constructor(
    child: ChildProcess,
    connection: ClientConnection,
    initialize: InitializeResponse,
    options: AcpClientOptions,
    sessions: Map<string, SessionState>,
    usage: ContextWindow,
  ) {
    this.child = child;
    this.connection = connection;
    this.initialize = initialize;
    this.sessions = sessions;
    this.name = options.name;
    this.displayName = options.displayName ?? options.name;
    this.command = options.command;
    this.usage = usage;

    child.on("exit", (code, signal) => {
      this.exitInfo = { code, signal };
      if (!this.closedByUser) logWarn(options.name, `process exited (${describeExit(this.exitInfo)})`);
    });

    connection.closed.then(
      () => this.reset(),
      () => this.reset(),
    );
  }

  static async start(options: AcpClientOptions): Promise<AcpClient> {
    const child = spawn(options.command, [...options.args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...options.env },
      // A separate process group lets close() stop children the agent forked.
      detached: process.platform !== "win32",
    });

    let exit: AcpExit | undefined;
    child.on("exit", (code, signal) => {
      exit = { code, signal };
    });

    try {
      await new Promise<void>((resolve, reject) => {
        child.once("spawn", () => resolve());
        child.once("error", (error) => reject(error));
      });
    } catch (error) {
      terminateProcessTree(child);
      throw new AcpStartError("spawn", options.command, error);
    }

    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString().trim();
      if (text.length > 0) logInfo(options.name, text);
    });

    child.on("error", (error) => {
      logWarn(options.name, `process error: ${error.message}`);
    });

    const sessions = new Map<string, SessionState>();
    const usage: ContextWindow = {};

    const remember = (sessionId: string, update: SessionUpdate): void => {
      switch (update.sessionUpdate) {
        case "config_option_update":
          sessionOf(sessions, sessionId).configs = update.configOptions;
          return;
        case "current_mode_update": {
          const session = sessions.get(sessionId);
          if (session?.modes !== undefined) {
            session.modes = { ...session.modes, currentModeId: update.currentModeId };
          }
          return;
        }
        case "available_commands_update":
          sessionOf(sessions, sessionId).commands = update.availableCommands;
          return;
        case "session_info_update": {
          const session = sessionOf(sessions, sessionId);
          const title = typeof update.title === "string" ? update.title.trim() : "";
          if (title.length > 0) session.title = title;
          else if (update.title === null) session.title = undefined;
          return;
        }
        default:
          return;
      }
    };

    // Session-level updates outside a turn are kept for the next prompt; text
    // and tool updates only matter to a turn that is streaming them.
    const bufferable = (update: SessionUpdate): boolean =>
      update.sessionUpdate === "notice" ||
      update.sessionUpdate === "compaction_update" ||
      update.sessionUpdate === "compaction_summary_chunk" ||
      update.sessionUpdate === "plan" ||
      update.sessionUpdate === "plan_update" ||
      update.sessionUpdate === "plan_removed";

    const buffered = (sessionId: string, update: SessionUpdate): void => {
      const session = sessionOf(sessions, sessionId);
      if (session.replaying) return;
      session.pending.push(update);
      if (session.pending.length > PENDING_LIMIT) session.pending.splice(0, session.pending.length - PENDING_LIMIT);
    };

    const app = client({ name: "opencode-acp" })
      .onNotification("session/update", ({ params }) => {
        const update = params.update;
        if (update.sessionUpdate === "usage_update" && Number.isFinite(update.size) && update.size > 0) {
          if (usage.size === undefined || update.size > usage.size) usage.size = update.size;
        }

        remember(params.sessionId, update);

        const session = sessions.get(params.sessionId);
        if (session?.recorder !== undefined) session.recorder.push(update);
        if (session?.queue !== undefined) {
          session.queue.push(update);
          return;
        }
        if (session?.recorder !== undefined) return;
        if (bufferable(update)) buffered(params.sessionId, update);
      })
      .onRequest("session/request_permission", async ({ params }) => {
        const turn = sessions.get(params.sessionId)?.turn;
        if (turn === undefined) return declinePermission(params);

        if (turn.controller.signal.aborted) return cancelledPermission();

        return new Promise<RequestPermissionResponse>((resolve) => {
          let settled = false;
          const done = (response: RequestPermissionResponse) => {
            if (settled) return;
            settled = true;
            turn.pending.delete(done);
            resolve(response);
          };

          turn.pending.add(done);

          Promise.resolve(
            turn.requestPermission(params, {
              sessionID: turn.sessionID,
              agentName: turn.agentName,
              cwd: turn.cwd,
              signal: turn.controller.signal,
            }),
          ).then(done, (error: unknown) => {
            logWarn(options.name, `permission handler failed: ${errorMessage(error)}`);
            done(declinePermission(params));
          });
        });
      })
      .onRequest("elicitation/create", async ({ params }) => {
        const sessionId = elicitationSession(params);
        const turn = sessionId === undefined ? undefined : sessions.get(sessionId)?.turn;

        if (turn === undefined) {
          logInfo(options.name, "declined an elicitation outside a running turn");
          return { action: "decline" } satisfies CreateElicitationResponse;
        }

        try {
          return await turn.requestElicitation(params, {
            sessionID: turn.sessionID,
            agentName: turn.agentName,
            cwd: turn.cwd,
            signal: turn.controller.signal,
          });
        } catch (error) {
          logWarn(options.name, `elicitation handler failed: ${errorMessage(error)}`);
          return { action: "decline" } satisfies CreateElicitationResponse;
        }
      });

    const stream = ndJsonStream(Writable.toWeb(child.stdin!), Readable.toWeb(child.stdout!));
    const connection = app.connect(stream);

    try {
      const initialize = await connection.agent.request(
        "initialize",
        {
          protocolVersion: PROTOCOL_VERSION,
          // No client-side fs or terminal: the agent runs its own tools. The
          // other capabilities describe the session updates this client handles.
          clientCapabilities: {
            fs: { readTextFile: false, writeTextFile: false },
            terminal: false,
            session: {
              configOptions: { boolean: {} },
              notices: {},
              compaction: {},
            },
            plan: {},
            elicitation: { form: {} },
          },
          clientInfo: { name: "opencode-acp", version: "0.0.0" },
        },
        { cancellationSignal: AbortSignal.timeout(HANDSHAKE_TIMEOUT_MS), stopWaitingOnCancel: true },
      );

      const acp = new AcpClient(child, connection, initialize, options, sessions, usage);
      return acp;
    } catch (error) {
      connection.close();
      terminateProcessTree(child);
      const ended =
        exit ??
        (child.exitCode !== null || child.signalCode !== null
          ? { code: child.exitCode, signal: child.signalCode }
          : undefined);
      throw new AcpStartError("handshake", options.command, error, ended);
    }
  }

  /** Largest context window this process has reported, from `usage_update`. */
  get contextWindow(): number | undefined {
    return this.usage.size;
  }

  /** Failure context for `explain`, including a process that already exited. */
  get failure(): FailureContext {
    return {
      command: this.command,
      exit: this.exitInfo,
      closedByUser: this.closedByUser,
    };
  }

  /** Whether the agent advertises `session/load`. */
  get canLoadSession(): boolean {
    return this.initialize.agentCapabilities?.loadSession === true;
  }

  /** Whether the agent advertises `session/list`. */
  get canListSessions(): boolean {
    return this.initialize.agentCapabilities?.sessionCapabilities?.list != null;
  }

  /** Whether the agent advertises `session/close`, used to clean up discovery sessions. */
  get canCloseSession(): boolean {
    return this.initialize.agentCapabilities?.sessionCapabilities?.close != null;
  }

  /** Whether the agent advertises `session/resume`. */
  get canResumeSession(): boolean {
    return this.initialize.agentCapabilities?.sessionCapabilities?.resume != null;
  }

  /** Whether the agent advertises `session/delete`. */
  get canDeleteSession(): boolean {
    return this.initialize.agentCapabilities?.sessionCapabilities?.delete != null;
  }

  /** Prompt content types the agent declared in `initialize`; a missing field means unsupported. */
  get promptCapabilities(): PromptCapabilities | undefined {
    return this.initialize.agentCapabilities?.promptCapabilities;
  }

  /** Whether the agent accepts `image` content blocks. */
  get supportsImages(): boolean {
    return this.promptCapabilities?.image === true;
  }

  /** Whether the agent accepts `audio` content blocks. */
  get supportsAudio(): boolean {
    return this.promptCapabilities?.audio === true;
  }

  /** Whether the agent accepts embedded `resource` content in prompts. */
  get supportsEmbeddedContext(): boolean {
    return this.promptCapabilities?.embeddedContext === true;
  }

  /** Whether the underlying process or connection has gone away. */
  get isClosed(): boolean {
    return this.connection.signal.aborted;
  }

  /** Process ID of the agent, when it is still running. */
  get pid(): number | undefined {
    return this.child.exitCode === null && this.child.signalCode === null ? this.child.pid : undefined;
  }

  async newSession(cwd: string): Promise<string> {
    if (this.isClosed) throw this.closedError();

    const response = await this.connection.agent.request(
      "session/new",
      { cwd, mcpServers: [] },
      { cancellationSignal: AbortSignal.timeout(HANDSHAKE_TIMEOUT_MS), stopWaitingOnCancel: true },
    );

    const session = this.session(response.sessionId);
    session.configs = response.configOptions ?? [];
    this.rememberModes(session, response.modes);
    session.loaded = true;
    session.owned = true;
    return response.sessionId;
  }

  /**
   * Resumes a stored session without replaying its messages. Unlike
   * `session/load`, this works for agents that keep the conversation but cannot
   * return it, so the client starts with only the lifecycle state.
   */
  async resumeSession(sessionId: string, cwd: string): Promise<void> {
    if (this.isClosed) throw this.closedError();
    if (!this.canResumeSession) throw new Error("ACP agent does not support session/resume");

    const response = await this.connection.agent.request(
      "session/resume",
      { sessionId, cwd, mcpServers: [] },
      { cancellationSignal: AbortSignal.timeout(RESUME_TIMEOUT_MS), stopWaitingOnCancel: true },
    );

    const session = this.session(sessionId);
    session.configs = response.configOptions ?? [];
    this.rememberModes(session, response.modes);
    session.loaded = true;
  }

  /** Lists the agent's stored sessions, following cursors up to a safety bound. */
  async listSessions(cwd?: string): Promise<SessionInfo[]> {
    if (this.isClosed) throw this.closedError();
    if (!this.canListSessions) throw new Error("ACP agent does not support session/list");

    const sessions: SessionInfo[] = [];
    const seen = new Set<string>();
    const cursors = new Set<string>();
    let cursor: string | null | undefined;

    for (let page = 0; page < LIST_PAGE_LIMIT; page++) {
      const response = await this.connection.agent.request(
        "session/list",
        {
          ...(cwd === undefined ? {} : { cwd }),
          ...(cursor === undefined || cursor === null ? {} : { cursor }),
        },
        { cancellationSignal: AbortSignal.timeout(LIST_TIMEOUT_MS), stopWaitingOnCancel: true },
      );

      for (const session of response.sessions) {
        if (seen.has(session.sessionId)) continue;
        seen.add(session.sessionId);
        sessions.push(session);
        if (sessions.length >= LIST_SESSION_LIMIT) return sessions;
      }

      const next = response.nextCursor ?? null;
      if (next === null || next === cursor || cursors.has(next)) return sessions;
      cursors.add(next);
      cursor = next;
    }

    return sessions;
  }

  /**
   * Loads an existing ACP session. Updates the agent replays are dropped unless
   * `capture` is given, in which case they are appended to that array for
   * history import.
   */
  async loadSession(sessionId: string, cwd: string, capture?: SessionUpdate[]): Promise<void> {
    if (this.isClosed) throw this.closedError();

    const session = this.session(sessionId);
    if (capture !== undefined) session.recorder = capture;
    else session.replaying = true;
    try {
      const response = await this.connection.agent.request(
        "session/load",
        { sessionId, cwd, mcpServers: [] },
        { cancellationSignal: AbortSignal.timeout(HANDSHAKE_TIMEOUT_MS), stopWaitingOnCancel: true },
      );

      session.configs = response.configOptions ?? [];
      this.rememberModes(session, response.modes);
      session.loaded = true;
    } finally {
      if (capture !== undefined && session.recorder === capture) session.recorder = undefined;
      session.replaying = false;
    }
  }

  /**
   * Deletes a stored session from the agent. A session the agent no longer
   * knows about is treated as success, so cleanup is idempotent.
   */
  async deleteSession(sessionId: string): Promise<void> {
    if (this.isClosed) throw this.closedError();
    if (!this.canDeleteSession) throw new Error("ACP agent does not support session/delete");

    try {
      await this.connection.agent.request(
        "session/delete",
        { sessionId },
        { cancellationSignal: AbortSignal.timeout(DELETE_TIMEOUT_MS), stopWaitingOnCancel: true },
      );
    } catch (error) {
      if (!(error instanceof RequestError && error.code === -32002)) throw error;
    }

    this.forget(sessionId);
  }

  /** Latest configuration options reported for a session, or an empty list if none are known. */
  configOptions(sessionId: string): readonly SessionConfigOption[] {
    return this.sessions.get(sessionId)?.configs ?? [];
  }

  /** Legacy mode state reported by `session/new`, `session/load` or `current_mode_update`. */
  modes(sessionId: string): SessionModeState | undefined {
    return this.sessions.get(sessionId)?.modes;
  }

  /** Commands advertised by the agent, empty until `available_commands_update` arrives. */
  commands(sessionId: string): readonly AvailableCommand[] {
    return this.sessions.get(sessionId)?.commands ?? [];
  }

  /** Latest title reported through `session_info_update`. */
  title(sessionId: string): string | undefined {
    return this.sessions.get(sessionId)?.title;
  }

  /**
   * Changes one session configuration value, such as the model or thinking
   * level. The agent answers with the complete configuration state, which
   * replaces what the client knew before.
   */
  async setConfigOption(
    sessionId: string,
    configId: string,
    value: string | boolean,
  ): Promise<readonly SessionConfigOption[]> {
    if (this.isClosed) throw this.closedError();

    const response = await this.connection.agent.request(
      "session/set_config_option",
      typeof value === "boolean" ? { sessionId, configId, type: "boolean", value } : { sessionId, configId, value },
      { cancellationSignal: AbortSignal.timeout(CONFIG_TIMEOUT_MS), stopWaitingOnCancel: true },
    );

    this.session(sessionId).configs = response.configOptions;
    return response.configOptions;
  }

  /** Switches the session to another legacy ACP mode. */
  async setMode(sessionId: string, modeId: string): Promise<void> {
    if (this.isClosed) throw this.closedError();

    await this.connection.agent.request(
      "session/set_mode",
      { sessionId, modeId },
      { cancellationSignal: AbortSignal.timeout(MODE_TIMEOUT_MS), stopWaitingOnCancel: true },
    );

    const state = this.sessions.get(sessionId)?.modes;
    if (state !== undefined) this.session(sessionId).modes = { ...state, currentModeId: modeId };
  }

  /**
   * Reads the agent's model catalog by creating a short-lived session and
   * selecting each advertised model, because thinking levels are reported per
   * model and only through the session configuration state. A model that
   * rejects the switch is kept without thinking levels.
   */
  async discoverModels(cwd: string): Promise<Catalog> {
    if (this.isClosed) throw this.closedError();

    const created = await this.connection.agent.request(
      "session/new",
      { cwd, mcpServers: [] },
      { cancellationSignal: AbortSignal.timeout(HANDSHAKE_TIMEOUT_MS), stopWaitingOnCancel: true },
    );

    const sessionId = created.sessionId;
    // Created here, so `closeSession` may delete it on agents without `session/close`.
    this.session(sessionId).owned = true;
    const initial = created.configOptions ?? [];

    const models: CatalogModel[] = [];
    try {
      const model = selectOption(initial, "model");

      if (model !== undefined) {
        for (const value of valuesOf(model)) {
          const entry = {
            id: value.value,
            name: value.name,
            ...(value.description == null ? {} : { description: value.description }),
          };

          try {
            const options = await this.setConfigOption(sessionId, model.id, value.value);
            const thought = selectOption(options, "thought_level");

            models.push({
              ...entry,
              thoughts: valuesOf(thought).map((item) => ({ value: item.value, name: item.name })),
              ...(thought === undefined ? {} : { defaultThought: thought.currentValue }),
            });
          } catch (error) {
            // One model that refuses a switch must not hide every other model.
            logWarn(this.name, `could not read thinking levels for ${value.value}: ${errorMessage(error)}`);
            models.push({ ...entry, thoughts: [] });
          }
        }
      }

      return {
        models,
        ...(model === undefined ? {} : { defaultModel: model.currentValue }),
      };
    } finally {
      await this.closeSession(sessionId);
    }
  }

  /**
   * Closes a session this client created. Agents without `session/close` get
   * `session/delete` as the cleanup fallback. Loaded or resumed sessions are
   * only released locally: deleting them would destroy the user's history.
   */
  async closeSession(sessionId: string): Promise<void> {
    const owned = this.sessions.get(sessionId)?.owned === true;
    this.forget(sessionId);
    if (this.isClosed) return;

    if (!this.canCloseSession) {
      if (!this.canDeleteSession || !owned) return;
      try {
        await this.deleteSession(sessionId);
      } catch (error) {
        logWarn(this.name, `session/delete failed: ${errorMessage(error)}`);
      }
      return;
    }

    try {
      await this.connection.agent.request(
        "session/close",
        { sessionId },
        { cancellationSignal: AbortSignal.timeout(CLOSE_TIMEOUT_MS), stopWaitingOnCancel: true },
      );
    } catch (error) {
      logWarn(this.name, `session/close failed: ${errorMessage(error)}`);
    }
  }

  /** Whether this process has created or loaded the ACP session. */
  hasSession(sessionId: string): boolean {
    return this.sessions.get(sessionId)?.loaded === true;
  }

  /**
   * Sends one prompt and starts collecting the session updates it produces.
   *
   * `context` ties reverse requests from the agent to the OpenCode session that
   * owns this turn. The caller reads `updates` until it ends, then inspects
   * `response` (or `error`). Aborting `signal`, or calling `dispose()`, sends
   * `session/cancel`, answers pending permission requests with `cancelled`, and
   * ends the update stream once the agent answers or after a short grace
   * period.
   */
  prompt(
    sessionId: string,
    content: readonly ContentBlock[],
    context: AcpPromptContext,
    signal?: AbortSignal,
  ): AcpPrompt {
    if (signal?.aborted) return settledPrompt({ response: { stopReason: "cancelled" } });
    if (this.isClosed) return settledPrompt({ error: this.closedError() });

    const queue = new UpdateQueue();
    const controller = new AbortController();
    const turn: TurnState = {
      sessionID: context.sessionID,
      agentName: this.displayName,
      cwd: context.cwd,
      requestPermission: context.requestPermission,
      requestElicitation: context.requestElicitation,
      controller,
      queue,
      pending: new Set(),
    };

    const session = this.session(sessionId);
    session.queue = queue;
    session.turn = turn;

    // Session-level updates that arrived between turns belong to this turn.
    for (const update of session.pending) queue.push(update);
    session.pending = [];

    let done = false;
    let cancelled = false;
    let grace: ReturnType<typeof setTimeout> | undefined;

    const finish = (outcome: { response: PromptResponse } | { error: unknown }) => {
      if (done) return;
      done = true;
      if (grace !== undefined) clearTimeout(grace);
      signal?.removeEventListener("abort", cancel);
      if (session.queue === queue) session.queue = undefined;
      if (session.turn === turn) session.turn = undefined;
      this.releasePending(turn);
      if (!controller.signal.aborted) controller.abort();

      if ("response" in outcome) prompt.response = outcome.response;
      else prompt.error = outcome.error;

      queue.end();
    };

    const cancel = () => {
      if (cancelled || done) return;
      cancelled = true;
      void this.cancel(sessionId);
      // A cancelled turn normally answers immediately; do not keep the stream
      // open if this agent does not.
      grace = setTimeout(() => finish({ response: { stopReason: "cancelled" } }), CANCEL_TIMEOUT_MS);
    };

    const prompt: AcpPrompt = {
      updates: drain(queue),
      response: undefined,
      error: undefined,
      dispose: () => {
        if (done) return;
        cancel();
        queue.end();
      },
    };

    this.connection.agent.request("session/prompt", { sessionId, prompt: [...content] }).then(
      (response) => finish({ response }),
      (error) => finish({ error }),
    );

    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();

    return prompt;
  }

  async cancel(sessionId: string): Promise<void> {
    this.abortTurn(sessionId);
    if (this.connection.signal.aborted) return;
    await this.connection.agent.notify("session/cancel", { sessionId });
  }

  close(): void {
    this.closedByUser = true;
    try {
      this.connection.close();
    } catch {
      // Already closed.
    }

    this.child.stdin?.end();
    terminateProcessTree(this.child);
  }

  /** Error used when a request is attempted after the process or connection is gone. */
  private closedError(): Error {
    if (this.exitInfo !== undefined) {
      return new Error(`ACP process exited (${describeExit(this.exitInfo)})`);
    }
    return new Error("ACP connection closed");
  }

  /** Drops everything learned about one ACP session. */
  private forget(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  /** Answers pending permission requests with `cancelled` before the turn ends. */
  private abortTurn(sessionId: string): void {
    const turn = this.sessions.get(sessionId)?.turn;
    if (turn === undefined) return;

    if (!turn.controller.signal.aborted) turn.controller.abort();
    this.releasePending(turn);
  }

  private releasePending(turn: TurnState): void {
    for (const resolve of [...turn.pending]) resolve(cancelledPermission());
    turn.pending.clear();
  }

  private reset(): void {
    for (const session of this.sessions.values()) {
      const turn = session.turn;
      if (turn === undefined) continue;
      if (!turn.controller.signal.aborted) turn.controller.abort();
      this.releasePending(turn);
    }
    this.sessions.clear();
  }

  private session(sessionId: string): SessionState {
    return sessionOf(this.sessions, sessionId);
  }

  private rememberModes(session: SessionState, state: SessionModeState | null | undefined): void {
    session.modes = state ?? undefined;
  }
}

/** Runtime state of one prompt turn, including its outstanding reverse requests. */
interface TurnState extends AcpPromptContext {
  readonly agentName: string;
  readonly controller: AbortController;
  readonly queue: UpdateQueue;
  readonly pending: Set<(response: RequestPermissionResponse) => void>;
}

/** One in-flight prompt turn. */
export interface AcpPrompt {
  /** Session updates produced by the turn, in arrival order. */
  readonly updates: AsyncIterable<SessionUpdate>;
  /** Final response, set once the agent answers. */
  response: PromptResponse | undefined;
  /** Request failure, set when the turn could not run. */
  error: unknown;
  /** Stops the turn and releases the session's update routing. */
  dispose(): void;
}

function settledPrompt(outcome: { response: PromptResponse } | { error: unknown }): AcpPrompt {
  return {
    updates: (async function* () {
      return;
    })(),
    response: "response" in outcome ? outcome.response : undefined,
    error: "error" in outcome ? outcome.error : undefined,
    dispose() {},
  };
}

/** Shared state the notification handler fills before a prompt reads it. */
interface ContextWindow {
  size?: number;
}

/**
 * Stops the agent and anything it forked.
 *
 * Agents are spawned in their own process group, so signalling the negative
 * PID reaches grandchildren that would otherwise be orphaned. A short grace
 * period lets the agent clean up before SIGKILL.
 */
export function terminateProcessTree(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (child.exitCode !== null || child.signalCode !== null) return;

  const signal = (value: NodeJS.Signals): boolean => {
    if (process.platform !== "win32") {
      try {
        process.kill(-pid, value);
        return true;
      } catch (error) {
        if (!isMissingProcess(error)) return false;
      }
    }

    try {
      child.kill(value);
      return true;
    } catch {
      return false;
    }
  };

  if (!signal("SIGTERM")) return;
  const timer = setTimeout(() => {
    signal("SIGKILL");
  }, 2_000);
  timer.unref?.();
}

function isMissingProcess(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ESRCH";
}

function cancelledPermission(): RequestPermissionResponse {
  return { outcome: { outcome: "cancelled" } };
}

function declinePermission(params: RequestPermissionRequest): RequestPermissionResponse {
  const option =
    params.options.find((item) => (item.kind as string) === "reject_once") ??
    params.options.find((item) => (item.kind as string) === "reject_always");

  if (option === undefined) return cancelledPermission();
  return { outcome: { outcome: "selected", optionId: option.optionId } };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

async function* drain(queue: UpdateQueue): AsyncGenerator<SessionUpdate> {
  for (;;) {
    const next = await queue.next();
    if (next.done) return;
    yield next.value;
  }
}

/** A promise queue that preserves notification arrival order. */
class UpdateQueue {
  private readonly items: SessionUpdate[] = [];
  private readonly waiters: Array<(result: IteratorResult<SessionUpdate>) => void> = [];
  private ended = false;

  push(update: SessionUpdate): void {
    if (this.ended) return;

    const waiter = this.waiters.shift();
    if (waiter !== undefined) waiter({ value: update, done: false });
    else this.items.push(update);
  }

  end(): void {
    if (this.ended) return;
    this.ended = true;

    for (const waiter of this.waiters.splice(0)) waiter({ value: undefined, done: true });
  }

  next(): Promise<IteratorResult<SessionUpdate>> {
    const item = this.items.shift();
    if (item !== undefined) return Promise.resolve({ value: item, done: false });
    if (this.ended) return Promise.resolve({ value: undefined, done: true });

    return new Promise((resolve) => this.waiters.push(resolve));
  }
}
