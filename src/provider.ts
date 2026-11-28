import type {
  CreateElicitationRequest,
  CreateElicitationResponse,
  RequestPermissionOutcome,
  RequestPermissionRequest,
} from "@agentclientprotocol/sdk";
import type {
  LanguageModelV3,
  LanguageModelV3CallOptions,
  LanguageModelV3FinishReason,
  LanguageModelV3GenerateResult,
  LanguageModelV3StreamPart,
  LanguageModelV3Usage,
} from "@ai-sdk/provider";
import { Model, Plugin, Provider } from "@opencode/plugin";
import type { AcpClient, AcpSession, ConfigOption } from "./acp/index.js";
import { selectConfigOption, type AgentHub } from "./agent-hub.js";
import type { TurnContext } from "./interaction/permission.js";
import { logInfo, logWarn } from "./log.js";
import { readAcpMetadata, writeAcpMetadata, type SessionTitles } from "./coordinator.js";
import { buildResourceBlocks, lastUserPrompt, PromptFiles, type ResourceBlocks } from "./projector/media.js";
import { EMPTY_USAGE, explainAcpError } from "./projector/model.js";
import { streamSessionTurn, toStream } from "./projector/stream.js";

/** Provider package id that marks models served by an ACP agent. */
export const PACKAGE = "aisdk:acp";

/** Adapter id accepted from legacy ACP provider packages. */
export const ADAPTER = "acp";

// Keep OpenCode from compacting the remote session before the agent reports its window.
const DEFAULT_CONTEXT_LIMIT = 10_000_000;

/** How long to keep the per-session lock after an interrupt while `session/prompt` settles. */
const CANCEL_TIMEOUT_MS = 5_000;

const OTHER: LanguageModelV3FinishReason = { unified: "other", raw: "other" };

export interface ProviderDeps {
  readonly hub: AgentHub;
  readonly titles: SessionTitles;
  readonly requestPermission: (
    params: RequestPermissionRequest,
    turn: TurnContext,
  ) => Promise<RequestPermissionOutcome>;
  readonly requestElicitation: (
    params: CreateElicitationRequest,
    turn: TurnContext,
  ) => Promise<CreateElicitationResponse>;
}

/** Model and thinking level chosen for one OpenCode turn. */
interface AcpSelection {
  readonly model: string;
  readonly thought?: string;
  readonly defaultThought?: string;
}

interface TurnDeps extends ProviderDeps {
  readonly ctx: Plugin.Context;
  readonly agentID: string;
  readonly promptFiles: PromptFiles;
  readonly firstPrompt: (sessionID: string) => string | undefined;
}

