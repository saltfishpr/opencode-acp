import type {
  AgentCapabilities,
  AuthMethod,
  AvailableCommand,
  CompleteElicitationNotification,
  ContentBlock,
  CreateElicitationRequest,
  CreateElicitationResponse,
  CreateTerminalRequest,
  CreateTerminalResponse,
  Diff,
  Implementation,
  InitializeResponse,
  KillTerminalRequest,
  KillTerminalResponse,
  McpServer,
  Notice,
  Plan,
  PlanEntry,
  PromptResponse,
  ReadTextFileRequest,
  ReadTextFileResponse,
  ReleaseTerminalRequest,
  ReleaseTerminalResponse,
  RequestPermissionOutcome,
  RequestPermissionRequest,
  SessionConfigOption,
  SessionModeState,
  SessionReference,
  SessionUpdate,
  StateUpdate,
  SubagentSessionCapabilities,
  SystemPrompt,
  Terminal,
  TerminalOutputRequest,
  TerminalOutputResponse,
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
  ToolKind,
  UsageUpdate,
  WaitForTerminalExitRequest,
  WaitForTerminalExitResponse,
  WriteTextFileRequest,
  WriteTextFileResponse,
} from "@agentclientprotocol/sdk";
import type { InitialSessionConfigOption } from "@agentclientprotocol/sdk/unstable";

import type { AcpError } from "../errors.js";
import type { AcpLogger } from "../logger.js";
import type { AcpClient } from "../client/client.js";
import type { AcpSession } from "../session/session.js";

export type MaybePromise<T> = T | Promise<T>;

export type ClientState =
  | "idle"
  | "starting"
  | "ready"
  | "restarting"
  | "disposing"
  | "disposed"
  | "failed"
  | "exited";

export type SessionLifecycle = "loading" | "active" | "closed" | "deleted" | "failed";

export type SessionCloseReason =
  | "closed"
  | "deleted"
  | "disposed"
  | "process-exited"
  | "load-failed"
  | "restarted";

export interface SessionCloseInfo {
  readonly reason: SessionCloseReason;
  readonly error?: AcpError;
}

export type SessionStatus = "open" | "saved";

export interface SessionStatusSnapshot {
  readonly value: SessionStatus;
  /** 客户端最近一次查询的时间，ISO 8601。 */
  readonly checkedAt: string;
}

export interface SessionOptionsQuery {
  readonly cwd: string;
  readonly additionalDirectories?: readonly string[];
  /** 省略/null 表示查询新会话的启动配置。 */
  readonly sessionId?: string | null;
}

export interface SessionOptionsSnapshot {
  readonly hasConfigOptions: boolean;
  readonly configOptions: readonly ConfigOption[];
  readonly modes: SessionModeState | null;
  readonly mode: string | null;
  readonly model: string | null;
}

export interface ConfigSelectOption {
  readonly value: string;
  readonly name: string;
  readonly description: string | null;
  readonly group: { readonly id: string; readonly name: string } | null;
}

export interface ConfigSelectGroup {
  readonly id: string;
  readonly name: string;
  readonly options: readonly ConfigSelectOption[];
}

export type ConfigOption =
  | {
      readonly id: string;
      readonly name: string;
      readonly description: string | null;
      readonly category: string | null;
      readonly type: "select";
      readonly currentValue: string;
      readonly options: readonly ConfigSelectOption[];
      readonly groups: readonly ConfigSelectGroup[] | null;
    }
  | {
      readonly id: string;
      readonly name: string;
      readonly description: string | null;
      readonly category: string | null;
      readonly type: "boolean";
      readonly currentValue: boolean;
    };

export interface MessageSnapshot {
  readonly id: string | null;
  readonly role: "user" | "assistant" | "thought";
  readonly content: readonly ContentBlock[];
  readonly text: string;
  readonly optimistic: boolean;
}

export interface ToolCallSnapshot {
  readonly toolCallId: string;
  readonly title: string | null;
  readonly name: string | null;
  readonly kind: ToolKind | null;
  readonly status: ToolCallStatus | null;
  readonly content: readonly ToolCallContent[];
  readonly locations: readonly ToolCallLocation[];
  readonly rawInput?: unknown;
  readonly rawOutput?: unknown;
  readonly diffs: readonly Diff[];
  readonly terminals: readonly Terminal[];
  readonly sessions: readonly SessionReference[];
}

