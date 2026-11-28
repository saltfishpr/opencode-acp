import type {
  PromptResponse,
  SessionConfigOption,
  SessionModeState,
  SessionUpdate,
  SetSessionConfigOptionRequest,
} from "@agentclientprotocol/sdk";

import {
  AcpCancelledError,
  AcpError,
  AcpInvalidArgumentError,
  AcpReadOnlySessionError,
  AcpSessionBusyError,
  AcpUnknownConfigOptionError,
  AcpUnsupportedCapabilityError,
  mapRequestError,
} from "../errors.js";
import { TypedEmitter } from "../events.js";
import { M } from "../methods.js";
import type { AcpClient } from "../client/client.js";
import type {
  ConfigOption,
  PromptInput,
  SessionCloseInfo,
  SessionEvent,
  SessionExperimentalApi,
  SessionSnapshot,
  SessionStatus,
  SessionStatusSnapshot,
} from "../types/public.js";
import { deferred, type Deferred } from "../util.js";
import { findSelectOptionByCategory, normalizeConfigOptions } from "./config.js";
import { normalizePrompt, validatePromptContent } from "./content.js";
import { applyUpdateToState } from "./reducers.js";
import { buildSessionSnapshot } from "./snapshot.js";
import { SessionState } from "./state.js";

interface LoadingResponse {
  configOptions?: SessionConfigOption[] | null;
  modes?: SessionModeState | null;
}

export class AcpSession {
  readonly sessionId: string;
  readonly parentSessionId: string | null;
  readonly kind: "root" | "subagent";

  private readonly emitter: TypedEmitter<SessionEvent>;
  private readonly closedDeferred: Deferred<SessionCloseInfo>;
  private closedResolved = false;
  private snapshotCache: { key: string; snapshot: SessionSnapshot } | null = null;
  readonly closed: Promise<SessionCloseInfo>;
  readonly experimental: SessionExperimentalApi | null;

  /** @internal */
  constructor(
    private readonly client: AcpClient,
    readonly state: SessionState,
  ) {
    this.sessionId = state.sessionId;
    this.parentSessionId = state.parent?.sessionId ?? null;
    this.kind = state.kind;
    this.emitter = new TypedEmitter((error) => this.client.reportListenerError(error));
    this.closedDeferred = deferred<SessionCloseInfo>();
    this.closed = this.closedDeferred.promise;
    this.experimental = this.client.experimental
      ? {
          protocol: "unstable",
          status: () => this.client.getSessionStatusUnstable(this.sessionId),
          getStartupOptions: () =>
            this.client.getSessionOptionsUnstable({
              cwd: this.state.effectiveCwd(),
              additionalDirectories: this.state.effectiveAdditionalDirectories(),
              sessionId: this.sessionId,
            }),
          setTitle: (title) =>
            this.client.setSessionTitleUnstable(this.sessionId, title),
        }
      : null;
  }

  getSnapshot(): SessionSnapshot {
    const key = `${this.state.revision}:${this.client.isReady()}`;
    if (this.snapshotCache?.key === key) {
      return this.snapshotCache.snapshot;
    }
    const snapshot = buildSessionSnapshot(this.state, this.client.isReady());
    this.snapshotCache = { key, snapshot };
    return snapshot;
  }

  subscribe(listener: (event: SessionEvent) => void): () => void {
    return this.emitter.subscribe(listener);
  }

  async prompt(
    input: PromptInput,
    options?: { signal?: AbortSignal },
  ): Promise<PromptResponse> {
    this.assertRoot("prompt");
    if (this.state.lifecycle !== "active") {
      throw new AcpSessionBusyError(
        `Session "${this.sessionId}" is ${this.state.lifecycle}, not active`,
      );
    }
    if (this.state.isPrompting) {
      throw new AcpSessionBusyError(`Session "${this.sessionId}" is already prompting`);
    }
    if (!this.client.isReady()) {
      throw new AcpSessionBusyError("ACP client is not ready");
    }
    if (options?.signal?.aborted) {
      throw new AcpCancelledError();
    }

    const blocks = normalizePrompt(input);
    validatePromptContent(blocks, this.client.agentCapabilities);

    this.state.beginPrompt(blocks);
    this.state.touch();
    this.invalidate();
    this.emitter.emit({ type: "prompt-start", content: [...blocks] });

    const onAbort = (): void => {
      void this.cancel().catch((error) => this.emitError(mapRequestError("session/cancel", error)));
    };
    options?.signal?.addEventListener("abort", onAbort, { once: true });

    try {
      const response = await this.client.requestAgent(M.sessionPrompt, {
        sessionId: this.sessionId,
        prompt: blocks,
      });
      this.state.endPrompt();
      this.state.touch();
      this.invalidate();
      this.emitter.emit({ type: "prompt-end", response });
      return response;
    } catch (error) {
      const mapped = mapRequestError("session/prompt", error);
      this.state.endPrompt();
      this.state.touch();
      this.invalidate();
      this.emitError(mapped);
      throw mapped;
    } finally {
      options?.signal?.removeEventListener("abort", onAbort);
    }
  }