export async function registerProviders(ctx: Plugin.Context, deps: ProviderDeps) {
  const registered = new Set<string>();
  const occupied = new Set<string>();
  const firstPrompts = new Map<string, string>();
  const promptFiles = new PromptFiles();

  const language = (info: Model.Info): LanguageModelV3 | undefined => {
    if (!registered.has(info.providerID)) return undefined;
    const entry = deps.hub.get(info.providerID);
    if (entry === undefined) return undefined;

    const thought = info.settings?.["acpThought"];
    const catalogModel = entry.catalog?.models.find((model) => model.id === info.id);
    return acpLanguageModel(
      {
        model: info.id,
        ...(typeof thought === "string" ? { thought } : {}),
        ...(catalogModel?.defaultThought === undefined ? {} : { defaultThought: catalogModel.defaultThought }),
      },
      {
        ...deps,
        ctx,
        agentID: entry.agent.id,
        promptFiles,
        firstPrompt: (sessionID) => firstPrompts.get(sessionID),
      },
    );
  };

  const registrations = await Promise.all([
    ctx.session.hook("prompt", (event) => {
      const text = event.prompt.text.trim();
      promptFiles.remember(event.sessionID, text, event.prompt.files);
      if (text.length === 0 || firstPrompts.has(event.sessionID)) return;

      firstPrompts.set(event.sessionID, text.slice(0, 60));
      if (firstPrompts.size > 500) {
        const oldest = firstPrompts.keys().next().value;
        if (oldest !== undefined) firstPrompts.delete(oldest);
      }
    }),
    ctx.provider.transform((editor) => {
      registered.clear();
      occupied.clear();
      for (const { provider } of editor.list()) {
        if (provider.package !== PACKAGE) occupied.add(provider.id);
      }

      for (const [agentID, entry] of deps.hub.all()) {
        const id = Provider.ID.make(agentID);
        const existing = editor.get(id);
        if (existing !== undefined && existing.provider.package !== PACKAGE) continue;

        const info = {
          ...Provider.Info.empty(id),
          name: entry.agent.name,
          activation: "enabled" as const,
          package: PACKAGE,
        };
        const limit = entry.contextWindow ?? DEFAULT_CONTEXT_LIMIT;
        const prompt = entry.client?.agentCapabilities?.promptCapabilities;
        const input = [
          "text",
          ...(prompt?.image === true ? ["image"] : []),
          ...(prompt?.audio === true ? ["audio"] : []),
        ];

        const models = (entry.catalog?.models ?? []).map((model) => {
          const defaults = Model.Info.default(id, Model.ID.make(model.id));
          return {
            ...defaults,
            name: model.name,
            limit: { context: limit, output: 32_000 },
            capabilities: { ...defaults.capabilities, input },
            // OpenCode reserves "default" for the agent's own default level.
            variants: model.thoughts.flatMap((thought) =>
              thought.value === "default"
                ? []
                : [
                    {
                      id: Model.VariantID.make(thought.value),
                      settings: { acpThought: thought.value },
                    },
                  ],
            ),
          };
        });

        if (existing === undefined) editor.add({ info, models });
        else {
          editor.update(id, (provider) => {
            provider.name = info.name;
          });
          editor.models.set(id, models);
        }
        registered.add(id);
      }
    }),
    ctx.aisdk.hook("sdk", (event) => {
      if ((event.package !== ADAPTER && event.package !== PACKAGE) || !registered.has(event.model.providerID)) {
        return;
      }
      event.sdk = { languageModel: () => language(event.model) };
    }),
    ctx.aisdk.hook("language", (event) => {
      const model = language(event.model);
      if (model !== undefined) event.language = model;
    }),
    ctx.session.hook("title", (event) => {
      if (event.model === undefined || !registered.has(event.model.providerID)) return;
      const title = deps.titles.get(event.sessionID) ?? firstPrompts.get(event.sessionID);
      if (title !== undefined) event.result = title;
    }),
  ]);

  return { registrations, occupied };
}

function acpLanguageModel(selection: AcpSelection, deps: TurnDeps): LanguageModelV3 {
  return {
    specificationVersion: "v3",
    provider: "acp",
    modelId: selection.model,
    supportedUrls: {},
    async doGenerate(options): Promise<LanguageModelV3GenerateResult> {
      const { controller, dispose } = linkedAbortController(options.abortSignal);
      const parts: LanguageModelV3StreamPart[] = [];
      try {
        for await (const part of run(options, deps, selection, controller)) parts.push(part);
      } finally {
        dispose();
      }

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
      const { controller, dispose } = linkedAbortController(options.abortSignal);
      return {
        stream: toStream(run(options, deps, selection, controller), {
          onCancel: dispose,
          onClose: dispose,
        }),
      };
    },
  };
}

interface TurnHooks {
  /** Registers an additional session lock to release when the turn unwinds. */
  readonly holdLock: (release: () => void) => void;
  /** Reports the in-flight `session/prompt` RPC so the lock can outlast an interrupt. */
  readonly onPrompt: (rpc: Promise<void>) => void;
}

/**
 * Streams one ACP turn. Only the latest user message is forwarded: the ACP
 * session keeps the remote agent's conversation, and OpenCode's history and
 * tool records are not meant for it.
 *
 * The caller owns `controller` so a stream cancel can abort the turn directly.
 */
