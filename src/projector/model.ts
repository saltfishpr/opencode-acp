import type {
  JSONValue,
  LanguageModelV3FinishReason,
  LanguageModelV3StreamPart,
  LanguageModelV3ToolResultOutput,
  LanguageModelV3Usage,
  SharedV3ProviderMetadata,
} from "@ai-sdk/provider";
import type {
  CompactionSummaryChunk,
  CompactionUpdate,
  ContentBlock,
  Notice,
  PlanEntry,
  PromptResponse,
  SessionUpdate,
  ToolCall,
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
  ToolCallUpdate,
  ToolKind,
  UsageUpdate,
} from "@agentclientprotocol/sdk";
import {
  AcpAuthRequiredError,
  AcpCancelledError,
  AcpDisposedError,
  AcpError,
  AcpInitializeTimeoutError,
  AcpInvalidArgumentError,
  AcpInvalidHostError,
  AcpNotStartedError,
  AcpPendingUpdatesOverflowError,
  AcpProcessExitedError,
  AcpProtocolError,
  AcpProtocolVersionError,
  AcpReadOnlySessionError,
  AcpRequestError,
  AcpSessionBusyError,
  AcpSessionNotFoundError,
  AcpSpawnError,
  AcpTerminalAuthError,
  AcpTimeoutError,
  AcpUnknownConfigOptionError,
  AcpUnstableFeatureError,
  AcpUnsupportedCapabilityError,
  AcpUnsupportedContentError,
} from "../acp/index.js";

/** Plan ID used by the legacy `plan` update, which carries no ID. */
const LEGACY_PLAN_ID = "default";

/** One ACP tool call as it moves through its lifecycle. */
interface CallState {
  readonly id: string;
  title: string;
  kind: ToolKind | undefined;
  name: string | undefined;
  status: ToolCallStatus;
  content: ToolCallContent[];
  locations: ToolCallLocation[];
  rawInput: unknown;
  rawOutput: unknown;
  /** Tool-call IDs sent to OpenCode; more than one when a diff touches several files. */
  emitted: Array<{ id: string; name: string }>;
  reported: boolean;
  hidden: boolean;
}

export interface ToolProjectorOptions {
  /** Session working directory, used to make absolute ACP paths relative. */
  readonly cwd: string;
}

/**
 * Projects ACP `tool_call` and `tool_call_update` notifications onto AI SDK
 * stream parts.
 *
 * Every call gets `providerExecuted: true`, so OpenCode renders the card and
 * leaves execution to the remote agent. A call is emitted once its input is
 * usable; an `edit` waits for the diff content that carries the old text. Each
 * emitted call receives a `tool-result` before the turn ends, so no card is
 * left spinning.
 */
export class ToolProjector {
  private readonly calls = new Map<string, CallState>();
  private readonly cwd: string;

  constructor(options: ToolProjectorOptions) {
    this.cwd = options.cwd;
  }

  /** Returns the stream parts for one ACP tool notification. */
  update(update: ToolCall | ToolCallUpdate): LanguageModelV3StreamPart[] {
    const state = this.merge(update);
    if (state.hidden) return [];

    const parts: LanguageModelV3StreamPart[] = [];

    if (state.emitted.length === 0 && this.ready(state)) parts.push(...this.emitCall(state));
    if (state.emitted.length > 0 && !state.reported && isFinished(state.status)) {
      parts.push(...this.emitResult(state));
    }

    return parts;
  }

  /**
   * Emits missing calls and results, and marks unfinished calls failed, so an
   * interrupted or crashed turn leaves neither running cards nor false
   * successes.
   */
  finish(): LanguageModelV3StreamPart[] {
    const parts: LanguageModelV3StreamPart[] = [];

    for (const state of this.calls.values()) {
      if (state.hidden) continue;
      // A turn that ended while a tool was still running did not complete it.
      if (!isFinished(state.status)) state.status = "failed";
      if (state.emitted.length === 0) parts.push(...this.emitCall(state));
      if (!state.reported) parts.push(...this.emitResult(state));
    }

    return parts;
  }

  private merge(update: ToolCall | ToolCallUpdate): CallState {
    const id = update.toolCallId;
    const existing = this.calls.get(id);

    if (existing === undefined) {
      const state: CallState = {
        id,
        title: update.title ?? id,
        kind: update.kind ?? undefined,
        name: update.name ?? undefined,
        status: update.status ?? "pending",
        content: update.content ?? [],
        locations: update.locations ?? [],
        rawInput: update.rawInput,
        rawOutput: update.rawOutput,
        emitted: [],
        reported: false,
        hidden: isHidden(update.kind ?? undefined),
      };

      this.calls.set(id, state);
      return state;
    }

    if (update.title !== undefined && update.title !== null) existing.title = update.title;
    if (update.kind !== undefined && update.kind !== null) existing.kind = update.kind;
    if (update.name !== undefined && update.name !== null) existing.name = update.name;
    if (update.status !== undefined && update.status !== null) existing.status = update.status;
    if (update.content !== undefined && update.content !== null) existing.content = update.content;
    if (update.locations !== undefined && update.locations !== null) {
      existing.locations = update.locations;
    }
    if (update.rawInput !== undefined) existing.rawInput = update.rawInput;
    if (update.rawOutput !== undefined) existing.rawOutput = update.rawOutput;
    if (isHidden(existing.kind)) existing.hidden = true;

    return existing;
  }

