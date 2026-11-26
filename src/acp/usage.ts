import type { LanguageModelV3Usage } from "@ai-sdk/provider";
import type { PromptResponse, UsageUpdate } from "@agentclientprotocol/sdk";

export const EMPTY_USAGE: LanguageModelV3Usage = {
  inputTokens: { total: undefined, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: undefined, text: undefined, reasoning: undefined },
};

/** Antigravity adds token counts to the prompt response; other agents may not. */
interface AcpUsage {
  readonly inputTokens?: number;
  readonly outputTokens?: number;
  readonly thoughtTokens?: number;
  readonly cachedReadTokens?: number;
  readonly cachedWriteTokens?: number;
}

/** Per-turn state collected from `usage_update` notifications. */
export interface TurnUsage {
  contextWindow?: number;
  usedTokens?: number;
  /** Cumulative session cost reported by the agent; never converted into model pricing. */
  reportedCost?: { amount: number; currency: string };
}

export function noteUsageUpdate(state: TurnUsage, update: UsageUpdate): void {
  if (Number.isFinite(update.size) && update.size > 0) state.contextWindow = update.size;
  if (Number.isFinite(update.used) && update.used >= 0) state.usedTokens = update.used;
  if (update.cost !== undefined && update.cost !== null) {
    state.reportedCost = { amount: update.cost.amount, currency: update.cost.currency };
  }
}

/**
 * Maps the agent's accounting onto AI SDK usage.
 *
 * A prompt-response `usage` is per-turn and preferred. When an agent only sends
 * `usage_update`, its `used` value is the best available input-token count:
 * ACP defines it as the tokens currently in context. Cost is not mapped because
 * the agent reports a cumulative session amount, while OpenCode prices tokens
 * from the model catalog.
 */
export function usageOf(response: PromptResponse, turn: TurnUsage): LanguageModelV3Usage {
  const usage = (response as PromptResponse & { usage?: AcpUsage }).usage;
  if (usage === undefined) {
    const total = turn.usedTokens;
    return {
      inputTokens: { total, noCache: total, cacheRead: undefined, cacheWrite: undefined },
      outputTokens: { total: undefined, text: undefined, reasoning: undefined },
    };
  }

  const cacheRead = usage.cachedReadTokens;
  const cacheWrite = usage.cachedWriteTokens;
  // The Antigravity extension counts non-cached input in `inputTokens` and
  // reports cache reads separately, so the AI SDK total includes both.
  const noCache = usage.inputTokens;
  const total = usage.inputTokens === undefined ? undefined : usage.inputTokens + (cacheRead ?? 0) + (cacheWrite ?? 0);
  const text =
    usage.outputTokens === undefined ? undefined : Math.max(0, usage.outputTokens - (usage.thoughtTokens ?? 0));

  return {
    inputTokens: { total, noCache, cacheRead, cacheWrite },
    outputTokens: { total: usage.outputTokens, text, reasoning: usage.thoughtTokens },
  };
}
