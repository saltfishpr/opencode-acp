import { Readable, Writable } from "node:stream";

import * as acp from "@agentclientprotocol/sdk";
import type {
  AgentCapabilities,
  AuthMethod,
  Implementation,
  InitializeResponse,
  McpServer,
  NewSessionResponse,
  SessionConfigOption,
  SessionInfo,
  SessionModeState,
  SessionNotification,
  SessionUpdate,
  SubagentUpdate,
  SystemPrompt,
} from "@agentclientprotocol/sdk";
import type {
  ClientContext as UnstableClientContext,
  ForkSessionRequest,
  InitialSessionConfigOption,
} from "@agentclientprotocol/sdk/unstable";

import {
  assertAdditionalDirectoriesSupported,
  assertCloseSessionSupported,
  assertDeleteSessionSupported,
  assertForkSessionSupported,
  assertListSessionsSupported,
  assertLoadSessionSupported,
  assertMcpServersSupported,
  assertInitialConfigOptionsSupported,
  assertResumeSessionSupported,
  assertSessionOptionsSessionSupported,
  assertSessionOptionsSupported,
  assertSessionStatusSupported,
  assertSessionTitleSupported,
  assertSystemPromptSupported,
  buildClientCapabilities,
  validateHost,
} from "../capabilities.js";
import {
  AcpCancelledError,
  AcpDisposedError,
  AcpError,
  AcpInitializeTimeoutError,
  AcpInvalidArgumentError,
  AcpNotStartedError,
  AcpPaginationError,
  AcpPendingUpdatesOverflowError,
  AcpProcessExitedError,
  AcpProtocolVersionError,
  AcpReadOnlySessionError,
  AcpRequestError,
  AcpSessionBusyError,
  AcpSessionNotFoundError,
  AcpSpawnError,
  AcpTerminalAuthError,
  AcpTimeoutError,
  AcpUnstableFeatureError,
  AcpUnsupportedCapabilityError,
  mapRequestError,
} from "../errors.js";
import { TypedEmitter } from "../events.js";
import { createLogger, type AcpLogger } from "../logger.js";
import { M } from "../methods.js";
import { AgentProcess, type ProcessExitInfo } from "../process.js";
import { loadUnstableProfile, stableProfile, type SdkProfile } from "../sdk/profile.js";
import {
  deriveMode,
  deriveModel,
  normalizeConfigOptions,
} from "../session/config.js";
import { validateSystemPrompt } from "../session/content.js";
import { AcpSession } from "../session/session.js";
import { buildClientSnapshot } from "../session/snapshot.js";
import { SessionState } from "../session/state.js";
import { createExperimentalApi } from "../unstable/experimental.js";
import { UM } from "../unstable/methods.js";
import type {
  AcpClientOptions,
  AcpHost,
  ClientEvent,
  ClientSnapshot,
  ClientState,
  ExperimentalApi,
  ForkSessionOptions,
  HostContext,
  ListSessionsOptions,
  LoadSessionOptions,
  NewSessionOptions,
  ResumeSessionOptions,
  SessionOptionsQuery,
  SessionOptionsSnapshot,
  SessionStatus,
} from "../types/public.js";
import {
  estimateBytes,
  mergeEnv,
  requireAbsolutePath,
  requireAbsolutePaths,
  resolveProcessCwd,
} from "../util.js";

interface NormalizedOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  clientInfo: Implementation;
  host?: AcpHost;
  timeouts: {
    spawnMs: number;
    initializeMs: number;
    disposeMs: number;
  };
  maxStderrBytes: number;
  maxPendingUpdates: number;
  maxPendingUpdateBytes: number;
  maxMessageBytes?: number;
  logger: AcpLogger;
  initializeMeta?: Record<string, unknown>;
  capabilitiesMeta?: Record<string, unknown>;
  unstable: boolean;
}

interface PendingUpdate {
  sessionId: string;
  update: SessionUpdate;
  bytes: number;
}

interface PendingNewRequest {
  controller: AbortController;
}

interface PreparedSessionOptions {
  cwd: string;
  mcpServers: McpServer[];
  additionalDirectories?: string[];
  systemPrompt?: SystemPrompt;
  configOptions?: readonly InitialSessionConfigOption[];
}

function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

export class AcpClient {
  private readonly options: NormalizedOptions;
  private readonly logger: Required<AcpLogger>;
  private readonly emitter: TypedEmitter<ClientEvent>;
  private readonly hostController = new AbortController();
  private readonly sessionMap = new Map<string, AcpSession>();

  private profile: SdkProfile | null = null;
  private agentProcess: AgentProcess | null = null;
  private connection: acp.ClientConnection | null = null;
  private ctx: acp.ClientContext | null = null;

  private startPromise: Promise<InitializeResponse> | null = null;
  private disposePromise: Promise<void> | null = null;
  private disposed = false;

  private clientState: ClientState = "idle";
  private agentInfoValue: Implementation | null = null;
  private agentCapabilitiesValue: AgentCapabilities | null = null;
  private authMethodsValue: AuthMethod[] = [];
  private initializeResponse: InitializeResponse | null = null;

  private readonly pendingUpdates: PendingUpdate[] = [];
  private pendingUpdateBytes = 0;
  private readonly pendingNewRequests = new Set<PendingNewRequest>();

  private clientRevision = 0;
  private clientSnapshotCache: { key: string; snapshot: ClientSnapshot } | null = null;
  private lastStderr = "";
  private processExitError: AcpProcessExitedError | null = null;

  readonly experimental: ExperimentalApi | null;

  constructor(options: AcpClientOptions) {
    this.options = normalizeOptions(options);
    this.logger = createLogger(options.logger);
    this.emitter = new TypedEmitter((error) => this.reportListenerError(error));
    this.experimental = options.experimental?.unstable
      ? createExperimentalApi(this)
      : null;
  }

  get state(): ClientState {
    return this.clientState;
  }

  get pid(): number | null {
    return this.agentProcess?.pid ?? null;
  }

  get stderr(): string {
    return this.agentProcess?.stderr ?? this.lastStderr;
  }