  private ready(state: CallState): boolean {
    if (state.kind !== "edit") return true;
    if (diffs(state.content).length > 0) return true;
    return isFinished(state.status);
  }

  private emitCall(state: CallState): LanguageModelV3StreamPart[] {
    const projected = this.project(state);
    state.emitted = projected.map((item) => ({ id: item.id, name: item.name }));

    const parts: LanguageModelV3StreamPart[] = [];
    const metadata = this.metadata(state);

    for (const item of projected) {
      const input = JSON.stringify(item.input);
      parts.push({
        type: "tool-input-start",
        id: item.id,
        toolName: item.name,
        providerExecuted: true,
        providerMetadata: metadata,
      });
      parts.push({
        type: "tool-input-delta",
        id: item.id,
        delta: input,
        providerMetadata: metadata,
      });
      parts.push({ type: "tool-input-end", id: item.id, providerMetadata: metadata });
      parts.push({
        type: "tool-call",
        toolCallId: item.id,
        toolName: item.name,
        input,
        providerExecuted: true,
        providerMetadata: metadata,
      });
    }

    return parts;
  }

  private emitResult(state: CallState): LanguageModelV3StreamPart[] {
    const result = resultOf(state);
    const metadata = this.metadata(state);
    state.reported = true;

    return state.emitted.map((item) => ({
      type: "tool-result" as const,
      toolCallId: item.id,
      toolName: item.name,
      result: result.result,
      isError: result.isError,
      providerMetadata: metadata,
    }));
  }

  private project(state: CallState): Array<{ id: string; name: string; input: Record<string, unknown> }> {
    const raw = asRecord(state.rawInput);
    const kind = state.kind ?? "other";
    const path = this.pathOf(state, raw);

    if (kind === "edit") {
      const items = diffs(state.content);

      if (items.length > 0) {
        return items.map((diff, index) => {
          const id = index === 0 ? state.id : `${state.id}-${index}`;
          const file = relative(this.cwd, diff.path);

          return diff.oldText === undefined || diff.oldText === null
            ? { id, name: "write", input: { path: file, content: diff.newText } }
            : { id, name: "edit", input: { path: file, oldString: diff.oldText, newString: diff.newText } };
        });
      }

      const content = pickString(raw, ["content", "newtext", "text"]);
      if (content !== undefined) return [{ id: state.id, name: "write", input: { path, content } }];

      return [{ id: state.id, name: "acp_edit", input: raw ?? { path, title: state.title } }];
    }

    switch (kind) {
      case "execute":
        return [
          {
            id: state.id,
            name: "bash",
            input: {
              command: pickString(raw, ["commandline", "command", "cmd"]) ?? state.title,
              description: pickString(raw, ["toolsummary", "description"]) ?? state.title,
            },
          },
        ];

      case "read":
        return [
          {
            id: state.id,
            name: isListTool(state.name) ? "list" : "read",
            input: { path },
          },
        ];

      case "search":
        return [
          {
            id: state.id,
            name: isGlobTool(state.name) ? "glob" : "grep",
            input: {
              pattern: pickString(raw, ["query", "pattern", "regex", "glob", "search"]) ?? state.title,
              path: pickString(raw, ["path", "dir", "directory"]),
              include: pickString(raw, ["include", "filter"]),
            },
          },
        ];

      case "fetch":
        return [
          {
            id: state.id,
            name: "webfetch",
            input: { url: pickString(raw, ["url", "uri"]) ?? state.title },
          },
        ];

      default:
        return [
          {
            id: state.id,
            name: `acp_${slug(state.name ?? kind)}`,
            input: raw ?? { title: state.title },
          },
        ];
    }
  }

  private pathOf(state: CallState, raw: Record<string, unknown> | undefined): string {
    const absolute =
      state.locations[0]?.path ?? pickString(raw, ["path", "file", "filepath", "filename"]) ?? state.title;
    return relative(this.cwd, absolute);
  }

