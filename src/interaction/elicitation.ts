import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  ElicitationContentValue,
  ElicitationPropertySchema,
  ElicitationSchema,
} from "@agentclientprotocol/sdk";
import type { AcpTurnContext } from "../acp/client.js";
import { logWarn } from "../log.js";
import type { ElicitationField, ElicitationRequestView } from "../rpc.js";

export interface ElicitationEmitter {
  request(view: ElicitationRequestView): void;
  cancelled(requestID: string): void | Promise<void>;
}

/** How long a GUI window has to claim a request before it is declined. */
const CLAIM_TIMEOUT_MS = 2_000;

/** How long a claimed request waits for the user before it is cancelled. */
const ANSWER_TIMEOUT_MS = 10 * 60_000;

interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve: (value: T) => void;
}

interface Pending {
  readonly view: ElicitationRequestView;
  readonly claim: Deferred<boolean>;
  readonly answer: Deferred<Answer>;
  claimed: boolean;
  formID: string | undefined;
}

type Answer = {
  readonly action: "accept" | "cancel" | "decline";
  readonly content?: Record<string, ElicitationContentValue>;
};

/**
 * Turns ACP form elicitations into OpenCode session forms.
 *
 * The plugin API cannot create a form from the server process, so a Desktop
 * GUI window subscribes to `elicitation` events, claims the request and creates
 * the form with `session.form`. Without a window the request is declined after
 * a short claim window; the agent never waits indefinitely.
 */
export class ElicitationBroker {
  private readonly pending = new Map<string, Pending>();
  private emitter: ElicitationEmitter | undefined;

  attach(emitter: ElicitationEmitter): void {
    this.emitter = emitter;
  }

  async request(params: CreateElicitationRequest, turn: AcpTurnContext): Promise<CreateElicitationResponse> {
    if (params.mode !== "form") return { action: "decline" };

    const sessionID = elicitationSession(params);
    if (sessionID === undefined) return { action: "decline" };

    const form = params as { requestedSchema?: ElicitationSchema; toolCallId?: unknown };
    const fields = toFormFields(form.requestedSchema);
    if (fields.length === 0) {
      const properties = form.requestedSchema?.properties;
      const empty = properties === undefined || Object.keys(properties).length === 0;
      return empty ? { action: "accept", content: {} } : { action: "decline" };
    }

    const requestID = crypto.randomUUID();
    const message = params.message.trim();
    const view: ElicitationRequestView = {
      requestID,
      sessionID,
      directory: turn.cwd,
      agentName: turn.agentName,
      title: `${turn.agentName} 请求输入`,
      ...(message.length === 0 ? {} : { message }),
      fields,
      ...(typeof form.toolCallId === "string" && form.toolCallId.length > 0 ? { toolCallID: form.toolCallId } : {}),
    };

    const state: Pending = {
      view,
      claim: deferred<boolean>(),
      answer: deferred<Answer>(),
      claimed: false,
      formID: undefined,
    };

    this.pending.set(requestID, state);
    this.emitter?.request(view);

    const abort = deferred<"abort">();
    const onAbort = () => abort.resolve("abort");
    turn.signal.addEventListener("abort", onAbort, { once: true });
    if (turn.signal.aborted) onAbort();

    try {
      const claimTimeout = timeout(CLAIM_TIMEOUT_MS);
      let claimed: "claimed" | "skipped" | "abort" | "timeout";
      try {
        claimed = await Promise.race([
          state.claim.promise.then((value): "claimed" | "skipped" => (value ? "claimed" : "skipped")),
          abort.promise,
          claimTimeout.promise,
        ]);
      } finally {
        claimTimeout.cancel();
      }

      if (claimed !== "claimed") {
        this.pending.delete(requestID);
        if (claimed === "abort") {
          this.emitter?.cancelled(requestID);
          return { action: "cancel" };
        }
        return { action: "decline" };
      }

      const answerTimeout = timeout(ANSWER_TIMEOUT_MS);
      let answer: Answer | "abort" | "timeout";
      try {
        answer = await Promise.race([state.answer.promise, abort.promise, answerTimeout.promise]);
      } finally {
        answerTimeout.cancel();
      }

      this.pending.delete(requestID);

      if (answer === "abort" || answer === "timeout") {
        this.emitter?.cancelled(requestID);
        return { action: "cancel" };
      }

      return answer.action === "accept"
        ? { action: "accept", content: answer.content ?? {} }
        : { action: answer.action };
    } finally {
      turn.signal.removeEventListener("abort", onAbort);
      this.pending.delete(requestID);
    }
  }

