import type { LanguageModelV3FinishReason, LanguageModelV3StreamPart, LanguageModelV3Usage } from "@ai-sdk/provider";
import type { ContentBlock, PromptResponse, SessionUpdate } from "@agentclientprotocol/sdk";
import type { AcpSession } from "../acp/index.js";
import { logWarn } from "../log.js";
import { saveAgentAudio, saveAgentImage } from "./media.js";
import {
  CardProjector,
  EMPTY_USAGE,
  explainAcpError,
  finishReasonOf,
  noteUsageUpdate,
  PlanProjector,
  ToolProjector,
  usageOf,
  type TurnUsage,
} from "./model.js";

/** A reason OpenCode cannot model more precisely than "other". */
export const OTHER: LanguageModelV3FinishReason = { unified: "other", raw: "other" };

/** How often to check whether OpenCode has an interrupt to apply. */
const HEARTBEAT_MS = 400;

const TIMEOUT = Symbol("timeout");

type QueueItem = { readonly done: false; readonly value: SessionUpdate } | { readonly done: true };

/**
 * A single-consumer queue in front of `session.subscribe`.
 *
 * The subscription callback cannot await, and the stream has to keep producing
 * heartbeat parts while the agent is silent, so updates are buffered and pulled
 * with a timeout instead of being yielded directly.
 */
class UpdateQueue {
  private readonly values: SessionUpdate[] = [];
  private readonly waiters: Array<(item: QueueItem) => void> = [];
  private closed = false;

  push(value: SessionUpdate): void {
    if (this.closed) return;
    const waiter = this.waiters.shift();
    if (waiter === undefined) this.values.push(value);
    else waiter({ done: false, value });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const waiter of this.waiters.splice(0)) waiter({ done: true });
  }

  next(timeoutMs: number): Promise<QueueItem | typeof TIMEOUT> {
    const value = this.values.shift();
    if (value !== undefined) return Promise.resolve({ done: false, value });
    if (this.closed) return Promise.resolve({ done: true });

    return new Promise<QueueItem | typeof TIMEOUT>((resolve) => {
      let timer: ReturnType<typeof setTimeout>;
      const waiter = (item: QueueItem): void => {
        clearTimeout(timer);
        resolve(item);
      };
      timer = setTimeout(() => {
        const index = this.waiters.indexOf(waiter);
        if (index >= 0) this.waiters.splice(index, 1);
        resolve(TIMEOUT);
      }, timeoutMs);
      this.waiters.push(waiter);
    });
  }
}

export interface StreamTurnOptions {
  readonly session: AcpSession;
  readonly blocks: readonly ContentBlock[];
  /** OpenCode session ID, used for saved media and titles. */
  readonly sessionID: string;
  /** ACP session working directory, used to make tool paths relative. */
  readonly cwd: string;
  readonly signal?: AbortSignal;
  readonly onTitle?: (title: string) => void;
  /** Called when a turn reports a context window the model catalog did not know. */
  readonly onContextWindow?: (size: number) => void;
  /** Called once `session.prompt()` starts with a promise that settles when the RPC ends. */
  readonly onPrompt?: (settled: Promise<void>) => void;
}

/**
 * Streams one ACP prompt turn as AI SDK stream parts.
 *
 * The session is subscribed before `prompt()` is called, so no update can be
 * lost between the request starting and the first listener attaching. A
 * heartbeat part is emitted whenever the agent is silent for 400 ms; OpenCode
 * applies a user interrupt only while the provider yields, so this keeps the
 * turn interruptible while the agent waits on an approval or a form.
 */