  /**
   * OpenCode 2.4.1 drops provider metadata on stream parts, so these details
   * never reach `part.native`. They stay attached for cores that keep them.
   */
  private metadata(state: CallState): SharedV3ProviderMetadata {
    const acp: Record<string, JSONValue> = {
      toolCallId: state.id,
      title: state.title,
      status: state.status,
    };

    if (state.kind !== undefined) acp["kind"] = state.kind;
    if (state.name !== undefined) acp["name"] = state.name;
    if (state.locations.length > 0) acp["locations"] = state.locations as unknown as JSONValue;
    if (state.rawInput !== undefined) acp["rawInput"] = state.rawInput as JSONValue;
    if (state.rawOutput !== undefined) acp["rawOutput"] = state.rawOutput as JSONValue;

    return { acp };
  }
}

function isFinished(status: ToolCallStatus): boolean {
  return status === "completed" || status === "failed";
}

/** Thought and mode switches are not tools the timeline should show. */
function isHidden(kind: ToolKind | undefined): boolean {
  return kind === "think" || kind === "switch_mode";
}

function diffs(content: ToolCallContent[]): Array<{ path: string; oldText?: string | null; newText: string }> {
  return content.flatMap((item) => (item.type === "diff" ? [item] : []));
}

function resultOf(state: CallState): {
  result: LanguageModelV3ToolResultOutput | string;
  isError: boolean;
} {
  const texts = state.content.flatMap((item) =>
    item.type === "content" && item.content.type === "text" ? [item.content.text] : [],
  );
  const terminals = state.content.flatMap((item) => (item.type === "terminal" ? [item.terminalId] : []));
  const changed = diffs(state.content).map((item) => item.path);
  const raw = asRecord(state.rawOutput);

  const lines = texts.filter((text) => text.trim().length > 0);
  if (terminals.length > 0) lines.push(terminals.map((id) => `terminal ${id}`).join("\n"));
  if (lines.length === 0 && changed.length > 0) {
    lines.push(changed.map((path) => `Updated ${path}`).join("\n"));
  }
  if (lines.length === 0 && typeof raw?.["output"] === "string" && raw["output"].trim().length > 0) {
    lines.push(raw["output"]);
  }

  // OpenCode turns a failed provider-executed result into `error.message` by
  // serializing it. A plain string stays readable; an output object shows up
  // as raw JSON in the tool card.
  if (state.status === "failed") {
    return {
      result: lines.join("\n\n").trim() || "工具未执行：审批被拒绝或已取消。",
      isError: true,
    };
  }

  if (lines.length > 0) return { result: { type: "text", value: lines.join("\n\n") }, isError: false };
  if (state.rawOutput !== undefined && state.rawOutput !== null) {
    return { result: { type: "json", value: state.rawOutput as JSONValue }, isError: false };
  }

  return { result: { type: "text", value: "completed" }, isError: false };
}

function relative(cwd: string, path: string): string {
  const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
}

function isListTool(name: string | undefined): boolean {
  return /list|dir|tree/i.test(name ?? "");
}