export type PlanSnapshot =
  | {
      readonly planId: string;
      readonly type: "items";
      readonly entries: readonly PlanEntry[];
    }
  | {
      readonly planId: string;
      readonly type: "markdown";
      readonly content: string;
      readonly path: string | null;
    };

export interface CompactionSnapshot {
  readonly compactionId: string;
  readonly status: string;
  readonly summary: readonly ContentBlock[] | null;
  readonly error: string | null;
}

export interface SubagentSnapshot {
  readonly sessionId: string;
  readonly title: string | null;
  readonly description: string | null;
  readonly cwd: string;
  readonly additionalDirectories: readonly string[];
  readonly capabilities: SubagentSessionCapabilities | null;
  readonly state: StateUpdate | null;
}

export interface SessionMessageSnapshot {
  readonly messageId: string;
  readonly senderSessionId: string | null;
  readonly recipientSessionId: string | null;
  readonly senderMessageId: string | null;
  readonly recipientMessageId: string | null;
  readonly content: readonly ContentBlock[];
}

export interface SessionSnapshot {
  readonly sessionId: string;
  readonly parentSessionId: string | null;
  readonly kind: "root" | "subagent";
  readonly lifecycle: SessionLifecycle;

  readonly cwd: string;
  readonly additionalDirectories: readonly string[];
  readonly title: string | null;
  readonly updatedAt: string | null;

  readonly hasConfigOptions: boolean;
  readonly configOptions: readonly ConfigOption[];
  readonly modes: SessionModeState | null;
  readonly mode: string | null;
  readonly model: string | null;

  readonly availableCommands: readonly AvailableCommand[];
  readonly messages: readonly MessageSnapshot[];
  readonly toolCalls: readonly ToolCallSnapshot[];
  readonly plan: Plan | null;
  readonly plans: readonly PlanSnapshot[];
  readonly usage: UsageUpdate | null;
  readonly compactions: readonly CompactionSnapshot[];
  readonly subagents: readonly SubagentSnapshot[];
  readonly sessionMessages: readonly SessionMessageSnapshot[];

  readonly isPrompting: boolean;
  readonly agentStatus: SessionStatusSnapshot | null;
  readonly revision: number;
  readonly canPrompt: boolean;
  readonly canCancel: boolean;
  readonly canConfigure: boolean;
  readonly canClose: boolean;
}

export interface ClientSnapshot {
  readonly state: ClientState;
  readonly agentInfo: Implementation | null;
  readonly agentCapabilities: AgentCapabilities | null;
  readonly authMethods: readonly AuthMethod[];
  readonly sessions: readonly {
    readonly sessionId: string;
    readonly kind: "root" | "subagent";
    readonly parentSessionId: string | null;
    readonly title: string | null;
    readonly lifecycle: SessionLifecycle;
  }[];
  readonly stderr: string;
  readonly revision: number;
}

export type ClientEvent =
  | { readonly type: "state"; readonly state: ClientState }
  | { readonly type: "initialized"; readonly response: InitializeResponse }
  | { readonly type: "stderr"; readonly chunk: string }
  | {
      readonly type: "exit";
      readonly code: number | null;
      readonly signal: string | null;
      readonly expected: boolean;
      readonly stderr: string;
    }
  | {
      readonly type: "session";
      readonly action: "created" | "ready" | "closed" | "deleted" | "failed";
      readonly sessionId: string;
    }
  | { readonly type: "error"; readonly error: AcpError };

export type SessionEvent =
  | { readonly type: "update"; readonly update: SessionUpdate; readonly revision: number }
  | { readonly type: "prompt-start"; readonly content: readonly ContentBlock[] }
  | { readonly type: "prompt-end"; readonly response: PromptResponse }
  | {
      readonly type: "status";
      readonly status: SessionStatus;
      readonly checkedAt: string;
    }
  | { readonly type: "closed"; readonly info: SessionCloseInfo }
  | { readonly type: "error"; readonly error: AcpError };

export interface HostContext {
  readonly client: AcpClient;
  readonly session: AcpSession | undefined;
  readonly sessionId: string | undefined;
  readonly signal: AbortSignal;
  readonly method: string;
}