  async cancel(): Promise<void> {
    if (this.kind === "subagent") {
      const capabilities = this.state.parent?.subagents.get(this.sessionId)?.capabilities;
      if (!capabilities?.cancel) {
        throw new AcpReadOnlySessionError("cancel");
      }
    }
    await this.client.notifyAgent(M.sessionCancel, { sessionId: this.sessionId });
  }

  async setMode(modeId: string): Promise<void> {
    this.assertWritable("setMode");

    if (this.state.hasConfigOptions) {
      const option = findSelectOptionByCategory(this.state.configOptions, "mode");
      if (!option) {
        throw new AcpUnsupportedCapabilityError("a mode config option");
      }
      await this.setConfigOption(option.id, modeId);
      return;
    }

    if (!this.state.modes) {
      throw new AcpUnsupportedCapabilityError("session modes");
    }

    const previous = this.state.modes.currentModeId;
    this.state.modes = { ...this.state.modes, currentModeId: modeId };
    this.state.touch();
    this.invalidate();
    this.emitSynthetic({
      sessionUpdate: "current_mode_update",
      currentModeId: modeId,
    });

    try {
      await this.client.requestAgent(M.sessionSetMode, {
        sessionId: this.sessionId,
        modeId,
      });
    } catch (error) {
      if (this.state.modes) {
        this.state.modes = { ...this.state.modes, currentModeId: previous };
        this.state.touch();
        this.invalidate();
        this.emitSynthetic({
          sessionUpdate: "current_mode_update",
          currentModeId: previous,
        });
      }
      throw mapRequestError("session/set_mode", error);
    }
  }

  async setModel(modelId: string): Promise<void> {
    this.assertWritable("setModel");
    const option = findSelectOptionByCategory(this.state.configOptions, "model");
    if (!option) {
      throw new AcpUnsupportedCapabilityError("a model config option");
    }
    await this.setConfigOption(option.id, modelId);
  }

  async setConfigOption(
    configId: string,
    value: string | boolean,
  ): Promise<readonly ConfigOption[]> {
    this.assertWritable("setConfigOption");
    const option = this.state.configOptions.find((entry) => entry.id === configId);
    if (!option) {
      throw new AcpUnknownConfigOptionError(configId);
    }

    let params: SetSessionConfigOptionRequest;

    if (option.type === "boolean") {
      if (typeof value !== "boolean") {
        throw new AcpInvalidArgumentError(
          `Config option "${configId}" expects a boolean value`,
        );
      }
      params = { sessionId: this.sessionId, configId, type: "boolean", value };
    } else {
      if (typeof value !== "string") {
        throw new AcpInvalidArgumentError(
          `Config option "${configId}" expects a string value`,
        );
      }
      if (!option.options.some((entry) => entry.value === value)) {
        throw new AcpInvalidArgumentError(
          `Config option "${configId}" has no value "${value}"`,
        );
      }
      params = { sessionId: this.sessionId, configId, value };
    }

    const response = await this.client.requestAgent(M.sessionSetConfigOption, params);
    this.state.hasConfigOptions = true;
    this.state.configOptions = normalizeConfigOptions(response.configOptions);
    this.state.touch();
    this.invalidate();
    this.emitSynthetic({
      sessionUpdate: "config_option_update",
      configOptions: response.configOptions,
    });
    return [...this.state.configOptions];
  }

  async close(): Promise<void> {
    this.assertRoot("close");
    if (this.closedResolved) {
      return;
    }
    await this.client.closeSession(this.sessionId);
  }

  async delete(): Promise<void> {
    this.assertRoot("delete");
    await this.client.deleteSession(this.sessionId);
  }