function isGlobTool(name: string | undefined): boolean {
  return /glob|files/i.test(name ?? "");
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/** ACP agents name their raw input keys freely; agy uses `Path`, `CommandLine`. */
function pickString(raw: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
  if (raw === undefined) return undefined;

  for (const [key, value] of Object.entries(raw)) {
    if (!keys.includes(key.toLowerCase())) continue;
    if (typeof value === "string" && value.length > 0) return value;
  }

  return undefined;
}

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
      state = {
        status: "in_progress",
        summary: "",
        error: undefined,
        emitted: false,
        reported: false,
      };
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

/** One plan as it stands after the latest update in a turn. */
export type PlanSnapshot =
  | { readonly planId: string; readonly type: "items"; readonly entries: readonly PlanEntry[] }
  | {
      readonly planId: string;
      readonly type: "markdown";
      readonly content: string;
      readonly path?: string;
    }
  | { readonly planId: string; readonly type: "removed" };

/** Converts a plan-related session update; other updates return undefined. */
export function planSnapshot(update: SessionUpdate): PlanSnapshot | undefined {
  switch (update.sessionUpdate) {
    case "plan":
      return { planId: LEGACY_PLAN_ID, type: "items", entries: update.entries };

    case "plan_update": {
      const plan = update.plan;
      if (plan.type === "items") {
        return { planId: plan.planId, type: "items", entries: plan.entries };
      }

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
  if (snapshot.type === "markdown") {
    return { planId: snapshot.planId, type: "markdown", content: snapshot.content };
  }
  return { planId: snapshot.planId, type: "removed" };
}

function safeId(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]+/g, "-");
}

export const EMPTY_USAGE: LanguageModelV3Usage = {
  inputTokens: {
    total: undefined,
    noCache: undefined,
    cacheRead: undefined,
    cacheWrite: undefined,
  },
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

/** Stop reasons OpenCode does not model uniformly map to `other`. */
export function finishReasonOf(reason: string): LanguageModelV3FinishReason {
  if (reason === "end_turn") return { unified: "stop", raw: reason };
  if (reason === "max_tokens") return { unified: "length", raw: reason };
  return { unified: "other", raw: reason };
}

const STDERR_TAIL = 800;

/**
 * Turns an ACP client error into a short Chinese explanation.
 *
 * Callers log the raw error separately; this string is what the assistant text
 * shows, so it names the next action where one exists. A stderr tail is only
 * appended for failures where the agent process wrote something useful.
 */
export function explainAcpError(error: unknown, stderr?: string): string {
  const message = explain(error);
  const tail = nonEmpty(stderr);
  return tail === undefined ? message : `${message}\n\nagent stderr：\n${truncateTail(tail)}`;
}

function explain(error: unknown): string {
  if (error instanceof AcpSpawnError) {
    const detail = error.cause instanceof Error ? error.cause.message : String(error.cause ?? error.message);
    return `无法启动 ACP agent（命令 ${error.command}，目录 ${error.cwd}）：${detail}`;
  }
  if (error instanceof AcpAuthRequiredError) {
    return "远端 agent 尚未登录或没有可用凭据。请先在终端运行一次该 CLI 完成登录，或在插件配置里补充凭据";
  }
  if (error instanceof AcpInitializeTimeoutError) {
    return `ACP 初始化超时（${error.timeoutMs} ms）：agent 未在限定时间内完成握手`;
  }
  if (error instanceof AcpTimeoutError) {
    return `ACP 请求 ${error.method} 超时（${error.timeoutMs} ms）`;
  }
  if (error instanceof AcpProcessExitedError) {
    const status =
      error.exitCode !== null
        ? `退出码 ${error.exitCode}`
        : error.signal !== null
          ? `信号 ${error.signal}`
          : "状态未知";
    return `ACP agent 进程已退出（${status}），请重试；下一轮会重新启动`;
  }
  if (error instanceof AcpSessionNotFoundError) {
    return `ACP 会话不存在或已失效（${error.sessionId}），下一轮会新建会话`;
  }
  if (error instanceof AcpSessionBusyError) {
    return `ACP 会话正忙：${error.message}`;
  }
  if (error instanceof AcpUnsupportedCapabilityError) {
    return `该 agent 不支持 ${error.capability}`;
  }
  if (error instanceof AcpUnsupportedContentError) {
    return `该 agent 不支持 ${error.contentType} 内容（需要 ${error.capability}）`;
  }
  if (error instanceof AcpCancelledError) {
    return "ACP 请求已取消";
  }
  if (error instanceof AcpDisposedError) {
    return "ACP 客户端已关闭，请重新选择模型后重试";
  }
  if (error instanceof AcpNotStartedError) {
    return "ACP agent 尚未启动，请重试";
  }
  if (error instanceof AcpProtocolVersionError) {
    return `agent 选择的 ACP 协议版本 ${error.received} 不受支持（客户端支持 ${error.supported}）`;
  }
  if (error instanceof AcpProtocolError) {
    return `ACP 协议错误：${error.message}`;
  }
  if (error instanceof AcpRequestError) {
    if (error.rpcCode === -32000) {
      return `远端 agent 尚未登录或没有可用凭据（${error.message}）。请先在终端运行一次该 CLI 完成登录`;
    }
    if (error.rpcCode === -32002) {
      return `远端 ACP 会话不存在或已失效（${error.message}），下一轮会新建会话`;
    }
    if (error.rpcCode === -32800) return "ACP 请求已取消";
    return `ACP 请求 ${error.method} 失败：${error.message}（错误码 ${error.rpcCode}）`;
  }
  if (error instanceof AcpInvalidArgumentError || error instanceof AcpInvalidHostError) {
    return `ACP 调用参数无效：${error.message}`;
  }
  if (error instanceof AcpUnknownConfigOptionError) {
    return `agent 不支持所选配置项（${error.configId}），请重新选择模型或选项`;
  }
  if (error instanceof AcpTerminalAuthError) {
    return `ACP 终端登录失败（方法 ${error.methodId}），请在终端完成登录后重试`;
  }
  if (error instanceof AcpReadOnlySessionError) {
    return "该 ACP 子会话是只读的，不能执行此操作";
  }
  if (error instanceof AcpPendingUpdatesOverflowError) {
    return "ACP agent 在会话建立前发送了过多更新，请重试";
  }
  if (error instanceof AcpUnstableFeatureError) {
    return `该 agent 未启用的实验能力：${error.message}`;
  }
  if (error instanceof AcpError) return error.message;
  if (error instanceof Error) return error.message;
  return String(error);
}

function truncateTail(text: string, max = STDERR_TAIL): string {
  const value = text.trim();
  return value.length <= max ? value : `…${value.slice(value.length - max)}`;
}
