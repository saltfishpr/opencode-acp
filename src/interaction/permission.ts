import type {
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
  ToolCall,
  ToolCallContent,
  ToolCallUpdate,
} from "@agentclientprotocol/sdk";
import type { Plugin } from "@opencode/plugin";
import type { AcpTurnContext } from "../acp/client.js";
import { logInfo, logWarn } from "../log.js";

type Decision = "allow" | "always" | "reject";

/** Replies the native approval card can produce. */
type Reply = "once" | "always" | "reject";

/** How long to wait for the reply event after the assert settles. */
const REPLY_EVENT_TIMEOUT_MS = 3_000;

interface Waiter {
  readonly nonce: string;
  readonly sessionID: string;
  requestID: string | undefined;
  cancelled: boolean;
  readonly asked: Promise<string>;
  readonly replied: Promise<Reply>;
  readonly resolveAsked: (requestID: string) => void;
  readonly resolveReplied: (reply: Reply) => void;
}

interface Target {
  /** OpenCode permission action, namespaced so it cannot collide with built-in tools. */
  readonly action: string;
  /** Concrete values the agent is asking about. */
  readonly resources: string[];
  /** Patterns saved when the user chooses "always"; omitted when a resource is not literal. */
  readonly save: string[];
}

/**
 * Turns ACP `session/request_permission` into OpenCode's native approval card.
 *
 * The ACP agent only knows its own session ID, so the client attaches the
 * OpenCode session and working directory to each running turn. A request first
 * adds a session-local `ask` rule for its action, because an unmatched action
 * inherits OpenCode's allow-all default. When the user chooses "always" the
 * server saves the `save` patterns; later identical requests resolve through
 * that saved rule without showing the card again.
 *
 * A `metadata.acpRequest` nonce correlates the assert with the
 * `permission.asked` / `permission.replied` events. Without it the promise
 * could tell whether the request was allowed, but not whether the user chose
 * "once" or "always", and ACP has no other way to distinguish the two.
 */
export class PermissionBroker {
  private readonly waiters = new Map<string, Waiter>();
  private readonly ensured = new Map<string, Set<string>>();
  private readonly stop = new AbortController();

  constructor(private readonly ctx: Plugin.Context) {
    void this.watch();
  }

  /** Answers one ACP permission request and returns the option the agent should apply. */
  async request(params: RequestPermissionRequest, turn: AcpTurnContext): Promise<RequestPermissionResponse> {
    const target = targetOf(params.toolCall, turn.cwd);
    logInfo("acp", `approval requested for ${target.action}: ${target.resources.join(", ")}`);

    try {
      await this.ensureAsk(turn.sessionID, target.action);
    } catch (error) {
      logWarn("acp", `could not add an ask rule for ${target.action}: ${message(error)}`);
      return cancelled();
    }

    const nonce = crypto.randomUUID();
    const asked = deferred<string>();
    const replied = deferred<Reply>();
    const waiter: Waiter = {
      nonce,
      sessionID: turn.sessionID,
      requestID: undefined,
      cancelled: false,
      asked: asked.promise,
      replied: replied.promise,
      resolveAsked: asked.resolve,
      resolveReplied: replied.resolve,
    };

    this.waiters.set(nonce, waiter);

    const input = {
      sessionID: turn.sessionID,
      action: target.action,
      resources: target.resources,
      save: target.save.length > 0 ? target.save : undefined,
      metadata: {
        acpRequest: nonce,
        tool: params.toolCall.title ?? params.toolCall.toolCallId,
        kind: params.toolCall.kind ?? undefined,
      },
    };

    const settled = Promise.resolve()
      .then(() => this.ctx.permission.assert(input))
      .then(
        () => ({ allowed: true as const }),
        (error: unknown) => ({ allowed: false as const, error }),
      );

    const aborted = deferred<void>();
    const onAbort = () => aborted.resolve();
    turn.signal.addEventListener("abort", onAbort, { once: true });
    if (turn.signal.aborted) onAbort();

    try {
      const first = await Promise.race([
        waiter.asked.then((requestID) => ({ kind: "asked" as const, requestID })),
        settled.then((result) => ({ kind: "settled" as const, result })),
        aborted.promise.then(() => ({ kind: "aborted" as const })),
      ]);

      if (first.kind === "aborted") {
        logInfo("acp", "approval cancelled because the turn ended before a decision");
        this.cancelWaiter(waiter);
        return cancelled();
      }

      if (first.kind === "settled") {
        logInfo("acp", `approval ${first.result.allowed ? "allowed" : "rejected"} without waiting for a card reply`);
        return first.result.allowed ? option(params, "allow") : option(params, "reject");
      }

      // The card is on screen. The reply event is published just before the
      // assert settles, but it can reach this plugin a moment later.
      const reply = await Promise.race([
        waiter.replied,
        aborted.promise.then(() => "cancelled" as const),
        pause(REPLY_EVENT_TIMEOUT_MS).then(() => "timeout" as const),
      ]);

      if (reply === "cancelled") {
        this.cancelWaiter(waiter);
        return cancelled();
      }

      // The reply may have timed out, but the user can still interrupt while
      // the card is open. Never wait for the assert without watching the turn.
      const result = await Promise.race([settled, aborted.promise.then(() => "cancelled" as const)]);

      if (result === "cancelled") {
        this.cancelWaiter(waiter);
        return cancelled();
      }

      if (!result.allowed) return option(params, "reject");
      if (reply === "always") return option(params, "always");
      return option(params, "allow");
    } finally {
      turn.signal.removeEventListener("abort", onAbort);
      if (!waiter.cancelled || waiter.requestID !== undefined) this.waiters.delete(nonce);
    }
  }