export async function* streamSessionTurn(options: StreamTurnOptions): AsyncGenerator<LanguageModelV3StreamPart> {
  if (options.signal?.aborted) return;

  const queue = new UpdateQueue();
  const unsubscribe = options.session.subscribe((event) => {
    if (event.type === "update") queue.push(event.update);
  });

  let response: PromptResponse | undefined;
  let failure: unknown;
  const promptRpc = options.session
    .prompt([...options.blocks], options.signal === undefined ? undefined : { signal: options.signal })
    .then(
      (value) => {
        response = value;
      },
      (error: unknown) => {
        failure = error;
      },
    )
    .finally(() => {
      queue.close();
    });
  options.onPrompt?.(promptRpc);

  // Close the update queue immediately on abort so a cancelled stream does not
  // wait for the heartbeat timeout or a silent agent before unwinding.
  const onAbort = () => queue.close();
  options.signal?.addEventListener("abort", onAbort, { once: true });
  // `onPrompt` and `prompt()` run above, so the signal can already be aborted here.
  if (options.signal?.aborted) onAbort();

  const tools = new ToolProjector({ cwd: options.cwd });
  const cards = new CardProjector();
  const plans = new PlanProjector();
  const usage: TurnUsage = {};

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

  function* flush(): Generator<LanguageModelV3StreamPart> {
    yield* closeReasoning();
    yield* closeText();
    yield* plans.finish();
    yield* cards.finish();
    yield* tools.finish();
  }

  try {
    for (;;) {
      const item = await queue.next(HEARTBEAT_MS);

      if (item === TIMEOUT) {
        // A no-op part gives OpenCode a chance to apply a user interrupt while
        // the agent is silent, including while it waits on a form or approval.
        yield { type: "raw", rawValue: { acp: "heartbeat" } };
        continue;
      }

      if (item.done) break;

      const update = item.value;

      if (update.sessionUpdate === "agent_message_chunk") {
        if (update.content.type === "image") {
          const saved = await saveAgentImage(options.sessionID, update.content.data, update.content.mimeType);
          yield* say(saved === undefined ? "收到一张图片，但未能保存。" : `图片已保存：${saved}`);
          continue;
        }
        if (update.content.type === "audio") {
          const saved = await saveAgentAudio(options.sessionID, update.content.data, update.content.mimeType);
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
        if (usage.contextWindow !== undefined) options.onContextWindow?.(usage.contextWindow);
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
        const title = update.title?.trim();
        if (title !== undefined && title.length > 0) options.onTitle?.(title);
        continue;
      }

      if (
        update.sessionUpdate === "plan" ||
        update.sessionUpdate === "plan_update" ||
        update.sessionUpdate === "plan_removed"
      ) {
        plans.update(update);
        continue;
      }
    }

    if (failure !== undefined) throw failure;

    const completed = response ?? { stopReason: "cancelled" };
    yield* flush();
    yield finish(finishReasonOf(completed.stopReason), usageOf(completed, usage));
  } catch (error) {
    yield* flush();
    logWarn("acp", error instanceof Error ? error.message : String(error));
    yield* say(`ACP 请求失败：${explainAcpError(error)}`);
    yield finish(OTHER, EMPTY_USAGE);
  } finally {
    options.signal?.removeEventListener("abort", onAbort);
    queue.close();
    unsubscribe();
  }
}

/** Emits one complete text part, used for warnings and terminal errors. */
export async function* say(text: string): AsyncGenerator<LanguageModelV3StreamPart> {
  const id = crypto.randomUUID();
  yield { type: "text-start", id };
  yield { type: "text-delta", id, delta: text };
  yield { type: "text-end", id };
}

export interface StreamOptions {
  /** Called immediately when the consumer cancels the stream, before unwinding the generator. */
  readonly onCancel?: () => void;
  /** Called after the stream ends, errors, or is cancelled. */
  readonly onClose?: () => void;
}

/** Wraps a stream generator as a `ReadableStream` for `doStream`. */
export function toStream(
  iterator: AsyncGenerator<LanguageModelV3StreamPart>,
  options?: StreamOptions,
): ReadableStream<LanguageModelV3StreamPart> {
  let cancelled = false;
  return new ReadableStream({
    async pull(controller) {
      try {
        const next = await iterator.next();
        // `cancel()` can race with an in-flight `pull()`; drop the part it
        // produced instead of enqueueing into a cancelled stream.
        if (cancelled) return;
        if (next.done) {
          options?.onClose?.();
          controller.close();
        } else {
          controller.enqueue(next.value);
        }
      } catch (error) {
        options?.onClose?.();
        throw error;
      }
    },
    async cancel() {
      cancelled = true;
      options?.onCancel?.();
      try {
        await iterator.return(undefined);
      } finally {
        options?.onClose?.();
      }
    },
  });
}

export function finish(reason: LanguageModelV3FinishReason, usage: LanguageModelV3Usage): LanguageModelV3StreamPart {
  return { type: "finish", finishReason: reason, usage };
}