async function* run(
  options: LanguageModelV3CallOptions,
  deps: TurnDeps,
  selection: AcpSelection,
  controller: AbortController,
): AsyncGenerator<LanguageModelV3StreamPart> {
  if (controller.signal.aborted) return;

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

  let info: Awaited<ReturnType<Plugin.Context["session"]["get"]>>;
  try {
    info = await deps.ctx.session.get({ sessionID });
  } catch (error) {
    logWarn("acp", `could not read the OpenCode session ${sessionID}: ${message(error)}`);
    yield* say("无法读取 OpenCode 会话，ACP 请求未发送。");
    yield finish(OTHER, EMPTY_USAGE);
    return;
  }
  if (controller.signal.aborted) return;

  // Rebuilds lock the ACP session, so turns must use the same key to exclude
  // each other.
  const lockKey = readAcpMetadata(info.metadata, info.location.directory)?.session ?? sessionID;
  const lock = deps.hub.lock(deps.agentID, lockKey);
  if (lock === undefined) {
    yield* say("ACP agent 配置正在更新或已停用，请重新选择可用的模型后重试。");
    yield finish(OTHER, EMPTY_USAGE);
    return;
  }

  const releases = [await lock];
  let promptRpc: Promise<void> | undefined;
  let promptFinished = false;
  try {
    if (controller.signal.aborted) return;
    yield* turn(sessionID, info, content.blocks, content.text, deps, selection, controller, lockKey, {
      holdLock: (release) => releases.push(release),
      onPrompt: (rpc) => {
        promptRpc = rpc;
        void rpc.finally(() => {
          promptFinished = true;
        });
      },
    });
  } finally {
    // Keep the session locks until the cancelled `session/prompt` RPC settles
    // so an immediate follow-up turn waits instead of hitting `isPrompting`.
    releaseWhenSettled(promptRpc, promptFinished, () => {
      for (const release of releases.toReversed()) release();
    });
  }
}