  /** Stops listening for permission events. */
  close(): void {
    this.stop.abort();
  }

  /**
   * Adds one `ask` rule per action to the session. The rule is broad because
   * the action namespace belongs to remote ACP tools; resources stay concrete
   * so "always" only saves the values the user actually approved.
   */
  private async ensureAsk(sessionID: string, action: string): Promise<void> {
    let actions = this.ensured.get(sessionID);
    if (actions?.has(action) === true) return;

    const session = await this.ctx.session.get({ sessionID });
    const rules = session.permissions ?? [];
    const exists = rules.some((rule) => rule.action === action && rule.resource === "*" && rule.effect === "ask");

    if (!exists) {
      await this.ctx.session.update({
        sessionID,
        permissions: [...rules, { action, resource: "*", effect: "ask" }],
      });
    }

    if (actions === undefined) {
      actions = new Set();
      this.ensured.set(sessionID, actions);
    }
    actions.add(action);
  }

  private async watch(): Promise<void> {
    try {
      const events = this.ctx.event.subscribe({
        types: ["permission.asked", "permission.replied"],
        signal: this.stop.signal,
      });

      for await (const event of events) {
        if (event.type === "permission.asked") {
          const nonce = event.data.metadata?.["acpRequest"];
          if (typeof nonce !== "string") continue;

          const waiter = this.waiters.get(nonce);
          if (waiter === undefined) continue;

          waiter.requestID = event.data.id;
          if (waiter.cancelled) {
            void this.reject(waiter);
            this.waiters.delete(nonce);
          } else {
            waiter.resolveAsked(event.data.id);
          }
          continue;
        }

        if (event.type === "permission.replied") {
          logInfo("acp", `approval reply: ${event.data.reply}`);
          for (const [nonce, waiter] of this.waiters) {
            if (waiter.requestID !== event.data.requestID) continue;
            waiter.resolveReplied(event.data.reply);
            this.waiters.delete(nonce);
            break;
          }
        }
      }
    } catch (error) {
      if (!this.stop.signal.aborted) {
        console.warn(`[acp] permission event stream stopped: ${message(error)}`);
      }
    }
  }

  private cancelWaiter(waiter: Waiter): void {
    waiter.cancelled = true;

    if (waiter.requestID !== undefined) {
      void this.reject(waiter);
      return;
    }

    // The assert may not have created the card yet. Keep the waiter until the
    // ask arrives so the request does not stay pending after the turn ends.
    void waiter.asked.then(() => this.reject(waiter));
    // The event stream can be down or the ask event can be missed; look the
    // request up directly so an interrupt still clears the native card.
    void this.rejectByLookup(waiter);
    setTimeout(() => this.waiters.delete(waiter.nonce), 5_000);
  }

  private async rejectByLookup(waiter: Waiter): Promise<void> {
    for (const delay of [0, 250, 1_000]) {
      if (delay > 0) await pause(delay);
      if (waiter.requestID !== undefined) return;

      try {
        const requests = await this.ctx.permission.list({ sessionID: waiter.sessionID });
        const request = requests.find((item) => item.metadata?.["acpRequest"] === waiter.nonce);
        if (request === undefined) continue;

        waiter.requestID = request.id;
        await this.reject(waiter);
        return;
      } catch {
        return;
      }
    }
  }

  private async reject(waiter: Waiter): Promise<void> {
    if (waiter.requestID === undefined) return;

    try {
      await this.ctx.permission.reply({
        sessionID: waiter.sessionID,
        requestID: waiter.requestID,
        decision: "reject",
      });
    } catch {
      // The request was already answered or the session went away.
    }
  }
}