export interface TerminalAuthInvocation {
  readonly method: Extract<AuthMethod, { type: "terminal" }>;
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

export interface TerminalAuthResult {
  readonly exitCode: number | null;
  readonly signal?: string | null;
}

export interface AcpHost {
  permission?: (
    request: RequestPermissionRequest,
    ctx: HostContext,
  ) => MaybePromise<RequestPermissionOutcome>;

  fs?: {
    readTextFile?: (
      request: ReadTextFileRequest,
      ctx: HostContext,
    ) => MaybePromise<string | ReadTextFileResponse>;
    writeTextFile?: (
      request: WriteTextFileRequest,
      ctx: HostContext,
    ) => MaybePromise<void | WriteTextFileResponse>;
  };

  terminal?: {
    create: (
      request: CreateTerminalRequest,
      ctx: HostContext,
    ) => MaybePromise<CreateTerminalResponse>;
    output: (
      request: TerminalOutputRequest,
      ctx: HostContext,
    ) => MaybePromise<TerminalOutputResponse>;
    waitForExit: (
      request: WaitForTerminalExitRequest,
      ctx: HostContext,
    ) => MaybePromise<WaitForTerminalExitResponse>;
    kill: (
      request: KillTerminalRequest,
      ctx: HostContext,
    ) => MaybePromise<void | KillTerminalResponse>;
    release: (
      request: ReleaseTerminalRequest,
      ctx: HostContext,
    ) => MaybePromise<void | ReleaseTerminalResponse>;
  };

  elicitation?: {
    create: (
      request: CreateElicitationRequest,
      ctx: HostContext,
    ) => MaybePromise<CreateElicitationResponse>;
    complete?: (notification: CompleteElicitationNotification) => void;
    modes?: readonly ("form" | "url")[];
  };

  terminalAuth?: (
    invocation: TerminalAuthInvocation,
    ctx: HostContext,
  ) => MaybePromise<TerminalAuthResult>;

  notice?: (notice: Notice, ctx: HostContext) => void;
}

export interface AcpClientOptions {
  command: string;
  args?: string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  clientInfo?: Implementation;
  host?: AcpHost;

  timeouts?: {
    spawnMs?: number;
    initializeMs?: number;
    disposeMs?: number;
  };

  maxStderrBytes?: number;
  maxPendingUpdates?: number;
  maxPendingUpdateBytes?: number;
  maxMessageBytes?: number;
  logger?: AcpLogger;

  initializeMeta?: Record<string, unknown>;
  capabilitiesMeta?: Record<string, unknown>;

  experimental?: {
    unstable?: boolean;
  };
}

export interface NewSessionOptions {
  cwd: string;
  mcpServers?: McpServer[];
  additionalDirectories?: string[];
  systemPrompt?: SystemPrompt;
  configOptions?: readonly InitialSessionConfigOption[];
}

export interface LoadSessionOptions extends NewSessionOptions {
  sessionId: string;
}

export interface ResumeSessionOptions extends LoadSessionOptions {}

export interface ListSessionsOptions {
  cwd?: string;
  cursor?: string | null;
}

export type PromptInput = string | ContentBlock | readonly ContentBlock[];

export interface ForkSessionOptions {
  sessionId: string;
  cwd: string;
  additionalDirectories?: string[];
  mcpServers?: McpServer[];
  systemPrompt?: SystemPrompt;
  cursorId?: string | null;
  configOptions?: readonly InitialSessionConfigOption[];
}

export interface ExperimentalApi {
  readonly protocol: "unstable";
  forkSession(options: ForkSessionOptions): Promise<AcpSession>;
  getSessionStatus(sessionId: string): Promise<SessionStatus>;
  getSessionOptions(options: SessionOptionsQuery): Promise<SessionOptionsSnapshot>;
  setSessionTitle(sessionId: string, title: string): Promise<string>;
}

export interface SessionExperimentalApi {
  readonly protocol: "unstable";
  status(): Promise<SessionStatus>;
  getStartupOptions(): Promise<SessionOptionsSnapshot>;
  setTitle(title: string): Promise<string>;
}

export type { SessionConfigOption };
