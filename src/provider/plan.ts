import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import type { PlanEntry, SessionUpdate } from "@agentclientprotocol/sdk";

/** Plan ID used by the legacy `plan` update, which carries no ID. */
const LEGACY_PLAN_ID = "default";

/** One plan as it stands after the latest update in a turn. */
export type PlanSnapshot =
  | { readonly planId: string; readonly type: "items"; readonly entries: readonly PlanEntry[] }
  | { readonly planId: string; readonly type: "markdown"; readonly content: string; readonly path?: string }
  | { readonly planId: string; readonly type: "removed" };

/** Converts a plan-related session update; other updates return undefined. */
export function planSnapshot(update: SessionUpdate): PlanSnapshot | undefined {
  switch (update.sessionUpdate) {
    case "plan":
      return { planId: LEGACY_PLAN_ID, type: "items", entries: update.entries };

    case "plan_update": {
      const plan = update.plan;
      if (plan.type === "items") return { planId: plan.planId, type: "items", entries: plan.entries };

      return {
        planId: plan.planId,
        type: "markdown",
        content: plan.content,
        ...(plan.path == null ? {} : { path: plan.path }),
      };
    }

    case "plan_removed":
      return { planId: update.planId, type: "removed" };

    default:
      return undefined;
  }
}

/** Renders one plan as markdown, shared by the live card and history import. */
export function planMarkdown(snapshot: PlanSnapshot): string {
  if (snapshot.type === "removed") return `Plan removed: ${snapshot.planId}`;
  if (snapshot.type === "markdown") return snapshot.content;

  if (snapshot.entries.length === 0) return "（没有计划项）";
  return snapshot.entries.map(entryLine).join("\n");
}

/**
 * Buffers plan updates until the turn ends, then renders one `acp_plan` card
 * per plan.
 *
 * A provider-executed `todowrite` would not reach OpenCode's todo store: that
 * state is written by the internal tool executor, not by provider stream parts.
 * Reusing one tool-call ID across turns would also append duplicate parts. A
 * dedicated card with a fresh ID each turn shows the plan without pretending to
 * own OpenCode's todo state.
 */
export class PlanProjector {
  private readonly plans = new Map<string, PlanSnapshot>();

  /** Records a plan update without interrupting the text stream. */
  update(update: SessionUpdate): void {
    const snapshot = planSnapshot(update);
    if (snapshot !== undefined) this.plans.set(snapshot.planId, snapshot);
  }

  /** Emits one settled card per plan seen during the turn. */
  finish(): LanguageModelV3StreamPart[] {
    const parts: LanguageModelV3StreamPart[] = [];

    for (const snapshot of this.plans.values()) {
      const id = `acp-plan-${safeId(snapshot.planId)}-${crypto.randomUUID()}`;
      const input = JSON.stringify(cardInput(snapshot));

      parts.push(
        { type: "tool-input-start", id, toolName: "acp_plan", providerExecuted: true },
        { type: "tool-input-delta", id, delta: input },
        { type: "tool-input-end", id },
        { type: "tool-call", toolCallId: id, toolName: "acp_plan", input, providerExecuted: true },
        {
          type: "tool-result",
          toolCallId: id,
          toolName: "acp_plan",
          result: { type: "text", value: planMarkdown(snapshot) },
          isError: false,
        },
      );
    }

    this.plans.clear();
    return parts;
  }
}

function entryLine(entry: PlanEntry): string {
  const box = entry.status === "completed" ? "x" : entry.status === "in_progress" ? "-" : " ";
  return `- [${box}] ${entry.content} [${entry.status}, ${entry.priority}]`;
}

function cardInput(snapshot: PlanSnapshot): Record<string, unknown> {
  if (snapshot.type === "items") {
    return { planId: snapshot.planId, type: "items", entries: snapshot.entries };
  }
  if (snapshot.type === "markdown") return { planId: snapshot.planId, type: "markdown", content: snapshot.content };
  return { planId: snapshot.planId, type: "removed" };
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-");
}