async function* turn(
  sessionID: string,
  info: Awaited<ReturnType<Plugin.Context["session"]["get"]>>,
  blocks: readonly import("@agentclientprotocol/sdk").ContentBlock[],
  text: string,
  deps: TurnDeps,
  selection: AcpSelection,
  controller: AbortController,
  lockKey: string,
  hooks: TurnHooks,
): AsyncGenerator<LanguageModelV3StreamPart> {
  const entry = deps.hub.get(deps.agentID);
  if (entry === undefined) {
    yield* say("ACP agent 已停止，请重新选择模型后重试。");
    yield finish(OTHER, EMPTY_USAGE);
    return;
  }

  const cwd = info.location.directory;
  let client: AcpClient;
  let session: AcpSession;
  let warning: string | undefined;

  try {
    client = await deps.hub.ensureClient(deps.agentID);
    const resolved = await resolveSession(client, sessionID, cwd, info.metadata, deps);
    session = resolved.session;
    warning = resolved.warning;
  } catch (error) {
    logWarn("acp", message(error));
    yield* say(`ACP 连接失败：${explainAcpError(error, entry.client?.stderr)}`);
    yield finish(OTHER, EMPTY_USAGE);
    return;
  }
  if (controller.signal.aborted) return;

  // On a new session's first turn, `run()` locked on `sessionID` before the ACP
  // session existed; also lock on `session.sessionId` so a follow-up turn or
  // rebuild waits if this turn is interrupted before the agent finishes cancelling.
  if (session.sessionId !== lockKey) {
    const sessionLock = deps.hub.lock(deps.agentID, session.sessionId);
    if (sessionLock === undefined) {
      yield* say("ACP agent 配置正在更新或已停用，请重新选择可用的模型后重试。");
      yield finish(OTHER, EMPTY_USAGE);
      return;
    }
    hooks.holdLock(await sessionLock);
    if (controller.signal.aborted) return;
  }

  if (warning !== undefined) yield* say(warning);

  try {
    await applySelection(session, selection);
  } catch (error) {
    logWarn("acp", message(error));
    yield* say(`无法切换到所选 ACP 模型：${explainAcpError(error)}`);
    yield finish(OTHER, EMPTY_USAGE);
    return;
  }
  if (controller.signal.aborted) return;

  const prompt = client.agentCapabilities?.promptCapabilities;
  let content = [...blocks];

  if (prompt?.image !== true) {
    const dropped = content.filter((block) => block.type === "image").length;
    if (dropped > 0) {
      content = content.filter((block) => block.type !== "image");
      yield* say(`该 agent 未声明支持图片输入，已忽略 ${dropped} 张图片。`);
    }
  }

  if (prompt?.audio !== true) {
    const dropped = content.filter((block) => block.type === "audio").length;
    if (dropped > 0) {
      content = content.filter((block) => block.type !== "audio");
      yield* say(`该 agent 未声明支持音频输入，已忽略 ${dropped} 段音频。`);
    }
  }

  const files = deps.promptFiles.get(sessionID, text);
  if (files !== undefined && files.length > 0) {
    let built: ResourceBlocks;
    try {
      built = await buildResourceBlocks(files, {
        cwd,
        embedded: prompt?.embeddedContext === true,
      });
    } catch (error) {
      logWarn("acp", `could not build attachment resources: ${message(error)}`);
      built = { blocks: [], warnings: [] };
    }
    if (controller.signal.aborted) return;
    if (built.blocks.length > 0) content = [...content, ...built.blocks];
    for (const note of built.warnings) yield* say(note);
  }

  if (content.length === 0) {
    yield* say("这条消息没有可发送的内容。");
    yield finish(OTHER, EMPTY_USAGE);
    return;
  }

  const turnContext: TurnContext = {
    sessionID,
    agentName: entry.agent.name,
    cwd,
    signal: controller.signal,
  };
  const unregister = deps.hub.registerTurn(deps.agentID, session.sessionId, {
    turn: turnContext,
    requestPermission: deps.requestPermission,
    requestElicitation: deps.requestElicitation,
  });

  try {
    yield* streamSessionTurn({
      session,
      blocks: content,
      sessionID,
      cwd,
      signal: controller.signal,
      onPrompt: hooks.onPrompt,
      onTitle: (title) => {
        const previous = deps.titles.get(sessionID);
        if (!deps.titles.remember(sessionID, title)) return;
        void applyTitle(deps.ctx, sessionID, title, deps.firstPrompt(sessionID), previous);
      },
      onContextWindow: (size) => deps.hub.noteContextWindow(deps.agentID, size),
    });
  } finally {
    controller.abort();
    unregister();

    const updatedAt = session.getSnapshot().updatedAt ?? new Date().toISOString();
    try {
      await writeAcpMetadata(deps.ctx, sessionID, {
        agent: deps.agentID,
        session: session.sessionId,
        cwd,
        updatedAt,
      });
    } catch (error) {
      logWarn("acp", `could not update the ACP session timestamp: ${message(error)}`);
    }
  }
}

/** Reuses the stored ACP session when possible, otherwise starts a new one. */
async function resolveSession(
  client: AcpClient,
  sessionID: string,
  cwd: string,
  metadata: unknown,
  deps: TurnDeps,
): Promise<{ session: AcpSession; warning?: string }> {
  const stored = readAcpMetadata(metadata, cwd);
  if (stored !== undefined && stored.agent === deps.agentID && stored.cwd === cwd) {
    const existing = client.getSession(stored.session);
    if (existing?.getSnapshot().lifecycle === "active") return { session: existing };

    let failure: unknown;
    let attempted = false;
    const capabilities = client.agentCapabilities;
    if (capabilities?.sessionCapabilities?.resume != null) {
      attempted = true;
      try {
        const session = await client.resumeSession({ sessionId: stored.session, cwd });
        return { session };
      } catch (error) {
        failure = error;
        logWarn("acp", `session/resume failed for ${stored.session}: ${message(error)}`);
      }
    }
    if (capabilities?.loadSession === true) {
      attempted = true;
      try {
        const session = await client.loadSession({ sessionId: stored.session, cwd });
        return { session };
      } catch (error) {
        failure = error;
        logWarn("acp", `session/load failed for ${stored.session}: ${message(error)}`);
      }
    }

    if (failure !== undefined) {
      return {
        session: await createSession(client, sessionID, cwd, deps),
        warning: `未能恢复上一次的 ACP 会话（${explainAcpError(failure)}），已新建会话；之前的上下文不在本轮内。`,
      };
    }
    if (!attempted) {
      return {
        session: await createSession(client, sessionID, cwd, deps),
        warning: "该 agent 不支持恢复会话，已新建会话；之前的上下文不在本轮内。",
      };
    }
  }

  return { session: await createSession(client, sessionID, cwd, deps) };
}

