import type {
  AvailableCommand,
  ContentBlock,
  Plan,
  PlanEntry,
  SessionModeState,
  SessionUpdate,
  StateUpdate,
  SubagentSessionCapabilities,
  UsageUpdate,
} from "@agentclientprotocol/sdk";

import type {
  ConfigOption,
  SessionLifecycle,
  SessionStatusSnapshot,
} from "../types/public.js";
import { normalizeConfigOptions } from "./config.js";

export type MessageRole = "user" | "assistant" | "thought";

export interface MessageState {
  id: string | null;
  role: MessageRole;
  content: ContentBlock[];
  textParts: string[];
  optimistic: boolean;
}

export interface ToolCallState {
  toolCallId: string;
  title: string | null;
  name: string | null;
  kind: import("@agentclientprotocol/sdk").ToolKind | null;
  status: import("@agentclientprotocol/sdk").ToolCallStatus | null;
  content: import("@agentclientprotocol/sdk").ToolCallContent[];
  locations: import("@agentclientprotocol/sdk").ToolCallLocation[];
  rawInput?: unknown;
  rawOutput?: unknown;
}

export type PlanState =
  | { planId: string; type: "items"; entries: PlanEntry[] }
  | { planId: string; type: "markdown"; content: string; path: string | null };

export interface CompactionState {
  compactionId: string;
  status: string;
  summary: ContentBlock[] | null;
  error: string | null;
}

export interface SubagentMeta {
  sessionId: string;
  title: string | null;
  description: string | null;
  reportedCwd: string | null;
  reportedAdditionalDirectories: string[] | null;
  capabilities: SubagentSessionCapabilities | null;
  state: StateUpdate | null;
}

export interface SessionMessageState {
  messageId: string;
  senderSessionId: string | null;
  recipientSessionId: string | null;
  senderMessageId: string | null;
  recipientMessageId: string | null;
  content: ContentBlock[];
}

export interface SessionStateInit {
  sessionId: string;
  kind: "root" | "subagent";
  parent: SessionState | null;
  cwd: string;
  additionalDirectories: string[];
}

export class SessionState {
  readonly sessionId: string;
  readonly kind: "root" | "subagent";
  readonly parent: SessionState | null;
  readonly rootCwd: string;
  readonly rootAdditionalDirectories: string[];

  lifecycle: SessionLifecycle = "active";
  reportedCwd: string | null;
  reportedAdditionalDirectories: string[] | null;

  title: string | null = null;
  updatedAt: string | null = null;

  hasConfigOptions = false;
  configOptions: ConfigOption[] = [];
  modes: SessionModeState | null = null;

  availableCommands: AvailableCommand[] = [];
  messages: MessageState[] = [];
  messageById = new Map<string, MessageState>();
  lastMessageByRole = new Map<MessageRole, MessageState>();

  toolCalls: ToolCallState[] = [];
  toolCallById = new Map<string, ToolCallState>();

  plan: Plan | null = null;
  plans = new Map<string, PlanState>();
  usage: UsageUpdate | null = null;
  compactions = new Map<string, CompactionState>();
  subagents = new Map<string, SubagentMeta>();
  sessionMessages = new Map<string, SessionMessageState>();

  isPrompting = false;
  agentStatus: SessionStatusSnapshot | null = null;
  pendingUserMessage: MessageState | null = null;
  pendingUserReplacement = false;

  loading = false;
  pendingStateUpdates: SessionUpdate[] = [];

  revision = 0;

  constructor(init: SessionStateInit) {
    this.sessionId = init.sessionId;
    this.kind = init.kind;
    this.parent = init.parent;
    this.rootCwd = init.cwd;
    this.rootAdditionalDirectories = [...init.additionalDirectories];
    this.reportedCwd = init.kind === "root" ? init.cwd : null;
    this.reportedAdditionalDirectories =
      init.kind === "root" ? [...init.additionalDirectories] : null;
  }

  touch(): void {
    this.revision += 1;
  }

  beginPrompt(content: readonly ContentBlock[]): void {
    this.isPrompting = true;
    this.lastMessageByRole.clear();

    const blocks = [...content];
    const message: MessageState = {
      id: null,
      role: "user",
      content: blocks,
      textParts: blocks
        .filter((block): block is Extract<ContentBlock, { type: "text" }> => block.type === "text")
        .map((block) => block.text),
      optimistic: true,
    };

    this.messages.push(message);
    this.pendingUserMessage = message;
    this.pendingUserReplacement = true;
    this.lastMessageByRole.set("user", message);
  }

  endPrompt(): void {
    this.isPrompting = false;
    if (this.pendingUserMessage) {
      this.pendingUserMessage.optimistic = false;
    }
    this.pendingUserMessage = null;
    this.pendingUserReplacement = false;
  }

  finishLoading(
    configOptions: readonly import("@agentclientprotocol/sdk").SessionConfigOption[] | null | undefined,
    modes: SessionModeState | null | undefined,
  ): SessionUpdate[] {
    this.hasConfigOptions = configOptions != null;
    this.configOptions = normalizeConfigOptions(configOptions);
    this.modes = modes ?? null;
    this.loading = false;

    const deferred = this.pendingStateUpdates;
    this.pendingStateUpdates = [];
    return deferred;
  }

  effectiveCwd(): string {
    if (this.reportedCwd !== null) {
      return this.reportedCwd;
    }
    if (this.parent) {
      return this.parent.effectiveCwd();
    }
    return this.rootCwd;
  }

  effectiveAdditionalDirectories(): string[] {
    if (this.reportedAdditionalDirectories !== null) {
      return [...this.reportedAdditionalDirectories];
    }
    if (this.parent) {
      return this.parent.effectiveAdditionalDirectories();
    }
    return [...this.rootAdditionalDirectories];
  }
}