  /** Marks a request as handled by one GUI window; other windows are ignored. */
  claim(requestID: string): boolean {
    const state = this.pending.get(requestID);
    if (state === undefined || state.claimed) return false;

    state.claimed = true;
    state.claim.resolve(true);
    return true;
  }

  answer(requestID: string, action: Answer["action"], content?: Record<string, unknown>): boolean {
    const state = this.pending.get(requestID);
    if (state === undefined || !state.claimed) return false;

    state.answer.resolve({
      action,
      ...(action === "accept" ? { content: fromFormAnswer(content ?? {}) } : {}),
    });
    return true;
  }

  /** Records the form a GUI created so a later cleanup can name it. */
  form(requestID: string, formID: string): boolean {
    const state = this.pending.get(requestID);
    if (state === undefined) return false;
    state.formID = formID;
    return true;
  }

  pendingRequests(): ElicitationRequestView[] {
    return [...this.pending.values()].map((state) => state.view);
  }

  async close(): Promise<void> {
    const requests = [...this.pending.values()];
    this.pending.clear();

    await Promise.all(
      requests.map(async (state) => {
        const notified = this.emitter?.cancelled(state.view.requestID);
        if (!state.claimed) state.claim.resolve(false);
        state.answer.resolve({ action: "cancel" });
        await notified;
      }),
    );
  }
}

/** The session an elicitation belongs to, when it is session-scoped. */
export function elicitationSession(params: CreateElicitationRequest): string | undefined {
  const sessionId = (params as { sessionId?: unknown }).sessionId;
  return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
}

/** Maps an ACP form schema to the fields OpenCode's form API accepts. */
export function toFormFields(schema: ElicitationSchema | null | undefined): ElicitationField[] {
  const properties = schema?.properties;
  if (properties === undefined) return [];

  const required = new Set(schema?.required ?? []);
  const fields: ElicitationField[] = [];
  for (const [key, property] of Object.entries(properties)) {
    const field = toField(key, property, required.has(key));
    if (field === undefined) {
      logWarn("acp", `ignored an unsupported elicitation field: ${key} (${propertyName(property)})`);
      continue;
    }
    fields.push(field);
  }
  return fields;
}

/** Keeps only the values ACP accepts as elicitation content. */
export function fromFormAnswer(answer: Record<string, unknown>): Record<string, ElicitationContentValue> {
  const content: Record<string, ElicitationContentValue> = {};
  for (const [key, value] of Object.entries(answer)) {
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      content[key] = value;
    } else if (Array.isArray(value) && value.every((item) => typeof item === "string")) {
      content[key] = value as string[];
    }
  }
  return content;
}