  /** @internal */
  applyAgentStatus(status: SessionStatus): SessionStatusSnapshot {
    const snapshot: SessionStatusSnapshot = {
      value: status,
      checkedAt: new Date().toISOString(),
    };
    this.state.agentStatus = snapshot;
    this.state.touch();
    this.invalidate();
    this.emitter.emit({
      type: "status",
      status,
      checkedAt: snapshot.checkedAt,
    });
    return snapshot;
  }

  /** @internal */
  applyTitle(title: string): void {
    if (this.state.title === title) {
      return;
    }
    this.state.title = title;
    this.state.touch();
    this.invalidate();
    this.emitter.emit({
      type: "update",
      update: { sessionUpdate: "session_info_update", title },
      revision: this.state.revision,
    });
  }

  /** @internal */
  applyUpdate(update: SessionUpdate): void {
    if (this.state.lifecycle !== "active" && this.state.lifecycle !== "loading") {
      return;
    }

    if (
      this.state.loading &&
      (update.sessionUpdate === "config_option_update" ||
        update.sessionUpdate === "current_mode_update")
    ) {
      this.state.pendingStateUpdates.push(update);
      return;
    }

    try {
      if (update.sessionUpdate === "subagent_update") {
        this.client.applySubagentUpdate(this, update);
        this.state.touch();
      } else if (update.sessionUpdate === "notice") {
        this.client.handleNotice(this, update);
        this.state.touch();
      } else {
        applyUpdateToState(this.state, update);
        this.state.touch();
      }
      this.invalidate();
      this.emitter.emit({
        type: "update",
        update,
        revision: this.state.revision,
      });
    } catch (error) {
      this.emitError(mapRequestError(update.sessionUpdate, error));
    }
  }

  /** @internal */
  finishLoading(response: LoadingResponse): void {
    if (this.closedResolved) {
      return;
    }
    const deferredUpdates = this.state.finishLoading(
      response.configOptions ?? null,
      response.modes ?? null,
    );
    this.state.lifecycle = "active";
    this.state.touch();

    for (const update of deferredUpdates) {
      try {
        applyUpdateToState(this.state, update);
        this.state.touch();
        this.emitter.emit({
          type: "update",
          update,
          revision: this.state.revision,
        });
      } catch (error) {
        this.emitError(mapRequestError(update.sessionUpdate, error));
      }
    }

    this.invalidate();
  }

  /** @internal */
  markFailed(error: AcpError): void {
    if (this.closedResolved) {
      return;
    }
    this.state.lifecycle = "failed";
    this.state.touch();
    this.invalidate();
    this.resolveClosed({ reason: "load-failed", error });
  }

  /** @internal */
  markClosed(info: SessionCloseInfo): void {
    if (this.closedResolved) {
      if (info.reason === "deleted" && this.state.lifecycle !== "deleted") {
        this.state.lifecycle = "deleted";
        this.state.touch();
        this.invalidate();
      }
      return;
    }
    this.state.lifecycle = info.reason === "deleted" ? "deleted" : "closed";
    this.state.isPrompting = false;
    this.state.touch();
    this.invalidate();
    this.resolveClosed(info);
  }

  /** @internal */
  invalidate(): void {
    this.snapshotCache = null;
  }

  private resolveClosed(info: SessionCloseInfo): void {
    if (this.closedResolved) {
      return;
    }
    this.closedResolved = true;
    this.closedDeferred.resolve(info);
    this.emitter.emit({ type: "closed", info });
  }

  private emitSynthetic(update: SessionUpdate): void {
    this.emitter.emit({
      type: "update",
      update,
      revision: this.state.revision,
    });
  }

  private emitError(error: AcpError): void {
    this.client.reportError(error);
    this.emitter.emit({ type: "error", error });
  }

  private assertRoot(operation: string): void {
    if (this.kind === "subagent") {
      throw new AcpReadOnlySessionError(operation);
    }
  }

  private assertWritable(operation: string): void {
    this.assertRoot(operation);
    if (this.state.lifecycle !== "active") {
      throw new AcpSessionBusyError(
        `Session "${this.sessionId}" is ${this.state.lifecycle}, not active`,
      );
    }
    if (!this.client.isReady()) {
      throw new AcpSessionBusyError("ACP client is not ready");
    }
  }
}
