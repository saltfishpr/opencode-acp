import type {
  ContentBlock,
  Diff,
  SessionReference,
  Terminal,
  ToolCallContent,
} from "@agentclientprotocol/sdk";

import type {
  ClientSnapshot,
  CompactionSnapshot,
  MessageSnapshot,
  PlanSnapshot,
  SessionMessageSnapshot,
  SessionSnapshot,
  SubagentSnapshot,
  ToolCallSnapshot,
} from "../types/public.js";
import { deriveMode, deriveModel } from "./config.js";
import type { SessionState, SubagentMeta } from "./state.js";

function copyContent(content: readonly ContentBlock[]): ContentBlock[] {
  return [...content];
}

function toolCallDiffs(content: readonly ToolCallContent[]): Diff[] {
  return content
    .filter((item): item is Diff & { type: "diff" } => item.type === "diff")
    .map((item) => ({
      path: item.path,
      oldText: item.oldText ?? null,
      newText: item.newText,
      ...(item._meta ? { _meta: item._meta } : {}),
    }));
}

function toolCallTerminals(content: readonly ToolCallContent[]): Terminal[] {
  return content
    .filter((item): item is Terminal & { type: "terminal" } => item.type === "terminal")
    .map((item) => ({
      terminalId: item.terminalId,
      ...(item._meta ? { _meta: item._meta } : {}),
    }));
}

function toolCallSessions(content: readonly ToolCallContent[]): SessionReference[] {
  return content
    .filter((item): item is SessionReference & { type: "session" } => item.type === "session")
    .map((item) => ({
      sessionId: item.sessionId,
      ...(item._meta ? { _meta: item._meta } : {}),
    }));
}

function subagentSnapshot(
  meta: SubagentMeta,
  parent: SessionState,
): SubagentSnapshot {
  return {
    sessionId: meta.sessionId,
    title: meta.title,
    description: meta.description,
    cwd: meta.reportedCwd ?? parent.effectiveCwd(),
    additionalDirectories:
      meta.reportedAdditionalDirectories ?? parent.effectiveAdditionalDirectories(),
    capabilities: meta.capabilities,
    state: meta.state,
  };
}

function subagentCapabilities(state: SessionState) {
  if (!state.parent) {
    return null;
  }
  return state.parent.subagents.get(state.sessionId)?.capabilities ?? null;
}

export function buildSessionSnapshot(
  state: SessionState,
  clientReady: boolean,
): SessionSnapshot {
  const messages: MessageSnapshot[] = state.messages.map((message) => ({
    id: message.id,
    role: message.role,
    content: copyContent(message.content),
    text: message.textParts.join(""),
    optimistic: message.optimistic,
  }));

  const toolCalls: ToolCallSnapshot[] = state.toolCalls.map((toolCall) => ({
    toolCallId: toolCall.toolCallId,
    title: toolCall.title,
    name: toolCall.name,
    kind: toolCall.kind,
    status: toolCall.status,
    content: [...toolCall.content],
    locations: [...toolCall.locations],
    ...(toolCall.rawInput !== undefined ? { rawInput: toolCall.rawInput } : {}),
    ...(toolCall.rawOutput !== undefined ? { rawOutput: toolCall.rawOutput } : {}),
    diffs: toolCallDiffs(toolCall.content),
    terminals: toolCallTerminals(toolCall.content),
    sessions: toolCallSessions(toolCall.content),
  }));

  const plans: PlanSnapshot[] = [...state.plans.values()].map((plan) =>
    plan.type === "items"
      ? { planId: plan.planId, type: "items", entries: [...plan.entries] }
      : {
          planId: plan.planId,
          type: "markdown",
          content: plan.content,
          path: plan.path,
        },
  );

  const compactions: CompactionSnapshot[] = [...state.compactions.values()].map(
    (compaction) => ({
      compactionId: compaction.compactionId,
      status: compaction.status,
      summary: compaction.summary ? [...compaction.summary] : null,
      error: compaction.error,
    }),
  );

  const subagents: SubagentSnapshot[] = [...state.subagents.values()].map((meta) =>
    subagentSnapshot(meta, state),
  );

  const sessionMessages: SessionMessageSnapshot[] = [
    ...state.sessionMessages.values(),
  ].map((message) => ({
    messageId: message.messageId,
    senderSessionId: message.senderSessionId,
    recipientSessionId: message.recipientSessionId,
    senderMessageId: message.senderMessageId,
    recipientMessageId: message.recipientMessageId,
    content: [...message.content],
  }));

  const canConfigure =
    state.kind === "root" &&
    state.lifecycle === "active" &&
    (state.hasConfigOptions || state.modes !== null);

  return Object.freeze({
    sessionId: state.sessionId,
    parentSessionId: state.parent?.sessionId ?? null,
    kind: state.kind,
    lifecycle: state.lifecycle,
    cwd: state.effectiveCwd(),
    additionalDirectories: state.effectiveAdditionalDirectories(),
    title: state.title,
    updatedAt: state.updatedAt,
    hasConfigOptions: state.hasConfigOptions,
    configOptions: [...state.configOptions],
    modes: state.modes
      ? {
          currentModeId: state.modes.currentModeId,
          availableModes: [...state.modes.availableModes],
        }
      : null,
    mode: deriveMode(state.hasConfigOptions, state.configOptions, state.modes),
    model: deriveModel(state.hasConfigOptions, state.configOptions),
    availableCommands: [...state.availableCommands],
    messages,
    toolCalls,
    plan: state.plan ? { entries: [...state.plan.entries] } : null,
    plans,
    usage: state.usage ? { ...state.usage } : null,
    compactions,
    subagents,
    sessionMessages,
    isPrompting: state.isPrompting,
    agentStatus: state.agentStatus ? { ...state.agentStatus } : null,
    revision: state.revision,
    canPrompt:
      clientReady &&
      state.kind === "root" &&
      state.lifecycle === "active" &&
      !state.isPrompting,
    canCancel:
      state.kind === "root"
        ? state.isPrompting
        : subagentCapabilities(state)?.cancel != null,
    canConfigure,
    canClose: state.kind === "root" && state.lifecycle === "active",
  });
}

export function buildClientSnapshot(input: {
  state: ClientSnapshot["state"];
  agentInfo: ClientSnapshot["agentInfo"];
  agentCapabilities: ClientSnapshot["agentCapabilities"];
  authMethods: ClientSnapshot["authMethods"];
  sessions: readonly SessionState[];
  stderr: string;
  revision: number;
}): ClientSnapshot {
  return Object.freeze({
    state: input.state,
    agentInfo: input.agentInfo,
    agentCapabilities: input.agentCapabilities,
    authMethods: input.authMethods,
    sessions: input.sessions.map((session) => ({
      sessionId: session.sessionId,
      kind: session.kind,
      parentSessionId: session.parent?.sessionId ?? null,
      title: session.title,
      lifecycle: session.lifecycle,
    })),
    stderr: input.stderr,
    revision: input.revision,
  });
}