function toField(key: string, value: ElicitationPropertySchema, required: boolean): ElicitationField | undefined {
  const schema = value as Record<string, unknown>;
  const title = text(schema["title"]);
  const description = text(schema["description"]);
  const base = {
    key,
    ...(title === undefined ? {} : { title }),
    ...(description === undefined ? {} : { description }),
    ...(required ? { required: true } : {}),
  };

  const type = text(schema["type"]);
  if (type === "string") {
    const options = stringOptions(schema);
    const format = formatOf(schema["format"]);
    const defaultValue = text(schema["default"]);
    const pattern = text(schema["pattern"]);
    return {
      ...base,
      type: "string",
      ...(format === undefined ? {} : { format }),
      ...(number(schema["minLength"]) === undefined ? {} : { minLength: number(schema["minLength"])! }),
      ...(number(schema["maxLength"]) === undefined ? {} : { maxLength: number(schema["maxLength"])! }),
      ...(pattern === undefined ? {} : { pattern }),
      ...(defaultValue === undefined ? {} : { default: defaultValue }),
      ...(options.length === 0 ? {} : { options }),
    };
  }

  if (type === "number" || type === "integer") {
    return {
      ...base,
      type,
      ...(number(schema["minimum"]) === undefined ? {} : { minimum: number(schema["minimum"])! }),
      ...(number(schema["maximum"]) === undefined ? {} : { maximum: number(schema["maximum"])! }),
      ...(number(schema["default"]) === undefined ? {} : { default: number(schema["default"])! }),
    };
  }

  if (type === "boolean") {
    return {
      ...base,
      type: "boolean",
      ...(typeof schema["default"] === "boolean" ? { default: schema["default"] } : {}),
    };
  }

  if (type === "array") {
    const options = arrayOptions(schema["items"]);
    if (options.length === 0) return undefined;

    const selected = Array.isArray(schema["default"])
      ? schema["default"].filter((item): item is string => typeof item === "string")
      : undefined;

    return {
      ...base,
      type: "multiselect",
      options,
      ...(number(schema["minItems"]) === undefined ? {} : { minItems: number(schema["minItems"])! }),
      ...(number(schema["maxItems"]) === undefined ? {} : { maxItems: number(schema["maxItems"])! }),
      ...(selected === undefined ? {} : { default: selected }),
    };
  }

  return undefined;
}

function stringOptions(schema: Record<string, unknown>): NonNullable<ElicitationField["options"]> {
  const values = Array.isArray(schema["enum"])
    ? schema["enum"].filter((item): item is string => typeof item === "string")
    : [];
  if (values.length > 0) return values.map((item) => ({ value: item, label: item }));

  return listOptions(schema["oneOf"]);
}

/** Multi-select items are either plain enum values or `anyOf` titled options. */
function arrayOptions(items: unknown): NonNullable<ElicitationField["options"]> {
  if (items === null || typeof items !== "object") return [];

  const schema = items as Record<string, unknown>;
  const values = Array.isArray(schema["enum"])
    ? schema["enum"].filter((item): item is string => typeof item === "string")
    : [];
  if (values.length > 0) return values.map((item) => ({ value: item, label: item }));

  return listOptions(schema["anyOf"]);
}

function listOptions(value: unknown): Array<{ value: string; label: string; description?: string }> {
  if (!Array.isArray(value)) return [];

  const options: Array<{ value: string; label: string; description?: string }> = [];
  for (const item of value) {
    if (item === null || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    const constValue = text(entry["const"]);
    if (constValue === undefined) continue;

    const description = text(entry["description"]);
    options.push({
      value: constValue,
      label: text(entry["title"]) ?? constValue,
      ...(description === undefined ? {} : { description }),
    });
  }
  return options;
}

function propertyName(value: ElicitationPropertySchema): string {
  const type = text((value as Record<string, unknown>)["type"]);
  return type ?? "unknown";
}

function formatOf(value: unknown): ElicitationField["format"] | undefined {
  return value === "email" || value === "uri" || value === "date" || value === "date-time" ? value : undefined;
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function number(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function deferred<T>(): { readonly promise: Promise<T>; resolve: (value: T) => void } {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

function timeout(ms: number): { readonly promise: Promise<"timeout">; cancel(): void } {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const promise = new Promise<"timeout">((resolve) => {
    timer = setTimeout(() => resolve("timeout"), ms);
  });

  return {
    promise,
    cancel() {
      if (timer !== undefined) clearTimeout(timer);
    },
  };
}