async function createSession(client: AcpClient, sessionID: string, cwd: string, deps: TurnDeps): Promise<AcpSession> {
  const session = await client.newSession({ cwd });
  await writeAcpMetadata(deps.ctx, sessionID, {
    agent: deps.agentID,
    session: session.sessionId,
    cwd,
  });
  return session;
}

/**
 * Pushes the picker's model and thinking level into the ACP session. An absent
 * thinking level falls back to the agent's default for that model.
 */
async function applySelection(session: AcpSession, selection: AcpSelection): Promise<void> {
  const model = selectAcpOption(session, "model");
  if (model !== undefined && model.currentValue !== selection.model) {
    await session.setConfigOption(model.id, selection.model);
    logInfo("acp", `model switched to ${selection.model}`);
  }

  const thought = selection.thought ?? selection.defaultThought;
  if (thought === undefined) return;

  const current = selectAcpOption(session, "thought_level");
  if (current === undefined || current.currentValue === thought) return;
  if (!current.options.some((option) => option.value === thought)) return;

  await session.setConfigOption(current.id, thought);
  logInfo("acp", `thinking level switched to ${thought}`);
}

function selectAcpOption(session: AcpSession, category: string): Extract<ConfigOption, { type: "select" }> | undefined {
  return selectConfigOption(session.getSnapshot().configOptions, category);
}

/** Only an untitled session, the first-prompt fallback, or the previous ACP title may be replaced. */
async function applyTitle(
  ctx: Plugin.Context,
  sessionID: string,
  title: string,
  fallback: string | undefined,
  previous: string | undefined,
): Promise<void> {
  try {
    const session = await ctx.session.get({ sessionID });
    if (session.title !== undefined && session.title !== fallback && session.title !== previous) return;
    await ctx.session.update({ sessionID, title });
  } catch (error) {
    logWarn("acp", `could not apply ACP title: ${message(error)}`);
  }
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

/**
 * Links a controller to `signal` so an abort from either side ends the turn.
 * `dispose()` detaches the listener and aborts the controller; calling it more
 * than once is safe.
 */
function linkedAbortController(signal: AbortSignal | undefined): {
  readonly controller: AbortController;
  readonly dispose: () => void;
} {
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  if (signal === undefined) return { controller, dispose: abort };

  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });

  return {
    controller,
    dispose: () => {
      signal.removeEventListener("abort", abort);
      controller.abort();
    },
  };
}

/**
 * Releases locks after `rpc` settles, or after `CANCEL_TIMEOUT_MS` if the agent
 * never answers the cancelled prompt. Releases synchronously when it already
 * ended, so a follow-up turn never waits on a settle that already happened.
 */
function releaseWhenSettled(rpc: Promise<void> | undefined, finished: boolean, release: () => void): void {
  if (rpc === undefined || finished) {
    release();
    return;
  }

  let released = false;
  const releaseOnce = (): void => {
    if (released) return;
    released = true;
    clearTimeout(timer);
    release();
  };
  const timer = setTimeout(releaseOnce, CANCEL_TIMEOUT_MS);
  timer.unref();
  void rpc.finally(releaseOnce);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
