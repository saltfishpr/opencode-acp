import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3FinishReason,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";
import type { PromptResponse, SessionUpdate, StopReason } from "@agentclientprotocol/sdk";
import { selectOption } from "../acp/catalog.js";
import type { AcpClient, ElicitationHandler, PermissionHandler } from "../acp/client.js";
import { explain } from "../acp/errors.js";
import type { AgentRuntime } from "../acp/runtime.js";
import { EMPTY_USAGE, noteUsageUpdate, usageOf, type TurnUsage } from "../acp/usage.js";
import { logInfo, logWarn } from "../log.js";
import type { SessionBindings } from "../session/binding.js";
import type { SessionTitles } from "../session/title.js";
import { CardProjector } from "./cards.js";
import { lastUserPrompt, type PromptContent } from "./content.js";
import { saveAgentAudio, saveAgentImage } from "./media.js";
import { ToolProjector } from "./projection.js";

/** Model and thinking level chosen for one OpenCode turn. */
export interface AcpModelSelection {
  /** ACP model value, which is also the OpenCode model ID. */
  readonly model: string;
  /** ACP `thought_level` value from the selected variant. */
  readonly thought?: string;
  /** Thinking level the agent uses for this model when no variant is selected. */
  readonly defaultThought?: string;
}

/** Dependencies an ACP language model needs to run a turn. */
export interface AcpModelDeps {
  readonly runtime: AgentRuntime;
  readonly bindings: SessionBindings;
  /** Working directory of an OpenCode session. */
  readonly directory: (sessionID: string) => Promise<string>;
  /** ACP titles reported for each OpenCode session. */
  readonly titles: SessionTitles;
  readonly requestPermission: PermissionHandler;
  /** Asks the user for structured input the agent needs before continuing. */
  readonly requestElicitation: ElicitationHandler;
  /** Called when a new ACP title arrives, so a title hook that already ran can be corrected. */
  readonly onTitle?: (sessionID: string, title: string, previous: string | undefined) => void;
  /** Called when a turn reports a context window the model catalog did not know. */
  readonly onContextWindow?: (size: number) => void;
}

/**
 * A LanguageModelV3 that forwards each OpenCode turn to one ACP session.
 *
 * `doStream` emits text and reasoning parts and ends with a `finish` part; tool
 * calls and approvals are projected in later milestones. Requests for the same
 * OpenCode session are serialized, and aborting the call sends
 * `session/cancel` to the agent.
 */
export function acpLanguageModel(selection: AcpModelSelection, deps: AcpModelDeps): LanguageModelV3 {
  return {
    specificationVersion: "v3",
    provider: "acp",
    modelId: selection.model,
    supportedUrls: {},
    async doGenerate(options): Promise<LanguageModelV3GenerateResult> {
      const parts: LanguageModelV3StreamPart[] = [];
      for await (const part of run(options, deps, selection)) parts.push(part);

      const text = parts.flatMap((part) => (part.type === "text-delta" ? [part.delta] : []));
      const reasoning = parts.flatMap((part) => (part.type === "reasoning-delta" ? [part.delta] : []));
      const finish = parts.findLast((part) => part.type === "finish");

      return {
        content: [
          ...(text.length > 0 ? [{ type: "text" as const, text: text.join("") }] : []),
          ...(reasoning.length > 0 ? [{ type: "reasoning" as const, text: reasoning.join("") }] : []),
        ],
        finishReason: finish?.finishReason ?? OTHER,
        usage: finish?.usage ?? EMPTY_USAGE,
        warnings: [],
      };
    },
    async doStream(options) {
      return { stream: toStream(run(options, deps, selection)) };
    },
  };
}

const OTHER: LanguageModelV3FinishReason = { unified: "other", raw: "other" };

/**
 * Streams one ACP turn.
 *
 * Only the latest user message is forwarded: the ACP session keeps the remote
 * agent's own conversation, and OpenCode's system instructions, history and
 * tool records are not meant for it.
 */