  get agentInfo(): Implementation | null {
    return this.agentInfoValue;
  }

  get agentCapabilities(): AgentCapabilities | null {
    return this.agentCapabilitiesValue;
  }

  get authMethods(): readonly AuthMethod[] {
    return this.authMethodsValue;
  }

  get sessions(): readonly AcpSession[] {
    return [...this.sessionMap.values()];
  }

  getSession(sessionId: string): AcpSession | undefined {
    return this.sessionMap.get(sessionId);
  }

  isReady(): boolean {
    return this.clientState === "ready" && this.ctx !== null;
  }

  getSnapshot(): ClientSnapshot {
    const key = `${this.clientRevision}:${[...this.sessionMap.values()]
      .map((session) => `${session.sessionId}=${session.state.revision}`)
      .join(",")}`;
    if (this.clientSnapshotCache?.key === key) {
      return this.clientSnapshotCache.snapshot;
    }
    const snapshot = buildClientSnapshot({
      state: this.clientState,
      agentInfo: this.agentInfoValue,
      agentCapabilities: this.agentCapabilitiesValue,
      authMethods: this.authMethodsValue,
      sessions: [...this.sessionMap.values()].map((session) => session.state),
      stderr: this.stderr,
      revision: this.clientRevision,
    });
    this.clientSnapshotCache = { key, snapshot };
    return snapshot;
  }

  subscribe(listener: (event: ClientEvent) => void): () => void {
    return this.emitter.subscribe(listener);
  }

  async start(): Promise<InitializeResponse> {
    if (this.disposed) {
      throw new AcpDisposedError();
    }
    if (this.clientState === "ready" && this.initializeResponse) {
      return this.initializeResponse;
    }
    if (this.startPromise) {
      return this.startPromise;
    }
    if (
      this.clientState === "starting" ||
      this.clientState === "restarting" ||
      this.clientState === "disposing"
    ) {
      throw new AcpSessionBusyError(`ACP client is ${this.clientState}`);
    }

    this.startPromise = this.doStart().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  async restart(): Promise<InitializeResponse> {
    return this.restartInternal(false);
  }

  async dispose(): Promise<void> {
    if (this.disposePromise) {
      return this.disposePromise;
    }
    this.disposed = true;
    this.hostController.abort();
    this.disposePromise = this.doDispose();
    return this.disposePromise;
  }

  async authenticate(
    methodId: string,
    options?: { force?: boolean },
  ): Promise<void> {
    this.requireReady();
    const method = this.authMethodsValue.find((entry) => entry.id === methodId);
    if (!method) {
      throw new AcpInvalidArgumentError(`Unknown authentication method "${methodId}"`);
    }

    if ("type" in method && method.type === "terminal") {
      const host = this.options.host?.terminalAuth;
      if (!host) {
        throw new AcpUnsupportedCapabilityError("auth.terminal host handler");
      }
      if (this.sessionMap.size > 0 && !options?.force) {
        throw new AcpSessionBusyError(
          "Terminal authentication restarts the agent; close active sessions or pass force: true",
        );
      }

      const invocation = {
        method,
        command: this.options.command,
        args: [...this.options.args, ...(method.args ?? [])],
        cwd: this.options.cwd,
        env: mergeEnv(this.options.env, method.env),
      };
      const result = await host(invocation, {
        client: this,
        session: undefined,
        sessionId: undefined,
        signal: this.hostController.signal,
        method: "terminal-auth",
      });
      if (result.exitCode !== 0) {
        throw new AcpTerminalAuthError(methodId, result.exitCode, result.signal ?? null);
      }
      await this.restartInternal(true);
      return;
    }

    await this.requestAgent(M.authenticate, { methodId });
  }

  async logout(): Promise<void> {
    this.requireReady();
    if (!this.agentCapabilitiesValue?.auth?.logout) {
      throw new AcpUnsupportedCapabilityError("agentCapabilities.auth.logout");
    }
    await this.requestAgent(M.logout, {});
  }

  async newSession(options: NewSessionOptions): Promise<AcpSession> {
    this.requireReady();
    const prepared = this.prepareSessionOptions(options);
    return this.createRootSession(prepared, (signal) =>
      this.requestAgent(
        M.sessionNew,
        {
          cwd: prepared.cwd,
          mcpServers: prepared.mcpServers,
          ...(prepared.additionalDirectories
            ? { additionalDirectories: prepared.additionalDirectories }
            : {}),
          ...(prepared.systemPrompt ? { systemPrompt: prepared.systemPrompt } : {}),
          ...(prepared.configOptions
            ? { configOptions: [...prepared.configOptions] }
            : {}),
        },
        { signal },
      ),
    );
  }

  async loadSession(options: LoadSessionOptions): Promise<AcpSession> {
    this.requireReady();
    assertLoadSessionSupported(this.agentCapabilitiesValue);
    const prepared = this.prepareSessionOptions(options);
    this.discardClosedSession(options.sessionId);

    const state = new SessionState({
      sessionId: options.sessionId,
      kind: "root",
      parent: null,
      cwd: prepared.cwd,
      additionalDirectories: prepared.additionalDirectories ?? [],
    });
    state.loading = true;
    state.lifecycle = "loading";
    const session = new AcpSession(this, state);
    this.sessionMap.set(options.sessionId, session);
    this.emitSession("created", options.sessionId);

    try {
      const response = await this.requestAgent(M.sessionLoad, {
        sessionId: options.sessionId,
        cwd: prepared.cwd,
        mcpServers: prepared.mcpServers,
        ...(prepared.additionalDirectories
          ? { additionalDirectories: prepared.additionalDirectories }
          : {}),
        ...(prepared.systemPrompt ? { systemPrompt: prepared.systemPrompt } : {}),
        ...(prepared.configOptions
          ? { configOptions: [...prepared.configOptions] }
          : {}),
      });
      session.finishLoading(response);
      this.emitSession("ready", options.sessionId);
      this.touchClient();
      return session;
    } catch (error) {
      const mapped = mapRequestError("session/load", error);
      this.removeSessionTree(options.sessionId);
      session.markFailed(mapped);
      this.emitSession("failed", options.sessionId);
      this.touchClient();
      throw mapped;
    }
  }

  async resumeSession(options: ResumeSessionOptions): Promise<AcpSession> {
    this.requireReady();
    assertResumeSessionSupported(this.agentCapabilitiesValue);
    const prepared = this.prepareSessionOptions(options);
    this.discardClosedSession(options.sessionId);

    const state = new SessionState({
      sessionId: options.sessionId,
      kind: "root",
      parent: null,
      cwd: prepared.cwd,
      additionalDirectories: prepared.additionalDirectories ?? [],
    });
    state.loading = true;
    state.lifecycle = "loading";
    const session = new AcpSession(this, state);
    this.sessionMap.set(options.sessionId, session);
    this.emitSession("created", options.sessionId);

    try {
      const response = await this.requestAgent(M.sessionResume, {
        sessionId: options.sessionId,
        cwd: prepared.cwd,
        mcpServers: prepared.mcpServers,
        ...(prepared.additionalDirectories
          ? { additionalDirectories: prepared.additionalDirectories }
          : {}),
        ...(prepared.systemPrompt ? { systemPrompt: prepared.systemPrompt } : {}),
        ...(prepared.configOptions
          ? { configOptions: [...prepared.configOptions] }
          : {}),
      });
      session.finishLoading(response);
      this.emitSession("ready", options.sessionId);
      this.touchClient();
      return session;
    } catch (error) {
      const mapped = mapRequestError("session/resume", error);
      this.removeSessionTree(options.sessionId);
      session.markFailed(mapped);
      this.emitSession("failed", options.sessionId);
      this.touchClient();
      throw mapped;
    }
  }

  async listSessions(options?: ListSessionsOptions): Promise<acp.ListSessionsResponse> {
    this.requireReady();
    assertListSessionsSupported(this.agentCapabilitiesValue);
    if (options?.cwd !== undefined) {
      requireAbsolutePath(options.cwd, "cwd");
    }
    return this.requestAgent(M.sessionList, {
      ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options?.cursor !== undefined && options.cursor !== null
        ? { cursor: options.cursor }
        : {}),
    });
  }

