import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import type { CompactionSummaryChunk, CompactionUpdate, ContentBlock, Notice } from "@agentclientprotocol/sdk";

interface CompactionCard {
  status: string;
  summary: string;
  error: string | undefined;
  emitted: boolean;
  reported: boolean;
}

/**
 * Projects ACP notices and compactions onto provider-executed tool cards.
 *
 * Cards are independent of {@link ToolProjector}: `finish()` only settles the
 * cards this projector created, so a turn that ends mid-compaction shows what
 * it had instead of marking unrelated tool calls failed.
 */
export class CardProjector {
  private readonly compactions = new Map<string, CompactionCard>();

  notice(notice: Notice): LanguageModelV3StreamPart[] {
    const id = `acp-notice-${crypto.randomUUID()}`;
    const description = nonEmpty(notice.description);

    return [
      ...callParts(id, "acp_notice", {
        severity: notice.severity,
        title: notice.title,
        ...(description === undefined ? {} : { description }),
      }),
      resultPart(
        id,
        "acp_notice",
        `[${notice.severity}] ${notice.title}${description === undefined ? "" : `\n\n${description}`}`,
      ),
    ];
  }

  compaction(update: CompactionUpdate | CompactionSummaryChunk): LanguageModelV3StreamPart[] {
    const state = this.compactionState(update.compactionId);
    const parts: LanguageModelV3StreamPart[] = [];

    if ("status" in update) {
      state.status = update.status;
      if (update.summary === null) state.summary = "";
      else if (Array.isArray(update.summary)) state.summary = contentText(update.summary);
      state.error = nonEmpty(update.error);
    } else if (update.content.type === "text") {
      state.summary += update.content.text;
    }

    if (!state.emitted) {
      parts.push(
        ...callParts(toolCallID(update.compactionId), "acp_compaction", {
          id: update.compactionId,
          status: state.status,
        }),
      );
      state.emitted = true;
    }

    if ("status" in update && isTerminal(state.status) && !state.reported) {
      parts.push(this.report(update.compactionId, state));
    }

    return parts;
  }

  /** Settles cards that were still in progress when the turn ended. */
  finish(): LanguageModelV3StreamPart[] {
    const parts: LanguageModelV3StreamPart[] = [];
    for (const [id, state] of this.compactions) {
      if (!state.emitted) {
        parts.push(...callParts(toolCallID(id), "acp_compaction", { id, status: state.status }));
        state.emitted = true;
      }
      if (!state.reported) parts.push(this.report(id, state));
    }
    return parts;
  }

  private compactionState(id: string): CompactionCard {
    let state = this.compactions.get(id);
    if (state === undefined) {
      state = { status: "in_progress", summary: "", error: undefined, emitted: false, reported: false };
      this.compactions.set(id, state);
    }
    return state;
  }

  private report(id: string, state: CompactionCard): LanguageModelV3StreamPart {
    state.reported = true;

    const summary = state.summary.trim();
    const lines = [`状态：${state.status}`];
    if (state.error !== undefined) lines.push(`错误：${state.error}`);
    if (summary.length > 0) lines.push("", summary);

    return resultPart(toolCallID(id), "acp_compaction", lines.join("\n"));
  }
}

function toolCallID(id: string): string {
  return `acp-compaction-${id}`;
}

function callParts(toolCallId: string, toolName: string, input: Record<string, unknown>): LanguageModelV3StreamPart[] {
  const value = JSON.stringify(input);

  return [
    { type: "tool-input-start", id: toolCallId, toolName, providerExecuted: true },
    { type: "tool-input-delta", id: toolCallId, delta: value },
    { type: "tool-input-end", id: toolCallId },
    { type: "tool-call", toolCallId, toolName, input: value, providerExecuted: true },
  ];
}

function resultPart(toolCallId: string, toolName: string, text: string): LanguageModelV3StreamPart {
  return {
    type: "tool-result",
    toolCallId,
    toolName,
    result: { type: "text", value: text },
    isError: false,
  };
}

function isTerminal(status: string): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

function contentText(blocks: readonly ContentBlock[]): string {
  return blocks
    .flatMap((block) => {
      if (block.type === "text") return [block.text];
      if (block.type === "resource" && "text" in block.resource) return [block.resource.text];
      return [];
    })
    .join("\n");
}

function nonEmpty(value: string | null | undefined): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.trim();
  return text.length > 0 ? text : undefined;
}