/** Maps one ACP tool call to the action and resources shown in the native card. */
export function targetOf(tool: ToolCall | ToolCallUpdate, cwd: string): Target {
  const kind = tool.kind ?? "other";
  const raw = asRecord(tool.rawInput);
  const paths = [...(tool.locations ?? []).map((item) => item.path), ...diffs(tool.content).map((item) => item.path)];
  const path = relative(
    cwd,
    paths[0] ?? pickString(raw, ["path", "file", "filepath", "filename"]) ?? tool.title ?? tool.toolCallId,
  );
  const name = toolName(kind, tool.name);

  if (kind === "execute") {
    const command = pickString(raw, ["commandline", "command", "cmd"]) ?? tool.title ?? tool.toolCallId;
    return { action: "acp.bash", resources: [command], save: saveOf([command]) };
  }

  if (kind === "edit") {
    const files = [...new Set(paths.map((item) => relative(cwd, item)))];
    const resources = files.length > 0 ? files : [path];
    return { action: `acp.${name}`, resources, save: saveOf(resources) };
  }

  if (kind === "read") {
    return { action: `acp.${name}`, resources: [path], save: saveOf([path]) };
  }

  if (kind === "search") {
    const pattern = pickString(raw, ["query", "pattern", "regex", "glob", "search"]) ?? tool.title ?? tool.toolCallId;
    return { action: `acp.${name}`, resources: [pattern], save: saveOf([pattern]) };
  }

  if (kind === "fetch") {
    const url = pickString(raw, ["url", "uri"]) ?? tool.title ?? tool.toolCallId;
    return { action: "acp.webfetch", resources: [url], save: saveOf([url]) };
  }

  const resource = tool.title ?? pickString(raw, ["path", "command", "url"]) ?? tool.toolCallId;
  return { action: `acp.${name}`, resources: [resource], save: saveOf([resource]) };
}

/** Chooses the ACP option that matches the user's decision. */
export function option(params: RequestPermissionRequest, decision: Decision): RequestPermissionResponse {
  if (decision === "reject") {
    const reject =
      find(params.options, "reject_once") ??
      find(params.options, "reject_always") ??
      byName(params.options, /reject|deny|decline|no/i);
    return reject === undefined ? cancelled() : selected(reject);
  }

  if (decision === "always") {
    const always =
      find(params.options, "allow_always") ??
      find(params.options, "allow_once") ??
      byName(params.options, /allow|approve|accept|yes/i);
    return always === undefined ? cancelled() : selected(always);
  }

  const once =
    find(params.options, "allow_once") ??
    find(params.options, "allow_always") ??
    byName(params.options, /allow|approve|accept|yes/i);
  return once === undefined ? cancelled() : selected(once);
}

function find(options: readonly PermissionOption[], kind: string): PermissionOption | undefined {
  return options.find((item) => (item.kind as string) === kind);
}

function byName(options: readonly PermissionOption[], pattern: RegExp): PermissionOption | undefined {
  return options.find((item) => pattern.test(`${item.kind} ${item.name}`));
}

function selected(option: PermissionOption): RequestPermissionResponse {
  return { outcome: { outcome: "selected", optionId: option.optionId } };
}

function cancelled(): RequestPermissionResponse {
  return { outcome: { outcome: "cancelled" } };
}

/** Literal values only: a resource containing a wildcard would widen the saved rule. */
function saveOf(resources: string[]): string[] {
  return resources.filter((item) => item.length > 0 && !/[*?]/.test(item));
}

function toolName(kind: string, name: string | null | undefined): string {
  if (kind === "execute") return "bash";
  if (kind === "edit") return "edit";
  if (kind === "read") return /list|dir|tree/i.test(name ?? "") ? "list" : "read";
  if (kind === "search") return /glob|files/i.test(name ?? "") ? "glob" : "grep";
  if (kind === "fetch") return "webfetch";
  return slug(name ?? kind) || "other";
}

function diffs(content: ToolCallContent[] | null | undefined): Array<{ path: string }> {
  return (content ?? []).flatMap((item) => (item.type === "diff" ? [{ path: item.path }] : []));
}

function relative(cwd: string, path: string): string {
  const prefix = cwd.endsWith("/") ? cwd : `${cwd}/`;
  return path.startsWith(prefix) ? path.slice(prefix.length) : path;
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

function pickString(raw: Record<string, unknown> | undefined, keys: readonly string[]): string | undefined {
  if (raw === undefined) return undefined;

  for (const [key, value] of Object.entries(raw)) {
    if (!keys.includes(key.toLowerCase())) continue;
    if (typeof value === "string" && value.length > 0) return value;
  }

  return undefined;
}

function deferred<T>(): { promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
