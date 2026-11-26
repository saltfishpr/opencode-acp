import type {
  JSONValue,
  LanguageModelV3StreamPart,
  LanguageModelV3ToolResultOutput,
  SharedV3ProviderMetadata,
} from "@ai-sdk/provider";
import type {
  ToolCall,
  ToolCallContent,
  ToolCallLocation,
  ToolCallStatus,
  ToolCallUpdate,
  ToolKind,
} from "@agentclientprotocol/sdk";

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
    if (update.locations !== undefined && update.locations !== null) existing.locations = update.locations;
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
      parts.push({ type: "tool-input-delta", id: item.id, delta: input, providerMetadata: metadata });
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
      result: result.output,
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

function resultOf(state: CallState): { output: LanguageModelV3ToolResultOutput; isError: boolean } {
  const texts = state.content.flatMap((item) =>
    item.type === "content" && item.content.type === "text" ? [item.content.text] : [],
  );
  const terminals = state.content.flatMap((item) => (item.type === "terminal" ? [item.terminalId] : []));
  const changed = diffs(state.content).map((item) => item.path);
  const raw = asRecord(state.rawOutput);
  const failed = state.status === "failed";

  const lines = [...texts];
  if (terminals.length > 0) lines.push(terminals.map((id) => `terminal ${id}`).join("\n"));
  if (lines.length === 0 && changed.length > 0) lines.push(changed.map((path) => `Updated ${path}`).join("\n"));
  if (lines.length === 0 && typeof raw?.["output"] === "string") lines.push(raw["output"]);

  if (lines.length > 0) {
    return { output: { type: failed ? "error-text" : "text", value: lines.join("\n\n") }, isError: failed };
  }

  if (state.rawOutput !== undefined && state.rawOutput !== null) {
    return {
      output: { type: failed ? "error-json" : "json", value: state.rawOutput as JSONValue },
      isError: failed,
    };
  }

  return {
    output: { type: failed ? "error-text" : "text", value: failed ? state.title : "completed" },
    isError: failed,
  };
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