async function* run(
  options: LanguageModelV3CallOptions,
  deps: AcpModelDeps,
  selection: AcpModelSelection,
): AsyncGenerator<LanguageModelV3StreamPart> {
  const sessionID = sessionIDOf(options);
  const content = lastUserPrompt(options.prompt);

  yield { type: "stream-start", warnings: [] };
  yield { type: "response-metadata", modelId: selection.model };

  if (sessionID === undefined) {
    yield* say("无法确定 OpenCode 会话 ID，ACP 请求未发送。");
    yield finish(OTHER, EMPTY_USAGE);
    return;
  }

  for (const note of content.warnings) yield* say(note);

  if (content.blocks.length === 0) {
    yield* say("这条消息没有可发送的内容。");
    yield finish(OTHER, EMPTY_USAGE);
    return;
  }

  const lock = deps.runtime.lock(sessionID);
  if (lock === undefined) {
    yield* say("ACP agent 配置正在更新或已停用，请重新选择可用的模型后重试。");
    yield finish(OTHER, EMPTY_USAGE);
    return;
  }
  const release = await lock;
  try {
    yield* turn(sessionID, content, options, deps, selection);
  } finally {
    release();
  }
}

async function* turn(
  sessionID: string,
  content: PromptContent,
  options: LanguageModelV3CallOptions,
  deps: AcpModelDeps,
  selection: AcpModelSelection,
): AsyncGenerator<LanguageModelV3StreamPart> {
  let warning: string | undefined;
  let client: AcpClient;
  let acpSessionID: string;
  let cwd: string;

  try {
    cwd = await deps.directory(sessionID);
    const resolved = await resolveSession(sessionID, cwd, deps, (value) => {
      warning = value;
    });
    client = resolved.client;
    acpSessionID = resolved.acpSessionID;
  } catch (error) {
    logWarn("acp", message(error));
    yield* say(`ACP 连接失败：${explain(error, deps.runtime.status.failure)}`);
    yield finish(OTHER, EMPTY_USAGE);
    return;
  }

  if (warning !== undefined) yield* say(warning);

  // A title reported between turns is stored on the client; apply it now so
  // the previous turn's late title is not lost.
  const storedTitle = client.title(acpSessionID);
  if (storedTitle !== undefined) applyTitle(sessionID, storedTitle, deps);

  try {
    await applySelection(client, acpSessionID, selection);
  } catch (error) {
    logWarn("acp", message(error));
    yield* say(`无法切换到所选 ACP 模型：${explain(error, client.failure)}`);
    yield finish(OTHER, EMPTY_USAGE);
    return;
  }

  let blocks = content.blocks;

  if (!client.supportsImages) {
    const dropped = blocks.filter((block) => block.type === "image").length;
    if (dropped > 0) {
      blocks = blocks.filter((block) => block.type !== "image");
      yield* say(`该 agent 未声明支持图片输入，已忽略 ${dropped} 张图片。`);
    }
  }

  if (!client.supportsAudio) {
    const dropped = blocks.filter((block) => block.type === "audio").length;
    if (dropped > 0) {
      blocks = blocks.filter((block) => block.type !== "audio");
      yield* say(`该 agent 未声明支持音频输入，已忽略 ${dropped} 段音频。`);
    }
  }

  if (blocks.length === 0) {
    yield* say("这条消息没有可发送的内容。");
    yield finish(OTHER, EMPTY_USAGE);
    return;
  }

  let textID: string | undefined;
  let textMessageID: string | undefined;
  let reasoningID: string | undefined;
  let reasoningMessageID: string | undefined;

  function* closeText(): Generator<LanguageModelV3StreamPart> {
    if (textID === undefined) return;
    yield { type: "text-end", id: textID };
    textID = undefined;
    textMessageID = undefined;
  }

  function* closeReasoning(): Generator<LanguageModelV3StreamPart> {
    if (reasoningID === undefined) return;
    yield { type: "reasoning-end", id: reasoningID };
    reasoningID = undefined;
    reasoningMessageID = undefined;
  }

  const running = client.prompt(
    acpSessionID,
    blocks,
    { sessionID, cwd, requestPermission: deps.requestPermission, requestElicitation: deps.requestElicitation },
    options.abortSignal,
  );
  const tools = new ToolProjector({ cwd });
  const cards = new CardProjector();
  const usage: TurnUsage = {};
  let response: PromptResponse = { stopReason: "cancelled" };

  try {
    for await (const item of withHeartbeat(running.updates)) {
      if (item === HEARTBEAT) {
        // A no-op part gives OpenCode a chance to apply a user interrupt while
        // the agent is silent, including while it waits on a form or approval.
        yield { type: "raw", rawValue: { acp: "heartbeat" } };
        continue;
      }

      const update = item;

      if (update.sessionUpdate === "agent_message_chunk") {
        if (update.content.type === "image") {
          const saved = await saveAgentImage(sessionID, update.content.data, update.content.mimeType);
          yield* say(saved === undefined ? "收到一张图片，但未能保存。" : `图片已保存：${saved}`);
          continue;
        }
        if (update.content.type === "audio") {
          const saved = await saveAgentAudio(sessionID, update.content.data, update.content.mimeType);
          yield* say(saved === undefined ? "收到一段音频，但未能保存。" : `音频已保存：${saved}`);
          continue;
        }
        if (update.content.type !== "text" || update.content.text.length === 0) continue;

        yield* closeReasoning();

        if (textID === undefined || (update.messageId != null && update.messageId !== textMessageID)) {
          yield* closeText();
          textID = crypto.randomUUID();
          textMessageID = update.messageId ?? undefined;
          yield { type: "text-start", id: textID };
        }

        yield { type: "text-delta", id: textID, delta: update.content.text };
        continue;
      }

      if (update.sessionUpdate === "agent_thought_chunk") {
        if (update.content.type !== "text" || update.content.text.length === 0) continue;

        yield* closeText();

        if (reasoningID === undefined || (update.messageId != null && update.messageId !== reasoningMessageID)) {
          yield* closeReasoning();
          reasoningID = crypto.randomUUID();
          reasoningMessageID = update.messageId ?? undefined;
          yield { type: "reasoning-start", id: reasoningID };
        }

        yield { type: "reasoning-delta", id: reasoningID, delta: update.content.text };
        continue;
      }

      if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
        yield* closeReasoning();
        yield* closeText();

        for (const part of tools.update(update)) yield part;
        continue;
      }

      if (update.sessionUpdate === "usage_update") {
        noteUsageUpdate(usage, update);
        if (usage.contextWindow !== undefined) deps.onContextWindow?.(usage.contextWindow);
        continue;
      }

      if (update.sessionUpdate === "notice") {
        yield* closeReasoning();
        yield* closeText();
        for (const part of cards.notice(update)) yield part;
        continue;
      }

      if (update.sessionUpdate === "compaction_update" || update.sessionUpdate === "compaction_summary_chunk") {
        yield* closeReasoning();
        yield* closeText();
        for (const part of cards.compaction(update)) yield part;
        continue;
      }

      if (update.sessionUpdate === "session_info_update") {
        if (typeof update.title === "string") applyTitle(sessionID, update.title, deps);
        continue;
      }

      // Plans and commands are projected in later milestones.
    }

    if (running.error !== undefined) throw running.error;
    response = running.response ?? response;
  } catch (error) {
    yield* closeReasoning();
    yield* closeText();
    for (const part of cards.finish()) yield part;
    for (const part of tools.finish()) yield part;
    logWarn("acp", message(error));
    yield* say(`ACP 请求失败：${explain(error, client.failure)}`);
    yield finish(OTHER, EMPTY_USAGE);
    return;
  } finally {
    running.dispose();
  }

  yield* closeReasoning();
  yield* closeText();
  for (const part of cards.finish()) yield part;
  for (const part of tools.finish()) yield part;
  yield finish(stopReasonOf(response.stopReason), usageOf(response, usage));
}