  async *listAllSessions(options?: { cwd?: string }): AsyncIterable<SessionInfo> {
    this.requireReady();
    assertListSessionsSupported(this.agentCapabilitiesValue);
    const seen = new Set<string>();
    let cursor: string | null = null;

    while (true) {
      const page = await this.listSessions({
        ...(options?.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(cursor !== null ? { cursor } : {}),
      });
      for (const session of page.sessions) {
        yield session;
      }
      if (!page.nextCursor) {
        return;
      }
      if (seen.has(page.nextCursor)) {
        throw new AcpPaginationError(page.nextCursor);
      }
      seen.add(page.nextCursor);
      cursor = page.nextCursor;
    }
  }

  async closeSession(sessionId: string): Promise<void> {
    this.requireReady();
    assertCloseSessionSupported(this.agentCapabilitiesValue);
    const session = this.sessionMap.get(sessionId);
    if (session?.kind === "subagent") {
      throw new AcpReadOnlySessionError("close");
    }
    if (session?.state.lifecycle === "loading") {
      throw new AcpSessionBusyError(`Session "${sessionId}" is still loading`);
    }
    if (
      session &&
      (session.state.lifecycle === "closed" || session.state.lifecycle === "deleted")
    ) {
      return;
    }

    await this.requestAgent(M.sessionClose, { sessionId });
    if (session) {
      session.markClosed({ reason: "closed" });
      this.removeSessionTree(sessionId);
      this.emitSession("closed", sessionId);
      this.touchClient();
    }
  }

  async deleteSession(sessionId: string): Promise<void> {
    this.requireReady();
    assertDeleteSessionSupported(this.agentCapabilitiesValue);
    const session = this.sessionMap.get(sessionId);
    if (session?.kind === "subagent") {
      throw new AcpReadOnlySessionError("delete");
    }
    if (session?.state.lifecycle === "loading") {
      throw new AcpSessionBusyError(`Session "${sessionId}" is still loading`);
    }
    if (session?.state.lifecycle === "deleted") {
      return;
    }

    await this.requestAgent(M.sessionDelete, { sessionId });
    if (session) {
      session.markClosed({ reason: "deleted" });
      this.removeSessionTree(sessionId);
      this.emitSession("deleted", sessionId);
      this.touchClient();
    }
  }

  /** @internal */
  async requestAgent<Method extends acp.AgentRequestMethod>(
    method: Method,
    params: acp.AgentRequestParamsByMethod[Method],
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<acp.AgentRequestResponsesByMethod[Method]> {
    return this.sendRequest(this.requireContext(), method, params, options);
  }

  /** @internal */
  async notifyAgent<Method extends acp.AgentNotificationMethod>(
    method: Method,
    params: acp.AgentNotificationParamsByMethod[Method],
  ): Promise<void> {
    try {
      await this.requireContext().notify(method, params);
    } catch (error) {
      throw mapRequestError(method, error);
    }
  }

  /** @internal */
  applySubagentUpdate(parent: AcpSession, update: SubagentUpdate): void {
    let child = this.sessionMap.get(update.sessionId);
    if (!child) {
      const childState = new SessionState({
        sessionId: update.sessionId,
        kind: "subagent",
        parent: parent.state,
        cwd: parent.state.effectiveCwd(),
        additionalDirectories: parent.state.effectiveAdditionalDirectories(),
      });
      child = new AcpSession(this, childState);
      this.sessionMap.set(update.sessionId, child);
      this.emitSession("created", update.sessionId);
    }

    let meta = parent.state.subagents.get(update.sessionId);
    if (!meta) {
      meta = {
        sessionId: update.sessionId,
        title: null,
        description: null,
        reportedCwd: null,
        reportedAdditionalDirectories: null,
        capabilities: null,
        state: null,
      };
      parent.state.subagents.set(update.sessionId, meta);
    }

    if (hasOwn(update, "title")) {
      meta.title = update.title ?? null;
    }
    if (hasOwn(update, "description")) {
      meta.description = update.description ?? null;
    }
    if (hasOwn(update, "capabilities")) {
      meta.capabilities = update.capabilities ?? null;
    }
    if (hasOwn(update, "state")) {
      meta.state = update.state ?? null;
    }
    if (hasOwn(update, "cwd")) {
      meta.reportedCwd = update.cwd ?? null;
      child.state.reportedCwd = update.cwd ?? null;
    }
    if (hasOwn(update, "additionalDirectories")) {
      meta.reportedAdditionalDirectories = update.additionalDirectories
        ? [...update.additionalDirectories]
        : null;
      child.state.reportedAdditionalDirectories = update.additionalDirectories
        ? [...update.additionalDirectories]
        : null;
    }

    child.state.touch();
    child.invalidate();
    parent.invalidate();
    this.touchClient();
  }

  /** @internal */
  handleNotice(session: AcpSession, notice: import("@agentclientprotocol/sdk").Notice): void {
    const handler = this.options.host?.notice;
    if (!handler) {
      return;
    }
    try {
      handler(notice, this.hostContext(session.sessionId, this.hostController.signal, "session/update"));
    } catch (error) {
      this.reportError(mapRequestError("session/update", error));
    }
  }

  /** @internal */
  reportListenerError(error: unknown): void {
    this.logger.error("ACP event listener failed", error);
  }

  /** @internal */
  reportError(error: AcpError): void {
    this.logger.error(error.message, error);
    this.emitter.emit({ type: "error", error });
    this.touchClient();
  }

  /** @internal */
  async forkSessionUnstable(options: ForkSessionOptions): Promise<AcpSession> {
    this.requireReady();
    if (this.profile?.name !== "unstable" || !this.experimental) {
      throw new AcpUnstableFeatureError("session/fork");
    }
    assertForkSessionSupported(this.agentCapabilitiesValue);

    const prepared = this.prepareSessionOptions({
      cwd: options.cwd,
      mcpServers: options.mcpServers,
      additionalDirectories: options.additionalDirectories,
      systemPrompt: options.systemPrompt,
      configOptions: options.configOptions,
    });

    if (options.cursorId !== undefined && options.cursorId !== null) {
      throw new AcpUnsupportedCapabilityError("session cursors");
    }

    const params: ForkSessionRequest = {
      sessionId: options.sessionId,
      cwd: prepared.cwd,
      mcpServers: prepared.mcpServers,
      ...(prepared.additionalDirectories
        ? { additionalDirectories: prepared.additionalDirectories }
        : {}),
      ...(prepared.systemPrompt ? { systemPrompt: prepared.systemPrompt } : {}),
      ...(prepared.configOptions
        ? { configOptions: [...prepared.configOptions] }
        : {}),
    };

    const unstableCtx = this.requireUnstableContext(UM.sessionFork);
    return this.createRootSession(
      prepared,
      (signal) =>
        unstableCtx.request(UM.sessionFork, params, {
          cancellationSignal: signal,
          stopWaitingOnCancel: true,
        }),
      UM.sessionFork,
    );
  }

  /** @internal */
  async getSessionStatusUnstable(sessionId: string): Promise<SessionStatus> {
    const ctx = this.requireUnstableContext(UM.sessionStatus);
    assertSessionStatusSupported(this.agentCapabilitiesValue);

    try {
      const response = await ctx.request(UM.sessionStatus, { sessionId });
      const status = normalizeSessionStatus(response.status);
      this.sessionMap.get(sessionId)?.applyAgentStatus(status);
      return status;
    } catch (error) {
      throw this.mapSessionRequestError(UM.sessionStatus, sessionId, error);
    }
  }

  /** @internal */
  async getSessionOptionsUnstable(
    options: SessionOptionsQuery,
  ): Promise<SessionOptionsSnapshot> {
    const ctx = this.requireUnstableContext(UM.sessionOptions);
    assertSessionOptionsSupported(this.agentCapabilitiesValue);

    const cwd = requireAbsolutePath(options.cwd, "cwd");
    const additionalDirectories =
      options.additionalDirectories !== undefined
        ? requireAbsolutePaths(options.additionalDirectories, "additionalDirectories")
        : undefined;
    assertAdditionalDirectoriesSupported(
      this.agentCapabilitiesValue,
      additionalDirectories,
    );
    const supportsAdditionalDirectories = Boolean(
      this.agentCapabilitiesValue?.sessionCapabilities?.additionalDirectories,
    );

    if (options.sessionId != null) {
      assertSessionOptionsSessionSupported(this.agentCapabilitiesValue);
      const session = this.sessionMap.get(options.sessionId);
      if (session?.kind === "subagent") {
        throw new AcpReadOnlySessionError("session/options");
      }
    }

    try {
      const response = await ctx.request(UM.sessionOptions, {
        cwd,
        ...(additionalDirectories !== undefined &&
        (additionalDirectories.length > 0 || supportsAdditionalDirectories)
          ? { additionalDirectories: [...additionalDirectories] }
          : {}),
        ...(options.sessionId != null ? { sessionId: options.sessionId } : {}),
      });
      return normalizeSessionOptions(response);
    } catch (error) {
      if (options.sessionId != null) {
        throw this.mapSessionRequestError(
          UM.sessionOptions,
          options.sessionId,
          error,
        );
      }
      throw mapRequestError(UM.sessionOptions, error);
    }
  }

  /** @internal */
  async setSessionTitleUnstable(sessionId: string, title: string): Promise<string> {
    const ctx = this.requireUnstableContext(UM.sessionSetTitle);
    assertSessionTitleSupported(this.agentCapabilitiesValue);
    if (title.trim().length === 0) {
      throw new AcpInvalidArgumentError("title must not be empty");
    }

    const session = this.sessionMap.get(sessionId);
    if (session?.kind === "subagent") {
      throw new AcpReadOnlySessionError("session/set_title");
    }

    try {
      const response = await ctx.request(UM.sessionSetTitle, { sessionId, title });
      session?.applyTitle(response.title);
      return response.title;
    } catch (error) {
      throw this.mapSessionRequestError(UM.sessionSetTitle, sessionId, error);
    }
  }

  private requireUnstableContext(feature: string): UnstableClientContext {
    this.requireReady();
    if (this.profile?.name !== "unstable" || !this.experimental) {
      throw new AcpUnstableFeatureError(feature);
    }
    return this.ctx as unknown as UnstableClientContext;
  }

  private mapSessionRequestError(
    method: string,
    sessionId: string,
    error: unknown,
  ): AcpError {
    if (error instanceof acp.RequestError && error.code === -32002) {
      return new AcpSessionNotFoundError(sessionId);
    }
    return mapRequestError(method, error);
  }

  private async doStart(): Promise<InitializeResponse> {
    this.setClientState("starting");
    this.lastStderr = "";
    this.processExitError = null;

    try {
      this.profile = this.options.unstable
        ? await loadUnstableProfile()
        : stableProfile;

      if (this.disposed) {
        throw new AcpDisposedError();
      }

      const processHandle = new AgentProcess({
        command: this.options.command,
        args: this.options.args,
        cwd: this.options.cwd,
        env: this.options.env,
        spawnMs: this.options.timeouts.spawnMs,
        maxStderrBytes: this.options.maxStderrBytes,
        logger: this.logger,
        onStderr: (chunk) => {
          this.emitter.emit({ type: "stderr", chunk });
          this.touchClient();
        },
      });
      this.agentProcess = processHandle;

      if (this.disposed) {
        throw new AcpDisposedError();
      }

      try {
        await processHandle.spawn();
      } catch (error) {
        throw new AcpSpawnError(this.options.command, this.options.cwd, error);
      }

      if (this.disposed) {
        await processHandle.terminate(this.options.timeouts.disposeMs).catch(() => {});
        throw new AcpDisposedError();
      }

      processHandle.onExit((info) => this.handleProcessExit(info));
      if (!processHandle.isAlive && processHandle.lastExit) {
        this.handleProcessExit(processHandle.lastExit);
      }

      const app = this.profile.createApp("acp-client-sdk");
      this.registerHandlers(app);
      const stream = this.profile.createStream(
        Writable.toWeb(processHandle.stdin as unknown as Writable),
        Readable.toWeb(processHandle.stdout as unknown as Readable),
        this.options.maxMessageBytes !== undefined
          ? { maxMessageBytes: this.options.maxMessageBytes }
          : undefined,
      );
      const connection = app.connect(stream);
      this.connection = connection;
      this.ctx = connection.agent;

      void connection.closed.then(() => this.handleConnectionClosed());

      let response: InitializeResponse;
      try {
        response = await this.sendRequest(
          connection.agent,
          M.initialize,
          {
            protocolVersion: this.profile.PROTOCOL_VERSION,
            clientCapabilities: buildClientCapabilities({
              host: this.options.host,
              capabilitiesMeta: this.options.capabilitiesMeta,
            }),
            clientInfo: this.options.clientInfo,
            ...(this.options.initializeMeta
              ? { _meta: this.options.initializeMeta }
              : {}),
          },
          { timeoutMs: this.options.timeouts.initializeMs },
        );
      } catch (error) {
        if (error instanceof AcpTimeoutError) {
          throw new AcpInitializeTimeoutError(this.options.timeouts.initializeMs);
        }
        throw error;
      }

      if (response.protocolVersion !== this.profile.PROTOCOL_VERSION) {
        throw new AcpProtocolVersionError(
          response.protocolVersion,
          this.profile.PROTOCOL_VERSION,
        );
      }
      if (this.disposed) {
        throw new AcpDisposedError();
      }
      if (this.processExitError) {
        throw this.processExitError;
      }

      this.initializeResponse = response;
      this.agentInfoValue = response.agentInfo ?? null;
      this.agentCapabilitiesValue = response.agentCapabilities ?? {};
      this.authMethodsValue = [...(response.authMethods ?? [])];
      this.setClientState("ready");
      this.emitter.emit({ type: "initialized", response });
      this.touchClient();
      return response;
    } catch (error) {
      if (this.disposed) {
        throw new AcpDisposedError();
      }
      this.setClientState("failed");
      try {
        this.connection?.close(error);
      } catch {
        // 连接可能已经关闭。
      }
      this.connection = null;
      this.ctx = null;
      await this.agentProcess?.terminate(this.options.timeouts.disposeMs).catch(() => {});
      this.agentProcess = null;
      throw error instanceof AcpError ? error : mapRequestError("initialize", error);
    }
  }

  private async doDispose(): Promise<void> {
    if (this.clientState === "disposed") {
      return;
    }
    this.setClientState("disposing");

    for (const session of this.sessionMap.values()) {
      session.markClosed({ reason: "disposed" });
    }
    this.sessionMap.clear();

    try {
      this.connection?.close();
    } catch {
      // 连接可能已经关闭。
    }
    this.connection = null;
    this.ctx = null;

    await this.agentProcess?.terminate(this.options.timeouts.disposeMs).catch(() => {});
    this.agentProcess = null;

    this.pendingUpdates.length = 0;
    this.pendingUpdateBytes = 0;
    this.pendingNewRequests.clear();

    this.setClientState("disposed");
    this.touchClient();
  }

  private async restartInternal(force: boolean): Promise<InitializeResponse> {
    if (this.disposed) {
      throw new AcpDisposedError();
    }
    if (this.clientState === "starting" || this.clientState === "restarting") {
      throw new AcpSessionBusyError("ACP client is already starting");
    }
    if (this.sessionMap.size > 0 && !force) {
      throw new AcpSessionBusyError(
        "Restarting invalidates all sessions; close them first or pass force: true",
      );
    }

    this.setClientState("restarting");
    for (const session of this.sessionMap.values()) {
      session.markClosed({ reason: "restarted" });
    }
    this.sessionMap.clear();

    try {
      this.connection?.close();
    } catch {
      // 连接可能已经关闭。
    }
    this.connection = null;
    this.ctx = null;

    await this.agentProcess?.terminate(this.options.timeouts.disposeMs).catch(() => {});
    this.agentProcess = null;

    this.initializeResponse = null;
    this.agentInfoValue = null;
    this.agentCapabilitiesValue = null;
    this.authMethodsValue = [];
    this.pendingUpdates.length = 0;
    this.pendingUpdateBytes = 0;

    this.setClientState("idle");
    this.touchClient();
    return this.start();
  }

  private registerHandlers(app: acp.ClientApp): void {
    app.onRequest(M.requestPermission, async ({ params, signal }) => {
      const session = this.sessionMap.get(params.sessionId);
      if (session) {
        session.applyUpdate({
          sessionUpdate: "tool_call_update",
          ...params.toolCall,
        });
      }

      const handler = this.options.host?.permission;
      if (!handler) {
        return { outcome: { outcome: "cancelled" } };
      }

      try {
        const outcome = await handler(
          params,
          this.hostContext(params.sessionId, signal, M.requestPermission),
        );
        if (
          outcome.outcome === "selected" &&
          !params.options.some((option) => option.optionId === outcome.optionId)
        ) {
          this.reportError(
            new AcpRequestError(
              M.requestPermission,
              -32602,
              `Permission handler selected unknown option "${outcome.optionId}"`,
            ),
          );
          return { outcome: { outcome: "cancelled" } };
        }
        return { outcome };
      } catch (error) {
        this.reportError(mapRequestError(M.requestPermission, error));
        return { outcome: { outcome: "cancelled" } };
      }
    });

    const readTextFile = this.options.host?.fs?.readTextFile;
    if (readTextFile) {
      app.onRequest(M.fsReadTextFile, async ({ params, signal }) => {
        try {
          const result = await readTextFile(
            params,
            this.hostContext(params.sessionId, signal, M.fsReadTextFile),
          );
          return typeof result === "string" ? { content: result } : result;
        } catch (error) {
          throw this.toRequestError(error);
        }
      });
    }

    const writeTextFile = this.options.host?.fs?.writeTextFile;
    if (writeTextFile) {
      app.onRequest(M.fsWriteTextFile, async ({ params, signal }) => {
        try {
          const result = await writeTextFile(
            params,
            this.hostContext(params.sessionId, signal, M.fsWriteTextFile),
          );
          return result ?? {};
        } catch (error) {
          throw this.toRequestError(error);
        }
      });
    }

    const terminal = this.options.host?.terminal;
    if (terminal) {
      app.onRequest(M.terminalCreate, async ({ params, signal }) => {
        try {
          return await terminal.create(
            params,
            this.hostContext(params.sessionId, signal, M.terminalCreate),
          );
        } catch (error) {
          throw this.toRequestError(error);
        }
      });
      app.onRequest(M.terminalOutput, async ({ params, signal }) => {
        try {
          return await terminal.output(
            params,
            this.hostContext(params.sessionId, signal, M.terminalOutput),
          );
        } catch (error) {
          throw this.toRequestError(error);
        }
      });
      app.onRequest(M.terminalWaitForExit, async ({ params, signal }) => {
        try {
          return await terminal.waitForExit(
            params,
            this.hostContext(params.sessionId, signal, M.terminalWaitForExit),
          );
        } catch (error) {
          throw this.toRequestError(error);
        }
      });
      app.onRequest(M.terminalKill, async ({ params, signal }) => {
        try {
          return (
            (await terminal.kill(
              params,
              this.hostContext(params.sessionId, signal, M.terminalKill),
            )) ?? {}
          );
        } catch (error) {
          throw this.toRequestError(error);
        }
      });
      app.onRequest(M.terminalRelease, async ({ params, signal }) => {
        try {
          return (
            (await terminal.release(
              params,
              this.hostContext(params.sessionId, signal, M.terminalRelease),
            )) ?? {}
          );
        } catch (error) {
          throw this.toRequestError(error);
        }
      });
    }

    const elicitation = this.options.host?.elicitation;
    if (elicitation?.create) {
      app.onRequest(M.elicitationCreate, async ({ params, signal }) => {
        try {
          const sessionId =
            "sessionId" in params && typeof params.sessionId === "string"
              ? params.sessionId
              : undefined;
          return await elicitation.create(
            params,
            this.hostContext(sessionId, signal, M.elicitationCreate),
          );
        } catch (error) {
          throw this.toRequestError(error);
        }
      });
    }
    if (elicitation?.complete) {
      app.onNotification(M.elicitationComplete, ({ params }) => {
        try {
          elicitation.complete?.(params);
        } catch (error) {
          this.reportError(mapRequestError(M.elicitationComplete, error));
        }
      });
    }

    app.onNotification(M.sessionUpdate, ({ params }) => {
      this.handleSessionNotification(params);
    });
  }

  private handleSessionNotification(params: SessionNotification): void {
    const session = this.sessionMap.get(params.sessionId);
    if (session) {
      session.applyUpdate(params.update);
      return;
    }
    this.stageUnknownUpdate(params.sessionId, params.update);
  }

  private stageUnknownUpdate(sessionId: string, update: SessionUpdate): void {
    if (this.pendingNewRequests.size === 0) {
      this.logger.warn(
        `Received session/update for unknown session "${sessionId}"`,
      );
      return;
    }

    const bytes = estimateBytes(update);
    this.pendingUpdates.push({ sessionId, update, bytes });
    this.pendingUpdateBytes += bytes;

    if (
      this.pendingUpdates.length > this.options.maxPendingUpdates ||
      this.pendingUpdateBytes > this.options.maxPendingUpdateBytes
    ) {
      const error = new AcpPendingUpdatesOverflowError(
        this.options.maxPendingUpdates,
        this.options.maxPendingUpdateBytes,
      );
      for (const pending of this.pendingNewRequests) {
        pending.controller.abort(error);
      }
      this.pendingNewRequests.clear();
      this.pendingUpdates.length = 0;
      this.pendingUpdateBytes = 0;
      this.reportError(error);
    }
  }

  private drainStaged(sessionId: string): void {
    const accepted = new Set<string>([sessionId]);
    let progress = true;

    while (progress) {
      progress = false;
      const remaining: PendingUpdate[] = [];

      for (const entry of this.pendingUpdates) {
        if (!accepted.has(entry.sessionId)) {
          remaining.push(entry);
          continue;
        }

        const session = this.sessionMap.get(entry.sessionId);
        if (!session) {
          remaining.push(entry);
          continue;
        }

        session.applyUpdate(entry.update);
        if (entry.update.sessionUpdate === "subagent_update") {
          accepted.add(entry.update.sessionId);
        }
        progress = true;
      }

      this.pendingUpdates.length = 0;
      this.pendingUpdates.push(...remaining);
    }

    this.pendingUpdateBytes = this.pendingUpdates.reduce(
      (total, entry) => total + entry.bytes,
      0,
    );
  }

  /**
   * `closeSession` 成功后会移除会话；这里兜底处理仍留在 map 里的终态会话，
   * 允许同一连接内重新加载，并清掉其子会话条目。
   */
  private discardClosedSession(sessionId: string): void {
    const existing = this.sessionMap.get(sessionId);
    if (
      existing &&
      (existing.state.lifecycle === "loading" || existing.state.lifecycle === "active")
    ) {
      throw new AcpSessionBusyError(
        `Session "${sessionId}" is already active on this connection`,
      );
    }
    if (existing) {
      this.removeSessionTree(sessionId);
    }
  }

  /**
   * 随根会话一起移除子会话，避免旧条目拦住同 ID 的重新加载，
   * 也避免后续 subagent_update 路由到已失效的父会话。
   */
  private removeSessionTree(sessionId: string): void {
    const removed = new Set<string>([sessionId]);
    let progress = true;
    while (progress) {
      progress = false;
      for (const [id, session] of this.sessionMap) {
        if (removed.has(id)) continue;
        if (session.parentSessionId === null || !removed.has(session.parentSessionId)) {
          continue;
        }
        session.markClosed({ reason: "closed" });
        this.sessionMap.delete(id);
        removed.add(id);
        progress = true;
      }
    }
    this.sessionMap.delete(sessionId);
  }

  private async createRootSession(
    prepared: PreparedSessionOptions,
    request: (signal: AbortSignal) => Promise<NewSessionResponse>,
    method = "session/new",
  ): Promise<AcpSession> {
    const pending: PendingNewRequest = { controller: new AbortController() };
    this.pendingNewRequests.add(pending);

    try {
      const response = await request(pending.controller.signal);
      if (pending.controller.signal.aborted) {
        const reason = pending.controller.signal.reason;
        throw reason instanceof AcpError
          ? reason
          : new AcpCancelledError();
      }

      const state = new SessionState({
        sessionId: response.sessionId,
        kind: "root",
        parent: null,
        cwd: prepared.cwd,
        additionalDirectories: prepared.additionalDirectories ?? [],
      });
      state.hasConfigOptions = response.configOptions != null;
      state.configOptions = normalizeConfigOptions(response.configOptions);
      state.modes = response.modes ?? null;
      state.touch();

      const session = new AcpSession(this, state);
      this.sessionMap.set(response.sessionId, session);
      this.emitSession("created", response.sessionId);
      this.touchClient();

      this.drainStaged(response.sessionId);
      this.emitSession("ready", response.sessionId);
      this.touchClient();
      return session;
    } catch (error) {
      if (pending.controller.signal.aborted) {
        const reason = pending.controller.signal.reason;
        if (reason instanceof AcpError) {
          throw reason;
        }
      }
      throw mapRequestError(method, error);
    } finally {
      this.pendingNewRequests.delete(pending);
      if (this.pendingNewRequests.size === 0 && this.pendingUpdates.length > 0) {
        this.pendingUpdates.length = 0;
        this.pendingUpdateBytes = 0;
      }
    }
  }

  private prepareSessionOptions(options: NewSessionOptions): PreparedSessionOptions {
    const cwd = requireAbsolutePath(options.cwd, "cwd");
    const mcpServers = options.mcpServers ?? [];
    assertMcpServersSupported(this.agentCapabilitiesValue, mcpServers);

    const additionalDirectories =
      options.additionalDirectories !== undefined
        ? requireAbsolutePaths(options.additionalDirectories, "additionalDirectories")
        : undefined;
    assertAdditionalDirectoriesSupported(
      this.agentCapabilitiesValue,
      additionalDirectories,
    );
    const supportsAdditionalDirectories = Boolean(
      this.agentCapabilitiesValue?.sessionCapabilities?.additionalDirectories,
    );

    validateSystemPrompt(options.systemPrompt);
    assertSystemPromptSupported(this.agentCapabilitiesValue, options.systemPrompt);

    const configOptions =
      options.configOptions !== undefined ? [...options.configOptions] : undefined;
    if (configOptions && configOptions.length > 0) {
      if (this.profile?.name !== "unstable") {
        throw new AcpUnstableFeatureError("sessionCapabilities.options");
      }
      assertInitialConfigOptionsSupported(this.agentCapabilitiesValue);
    }

    return {
      cwd,
      mcpServers,
      ...(additionalDirectories !== undefined &&
      (additionalDirectories.length > 0 || supportsAdditionalDirectories)
        ? { additionalDirectories }
        : {}),
      ...(options.systemPrompt ? { systemPrompt: options.systemPrompt } : {}),
      ...(configOptions && configOptions.length > 0 ? { configOptions } : {}),
    };
  }

  private async sendRequest<Method extends acp.AgentRequestMethod>(
    ctx: acp.ClientContext,
    method: Method,
    params: acp.AgentRequestParamsByMethod[Method],
    options?: { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<acp.AgentRequestResponsesByMethod[Method]> {
    const timeoutMs = options?.timeoutMs ?? 0;
    const timeoutSignal =
      timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
    const signals: AbortSignal[] = [];
    if (options?.signal) {
      signals.push(options.signal);
    }
    if (timeoutSignal) {
      signals.push(timeoutSignal);
    }
    const signal =
      signals.length === 0
        ? undefined
        : signals.length === 1
          ? signals[0]
          : AbortSignal.any(signals);

    try {
      return await ctx.request(
        method,
        params,
        signal
          ? { cancellationSignal: signal, stopWaitingOnCancel: true }
          : undefined,
      );
    } catch (error) {
      if (this.processExitError) {
        throw this.processExitError;
      }
      if (timeoutSignal?.aborted) {
        throw new AcpTimeoutError(method, timeoutMs, { cause: error });
      }
      if (signal?.aborted && signal.reason instanceof AcpError) {
        throw signal.reason;
      }
      throw mapRequestError(method, error);
    }
  }

  private requireContext(): acp.ClientContext {
    if (this.disposed) {
      throw new AcpDisposedError();
    }
    if (this.clientState !== "ready" || !this.ctx) {
      throw new AcpNotStartedError();
    }
    return this.ctx;
  }

  private requireReady(): void {
    if (this.disposed) {
      throw new AcpDisposedError();
    }
    if (this.clientState !== "ready" || !this.ctx) {
      throw new AcpNotStartedError();
    }
  }

  private hostContext(
    sessionId: string | undefined,
    signal: AbortSignal,
    method: string,
  ): HostContext {
    return {
      client: this,
      session: sessionId ? this.sessionMap.get(sessionId) : undefined,
      sessionId,
      signal,
      method,
    };
  }

  private toRequestError(error: unknown): acp.RequestError {
    if (error instanceof acp.RequestError) {
      return error;
    }
    return acp.RequestError.internalError(
      error instanceof Error ? error.message : String(error),
    );
  }

  private handleProcessExit(info: ProcessExitInfo): void {
    if (
      this.disposed ||
      this.clientState === "disposing" ||
      this.clientState === "disposed" ||
      this.clientState === "restarting"
    ) {
      return;
    }

    this.lastStderr = info.stderr;
    const error = new AcpProcessExitedError(info.code, info.signal, info.stderr);
    this.processExitError = error;

    if (this.clientState === "starting") {
      try {
        this.connection?.close(error);
      } catch {
        // 连接可能已经关闭。
      }
      return;
    }

    if (this.clientState !== "ready") {
      return;
    }

    try {
      this.connection?.close(error);
    } catch {
      // 连接可能已经关闭。
    }
    this.connection = null;
    this.ctx = null;

    for (const session of this.sessionMap.values()) {
      session.markClosed({ reason: "process-exited", error });
    }
    this.sessionMap.clear();

    this.setClientState("exited");
    this.emitter.emit({
      type: "exit",
      code: info.code,
      signal: info.signal,
      expected: info.expected,
      stderr: info.stderr,
    });
    this.touchClient();
  }

  private handleConnectionClosed(): void {
    if (
      this.disposed ||
      this.clientState === "disposing" ||
      this.clientState === "disposed" ||
      this.clientState === "restarting" ||
      this.clientState === "starting"
    ) {
      return;
    }
    if (this.clientState !== "ready") {
      return;
    }

    const stderr = this.agentProcess?.stderr ?? "";
    void this.agentProcess?.terminate(this.options.timeouts.disposeMs).catch(() => {});
    this.handleProcessExit({
      code: null,
      signal: null,
      expected: false,
      stderr,
    });
  }

  private emitSession(
    action: "created" | "ready" | "closed" | "deleted" | "failed",
    sessionId: string,
  ): void {
    this.emitter.emit({ type: "session", action, sessionId });
    this.touchClient();
  }

  private setClientState(state: ClientState): void {
    if (this.clientState === state) {
      return;
    }
    this.clientState = state;
    this.emitter.emit({ type: "state", state });
    this.touchClient();
  }

  private touchClient(): void {
    this.clientRevision += 1;
    this.clientSnapshotCache = null;
  }
}

function normalizeOptions(options: AcpClientOptions): NormalizedOptions {
  if (!options.command) {
    throw new AcpInvalidArgumentError("command must not be empty");
  }
  validateHost(options.host);

  return {
    command: options.command,
    args: options.args ?? [],
    cwd: resolveProcessCwd(options.cwd),
    env: mergeEnv(process.env, options.env),
    clientInfo: options.clientInfo ?? {
      name: "acp-client-sdk",
      version: "0.1.0",
    },
    ...(options.host ? { host: options.host } : {}),
    timeouts: {
      spawnMs: options.timeouts?.spawnMs ?? 10_000,
      initializeMs: options.timeouts?.initializeMs ?? 30_000,
      disposeMs: options.timeouts?.disposeMs ?? 5_000,
    },
    maxStderrBytes: options.maxStderrBytes ?? 64 * 1024,
    maxPendingUpdates: options.maxPendingUpdates ?? 1024,
    maxPendingUpdateBytes: options.maxPendingUpdateBytes ?? 16 * 1024 * 1024,
    ...(options.maxMessageBytes !== undefined
      ? { maxMessageBytes: options.maxMessageBytes }
      : {}),
    logger: options.logger ?? {},
    ...(options.initializeMeta ? { initializeMeta: options.initializeMeta } : {}),
    ...(options.capabilitiesMeta
      ? { capabilitiesMeta: options.capabilitiesMeta }
      : {}),
    unstable: options.experimental?.unstable === true,
  };
}

function normalizeSessionStatus(status: string): SessionStatus {
  return status === "open" ? "open" : "saved";
}

function normalizeSessionOptions(response: {
  modes?: SessionModeState | null;
  configOptions?: SessionConfigOption[] | null;
}): SessionOptionsSnapshot {
  const hasConfigOptions = response.configOptions != null;
  const configOptions = normalizeConfigOptions(response.configOptions);
  const modes = response.modes ?? null;
  return {
    hasConfigOptions,
    configOptions,
    modes,
    mode: deriveMode(hasConfigOptions, configOptions, modes),
    model: deriveModel(hasConfigOptions, configOptions),
  };
}
