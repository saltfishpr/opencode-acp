import type {
  CompactionSummaryChunk,
  CompactionUpdate,
  ContentBlock,
  CurrentModeUpdate,
  SessionConfigOption,
  SessionMessage,
  SessionMessageChunk,
  SessionUpdate,
  ToolCall,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";

import { normalizeConfigOptions } from "./config.js";
import type {
  CompactionState,
  MessageState,
  MessageRole,
  SessionMessageState,
  SessionState,
  ToolCallState,
} from "./state.js";

function hasOwn(object: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function messageKey(role: MessageRole, messageId: string): string {
  return `${role}\u0000${messageId}`;
}

function appendContent(message: MessageState, content: ContentBlock): void {
  message.content.push(content);
  if (content.type === "text") {
    message.textParts.push(content.text);
  }
}

function applyContentChunk(
  state: SessionState,
  update: { content: ContentBlock; messageId?: string | null },
  role: MessageRole,
): void {
  const messageId = update.messageId ?? null;
  const text = update.content.type === "text" ? update.content.text : null;

  if (role === "user" && state.pendingUserMessage) {
    const pending = state.pendingUserMessage;

    if (state.pendingUserReplacement) {
      pending.content = [update.content];
      pending.textParts = text === null ? [] : [text];
      pending.id = messageId;
      pending.optimistic = false;
      state.pendingUserReplacement = false;
      state.lastMessageByRole.set("user", pending);
      if (messageId) {
        state.messageById.set(messageKey("user", messageId), pending);
      }
      return;
    }

    appendContent(pending, update.content);
    if (messageId && pending.id === null) {
      pending.id = messageId;
      state.messageById.set(messageKey("user", messageId), pending);
    }
    state.lastMessageByRole.set("user", pending);
    return;
  }

  let message: MessageState | undefined;
  if (messageId) {
    const key = messageKey(role, messageId);
    message = state.messageById.get(key);
    if (!message) {
      message = {
        id: messageId,
        role,
        content: [],
        textParts: [],
        optimistic: false,
      };
      state.messageById.set(key, message);
      state.messages.push(message);
    }
  } else {
    message = state.lastMessageByRole.get(role);
    if (!message) {
      message = {
        id: null,
        role,
        content: [],
        textParts: [],
        optimistic: false,
      };
      state.messages.push(message);
    }
  }

  appendContent(message, update.content);
  state.lastMessageByRole.set(role, message);
}

function findOrCreateToolCall(
  state: SessionState,
  toolCallId: string,
): ToolCallState {
  let toolCall = state.toolCallById.get(toolCallId);
  if (!toolCall) {
    toolCall = {
      toolCallId,
      title: null,
      name: null,
      kind: null,
      status: null,
      content: [],
      locations: [],
    };
    state.toolCallById.set(toolCallId, toolCall);
    state.toolCalls.push(toolCall);
  }
  return toolCall;
}

function applyToolCall(state: SessionState, update: ToolCall): void {
  const toolCall = findOrCreateToolCall(state, update.toolCallId);
  toolCall.title = update.title;
  toolCall.name = update.name ?? null;
  toolCall.kind = update.kind ?? null;
  toolCall.status = update.status ?? null;
  toolCall.content = update.content ? [...update.content] : [];
  toolCall.locations = update.locations ? [...update.locations] : [];
  if (update.rawInput !== undefined) {
    toolCall.rawInput = update.rawInput;
  }
  if (update.rawOutput !== undefined) {
    toolCall.rawOutput = update.rawOutput;
  }
}

function applyToolCallUpdate(state: SessionState, update: ToolCallUpdate): void {
  const toolCall = findOrCreateToolCall(state, update.toolCallId);

  if (update.kind !== undefined) {
    toolCall.kind = update.kind;
  }
  if (update.status !== undefined) {
    toolCall.status = update.status;
  }
  if (update.title !== undefined) {
    toolCall.title = update.title;
  }
  if (update.name !== undefined) {
    toolCall.name = update.name;
  }
  if (hasOwn(update, "content")) {
    toolCall.content = update.content ? [...update.content] : [];
  }
  if (hasOwn(update, "locations")) {
    toolCall.locations = update.locations ? [...update.locations] : [];
  }
  if (hasOwn(update, "rawInput")) {
    toolCall.rawInput = update.rawInput;
  }
  if (hasOwn(update, "rawOutput")) {
    toolCall.rawOutput = update.rawOutput;
  }
}

function applyConfigOptions(
  state: SessionState,
  configOptions: readonly SessionConfigOption[],
): void {
  state.hasConfigOptions = true;
  state.configOptions = normalizeConfigOptions(configOptions);
}

function applyCurrentMode(state: SessionState, update: CurrentModeUpdate): void {
  if (state.modes) {
    state.modes = {
      ...state.modes,
      currentModeId: update.currentModeId,
    };
  }
}

function applyCompactionUpdate(state: SessionState, update: CompactionUpdate): void {
  let compaction = state.compactions.get(update.compactionId);
  if (!compaction) {
    compaction = {
      compactionId: update.compactionId,
      status: update.status,
      summary: null,
      error: null,
    };
    state.compactions.set(update.compactionId, compaction);
  }

  compaction.status = update.status;

  if (hasOwn(update, "summary")) {
    compaction.summary =
      update.summary == null || update.summary.length === 0
        ? null
        : [...update.summary];
  }

  if (hasOwn(update, "error")) {
    compaction.error = update.error ?? null;
  }
}

function applyCompactionSummaryChunk(
  state: SessionState,
  update: CompactionSummaryChunk,
): void {
  let compaction: CompactionState | undefined = state.compactions.get(
    update.compactionId,
  );
  if (!compaction) {
    compaction = {
      compactionId: update.compactionId,
      status: "in_progress",
      summary: [],
      error: null,
    };
    state.compactions.set(update.compactionId, compaction);
  }
  if (compaction.summary === null) {
    compaction.summary = [];
  }
  compaction.summary.push(update.content);
}

function applySessionMessage(state: SessionState, update: SessionMessage): void {
  let message: SessionMessageState | undefined = state.sessionMessages.get(
    update.messageId,
  );
  if (!message) {
    message = {
      messageId: update.messageId,
      senderSessionId: null,
      recipientSessionId: null,
      senderMessageId: null,
      recipientMessageId: null,
      content: [],
    };
    state.sessionMessages.set(update.messageId, message);
  }

  if (hasOwn(update, "senderSessionId")) {
    message.senderSessionId = update.senderSessionId ?? null;
  }
  if (hasOwn(update, "recipientSessionId")) {
    message.recipientSessionId = update.recipientSessionId ?? null;
  }
  if (hasOwn(update, "senderMessageId")) {
    message.senderMessageId = update.senderMessageId ?? null;
  }
  if (hasOwn(update, "recipientMessageId")) {
    message.recipientMessageId = update.recipientMessageId ?? null;
  }
  if (hasOwn(update, "content")) {
    message.content =
      update.content == null || update.content.length === 0
        ? []
        : [...update.content];
  }
}

function applySessionMessageChunk(
  state: SessionState,
  update: SessionMessageChunk,
): void {
  let message: SessionMessageState | undefined = state.sessionMessages.get(
    update.messageId,
  );
  if (!message) {
    message = {
      messageId: update.messageId,
      senderSessionId: null,
      recipientSessionId: null,
      senderMessageId: null,
      recipientMessageId: null,
      content: [],
    };
    state.sessionMessages.set(update.messageId, message);
  }
  message.content.push(update.content);
}

export function applyUpdateToState(state: SessionState, update: SessionUpdate): void {
  switch (update.sessionUpdate) {
    case "user_message_chunk":
      applyContentChunk(state, update, "user");
      break;
    case "agent_message_chunk":
      applyContentChunk(state, update, "assistant");
      break;
    case "agent_thought_chunk":
      applyContentChunk(state, update, "thought");
      break;
    case "tool_call":
      applyToolCall(state, update);
      break;
    case "tool_call_update":
      applyToolCallUpdate(state, update);
      break;
    case "plan":
      state.plan = { entries: [...update.entries] };
      break;
    case "plan_update": {
      const plan = update.plan;
      if (plan.type === "items") {
        state.plans.set(plan.planId, {
          planId: plan.planId,
          type: "items",
          entries: [...plan.entries],
        });
      } else if (plan.type === "markdown") {
        state.plans.set(plan.planId, {
          planId: plan.planId,
          type: "markdown",
          content: plan.content,
          path: plan.path ?? null,
        });
      }
      break;
    }
    case "plan_removed":
      state.plans.delete(update.planId);
      break;
    case "available_commands_update":
      state.availableCommands = [...update.availableCommands];
      break;
    case "current_mode_update":
      applyCurrentMode(state, update);
      break;
    case "config_option_update":
      applyConfigOptions(state, update.configOptions);
      break;
    case "session_info_update":
      if (hasOwn(update, "title")) {
        state.title = update.title ?? null;
      }
      if (hasOwn(update, "updatedAt")) {
        state.updatedAt = update.updatedAt ?? null;
      }
      break;
    case "usage_update":
      state.usage = {
        used: update.used,
        size: update.size,
        cost: update.cost ?? null,
        ...(update._meta ? { _meta: update._meta } : {}),
      };
      break;
    case "compaction_update":
      applyCompactionUpdate(state, update);
      break;
    case "compaction_summary_chunk":
      applyCompactionSummaryChunk(state, update);
      break;
    case "session_message":
      applySessionMessage(state, update);
      break;
    case "session_message_chunk":
      applySessionMessageChunk(state, update);
      break;
    case "subagent_update":
    case "notice":
      // subagent 更新由 AcpClient 创建子会话，notice 由宿主回调处理。
      break;
    default:
      break;
  }
}
