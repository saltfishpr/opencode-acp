import { accessSync, constants, statSync } from "node:fs";
import { delimiter, resolve } from "node:path";
import type { AgentConfig } from "../config.js";
import type { Catalog } from "./catalog.js";
import { explain, type AcpExit, type FailureContext } from "./errors.js";
import { AcpClient } from "./client.js";

/** Server-side record for an enabled agent with a resolved executable. */
export interface AgentState {
  readonly runtime: AgentRuntime;
  name: string;
  catalog?: Catalog;
  status: "discovering" | "ready" | "failed";
  failure: string;
}

/** What diagnostics can say about one agent without starting it. */
export interface AgentRuntimeSnapshot {
  readonly running: boolean;
  readonly pid: number | undefined;
  readonly contextWindow: number | undefined;
  /** `undefined` until a process has reported its prompt capabilities. */
  readonly supportsImages: boolean | undefined;
  readonly exit: AcpExit | undefined;
  readonly failure: FailureContext | undefined;
}

/**
 * Owns the ACP process for one configured agent.
 *
 * Model discovery and OpenCode sessions share the process. If it exits, the
 * next call to `ensureClient()` starts a replacement.
 */
export class AgentRuntime {
  private client: AcpClient | undefined;
  private starting: Promise<AcpClient> | undefined;
  private readonly locks = new Map<string, Promise<void>>();
  private closed = false;
  private paused = false;
  private failureMessage: string | undefined;
  private capabilities: boolean | undefined;

  constructor(
    readonly agent: AgentConfig,
    readonly path: string,
    /** Called when a started process reports different prompt capabilities than the last one. */
    private readonly onCapabilities?: (supportsImages: boolean) => void,
  ) {}

  /** Pauses new turns only if this process has no admitted turns. */
  pause(): boolean {
    if (this.locks.size !== 0) return false;
    this.paused = true;
    return true;
  }

  resume(): void {
    this.paused = false;
  }

  /** Serializes work for one session. Returns undefined while settings are changing. */
  lock(key: string): Promise<() => void> | undefined {
    if (this.closed || this.paused) return undefined;
    return this.lockTurn(key);
  }

  private async lockTurn(key: string): Promise<() => void> {
    const previous = this.locks.get(key) ?? Promise.resolve();
    let release: () => void = () => {};
    const currentLock = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => currentLock);
    this.locks.set(key, tail);
    await previous;

    return () => {
      release();
      if (this.locks.get(key) === tail) this.locks.delete(key);
    };
  }

  async ensureClient(): Promise<AcpClient> {
    if (this.closed) throw new Error(`agent ${this.agent.id} was closed`);
    if (this.client !== undefined && !this.client.isClosed) return this.client;
    if (this.starting !== undefined) return this.starting;

    this.client = undefined;
    this.starting = AcpClient.start({
      command: this.path,
      args: this.agent.args,
      env: this.agent.env,
      name: this.agent.id,
    }).finally(() => {
      this.starting = undefined;
    });

    const client = await this.starting.then(
      (client) => client,
      (error: unknown) => {
        this.failureMessage = explain(error, this.status.failure);
        throw error;
      },
    );
    if (this.closed) {
      client.close();
      throw new Error(`agent ${this.agent.id} was closed`);
    }
    this.client = client;
    this.failureMessage = undefined;
    this.reportCapabilities(client);
    return this.client;
  }

  /**
   * Reloads providers when a restarted process advertises different prompt
   * capabilities, because the model catalog outlives individual processes.
   */
  private reportCapabilities(client: AcpClient): void {
    const images = client.supportsImages;
    if (images === this.capabilities) return;

    this.capabilities = images;
    this.onCapabilities?.(images);
  }

  get status(): AgentRuntimeSnapshot {
    const client = this.client;
    return {
      running: client !== undefined && !client.isClosed,
      pid: client?.pid,
      contextWindow: client?.contextWindow,
      supportsImages: client === undefined || client.isClosed ? undefined : client.supportsImages,
      exit: client?.exitInfo,
      failure: client?.failure,
    };
  }

  get lastFailure(): string | undefined {
    return this.failureMessage;
  }

  close(): void {
    this.closed = true;
    this.client?.close();
    this.client = undefined;

    // A close during startup must not leave the just-spawned process behind.
    if (this.starting !== undefined) {
      void this.starting.then(
        (client) => client.close(),
        () => {},
      );
    }
  }
}

/** Resolve against the selected server's PATH without running the executable. */
export function findExecutable(agent: AgentConfig): string | undefined {
  const { command } = agent;
  const paths =
    command.includes("/") || command.includes("\\")
      ? [resolve(command)]
      : (agent.env["PATH"] ?? process.env["PATH"] ?? "")
          .split(delimiter)
          .filter(Boolean)
          .map((directory) => resolve(directory, command));
  const extensions =
    process.platform === "win32" && !/\.[^/\\]+$/.test(command)
      ? (process.env["PATHEXT"] ?? ".COM;.EXE;.BAT;.CMD").split(";")
      : [""];

  for (const path of paths) {
    for (const extension of extensions) {
      const candidate = `${path}${extension}`;
      try {
        accessSync(candidate, constants.X_OK);
        if (statSync(candidate).isFile()) return candidate;
      } catch {
        continue;
      }
    }
  }
}