/** Sentinel yielded while the agent has not produced an update. */
const HEARTBEAT = Symbol("heartbeat");

/** How often to check whether OpenCode has an interrupt to apply. */
const HEARTBEAT_MS = 400;

/**
 * Wraps the update stream so a silent agent cannot block interruption.
 *
 * OpenCode applies a user interrupt when the provider yields another stream
 * part, so a heartbeat is emitted whenever 400 ms pass without an update. The
 * `raw` part is a no-op for rendering; if it turns out to be persisted into the
 * transcript, raise the interval or emit only after a longer silence.
 */
async function* withHeartbeat(updates: AsyncIterable<SessionUpdate>): AsyncGenerator<SessionUpdate | typeof HEARTBEAT> {
  const iterator = updates[Symbol.asyncIterator]();
  let pending = iterator.next();

  try {
    for (;;) {
      const next = await nextOrTimeout(pending, HEARTBEAT_MS);

      if (next === HEARTBEAT) {
        yield HEARTBEAT;
        continue;
      }

      pending = iterator.next();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    void iterator.return?.();
  }
}

function nextOrTimeout<T>(promise: Promise<T>, ms: number): Promise<T | typeof HEARTBEAT> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => resolve(HEARTBEAT), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** Records a non-empty ACP title and tells the title hook when it replaced another. */
function applyTitle(sessionID: string, title: string, deps: AcpModelDeps): void {
  const value = title.trim();
  if (value.length === 0) return;

  const previous = deps.titles.get(sessionID);
  if (deps.titles.remember(sessionID, value)) deps.onTitle?.(sessionID, value, previous);
}

/**
 * Pushes the picker's model and thinking level into the ACP session.
 *
 * Configuration is session state, so a selection made between messages only
 * reaches the agent when the next turn syncs it. An absent thinking level falls
 * back to the agent's default for that model, which is what OpenCode's
 * "Default" variant means.
 */
async function applySelection(client: AcpClient, sessionId: string, selection: AcpModelSelection): Promise<void> {
  const model = selectOption(client.configOptions(sessionId), "model");
  if (model !== undefined && model.currentValue !== selection.model) {
    await client.setConfigOption(sessionId, model.id, selection.model);
    logInfo("acp", `model switched to ${selection.model}`);
  }

  const thought = selection.thought ?? selection.defaultThought;
  if (thought === undefined) return;

  const current = selectOption(client.configOptions(sessionId), "thought_level");
  if (current === undefined || current.currentValue === thought) return;
  await client.setConfigOption(sessionId, current.id, thought);
  logInfo("acp", `thinking level switched to ${thought}`);
}

/** Reuses the stored ACP session when possible, otherwise starts a new one. */
async function resolveSession(
  sessionID: string,
  cwd: string,
  deps: AcpModelDeps,
  warn: (message: string) => void,
): Promise<{ client: AcpClient; acpSessionID: string }> {
  const agentID = deps.runtime.agent.id;
  const client = await deps.runtime.ensureClient();
  const binding = await deps.bindings.get(agentID, sessionID);

  if (binding !== undefined && binding.cwd === cwd) {
    if (client.hasSession(binding.sessionId)) return { client, acpSessionID: binding.sessionId };

    if (client.canLoadSession) {
      try {
        await client.loadSession(binding.sessionId, cwd);
        return { client, acpSessionID: binding.sessionId };
      } catch (error) {
        logWarn("acp", `session/load failed: ${message(error)}`);
        warn(`未能恢复上一次的 ACP 会话（${explain(error, client.failure)}），已新建会话；之前的上下文不在本轮内。`);
      }
    }
  }

  const acpSessionID = await client.newSession(cwd);
  await deps.bindings.save(agentID, sessionID, { sessionId: acpSessionID, cwd });
  return { client, acpSessionID };
}

async function* say(text: string): AsyncGenerator<LanguageModelV3StreamPart> {
  const id = crypto.randomUUID();
  yield { type: "text-start", id };
  yield { type: "text-delta", id, delta: text };
  yield { type: "text-end", id };
}

function finish(reason: LanguageModelV3FinishReason, usage: LanguageModelV3Usage): LanguageModelV3StreamPart {
  return { type: "finish", finishReason: reason, usage };
}

function stopReasonOf(reason: StopReason): LanguageModelV3FinishReason {
  if (reason === "end_turn") return { unified: "stop", raw: reason };
  if (reason === "max_tokens") return { unified: "length", raw: reason };
  return { unified: "other", raw: reason };
}

function toStream(iterator: AsyncGenerator<LanguageModelV3StreamPart>): ReadableStream<LanguageModelV3StreamPart> {
  return new ReadableStream({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel() {
      await iterator.return(undefined);
    },
  });
}

function sessionIDOf(options: LanguageModelV3CallOptions): string | undefined {
  const header = options.headers?.["x-opencode-session-id"];
  if (typeof header === "string" && header.length > 0) return header;

  for (const value of Object.values(options.providerOptions ?? {})) {
    if (value === null || typeof value !== "object") continue;
    const candidate = (value as Record<string, unknown>)["sessionID"];
    if (typeof candidate === "string" && candidate.length > 0) return candidate;
  }
  return undefined;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
