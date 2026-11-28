import { spawn, type ChildProcess } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

import type { AcpLogger } from "./logger.js";

export class StderrBuffer {
  private chunks: string[] = [];
  private bytes = 0;

  constructor(private readonly maxBytes: number) {}

  append(text: string): void {
    if (!text) {
      return;
    }
    this.chunks.push(text);
    this.bytes += Buffer.byteLength(text, "utf8");
    this.trim();
  }

  get value(): string {
    return this.chunks.join("");
  }

  private trim(): void {
    while (this.bytes > this.maxBytes && this.chunks.length > 1) {
      const removed = this.chunks.shift();
      if (removed === undefined) {
        break;
      }
      this.bytes -= Buffer.byteLength(removed, "utf8");
    }

    if (this.bytes > this.maxBytes && this.chunks.length === 1) {
      const only = this.chunks[0] ?? "";
      const excess = this.bytes - this.maxBytes;
      const kept = Buffer.from(only, "utf8").subarray(excess).toString("utf8");
      this.chunks = [kept];
      this.bytes = Buffer.byteLength(kept, "utf8");
    }
  }
}

export interface ProcessExitInfo {
  readonly code: number | null;
  readonly signal: string | null;
  readonly expected: boolean;
  readonly stderr: string;
}

export interface AgentProcessOptions {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  spawnMs: number;
  maxStderrBytes: number;
  logger: Required<AcpLogger>;
  onStderr?: (chunk: string) => void;
}

/**
 * 管理一个 ACP Agent 子进程。stdout/stdin 留给 NDJSON 传输，stderr 单独采集。
 */
export class AgentProcess {
  private childProcess: ChildProcess | null = null;
  private exitInfo: ProcessExitInfo | null = null;
  private readonly exitListeners = new Set<(info: ProcessExitInfo) => void>();
  private readonly stderrBuffer: StderrBuffer;
  private terminating = false;

  constructor(private readonly options: AgentProcessOptions) {
    this.stderrBuffer = new StderrBuffer(options.maxStderrBytes);
  }

  get pid(): number | null {
    return this.childProcess?.pid ?? null;
  }

  get child(): ChildProcess {
    if (!this.childProcess) {
      throw new Error("Agent process has not been spawned");
    }
    return this.childProcess;
  }

  get stdin(): NodeJS.WritableStream {
    if (!this.childProcess?.stdin) {
      throw new Error("Agent process stdin is unavailable");
    }
    return this.childProcess.stdin;
  }

  get stdout(): NodeJS.ReadableStream {
    if (!this.childProcess?.stdout) {
      throw new Error("Agent process stdout is unavailable");
    }
    return this.childProcess.stdout;
  }

  get stderr(): string {
    return this.stderrBuffer.value;
  }

  get isAlive(): boolean {
    const child = this.childProcess;
    return child !== null && child.exitCode === null && child.signalCode === null;
  }

  get lastExit(): ProcessExitInfo | null {
    return this.exitInfo;
  }

  onExit(listener: (info: ProcessExitInfo) => void): () => void {
    this.exitListeners.add(listener);
    return () => {
      this.exitListeners.delete(listener);
    };
  }

  async spawn(): Promise<void> {
    const { command, args, cwd, env, spawnMs, logger, onStderr } = this.options;

    const child = spawn(command, args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    this.childProcess = child;

    const decoder = new StringDecoder("utf8");
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = decoder.write(chunk);
      if (!text) {
        return;
      }
      this.stderrBuffer.append(text);
      onStderr?.(text);
    });
    child.stderr?.on("end", () => {
      const text = decoder.end();
      if (text) {
        this.stderrBuffer.append(text);
        onStderr?.(text);
      }
    });
    child.stderr?.on("error", (error) => {
      logger.warn("ACP agent stderr stream error", error);
    });
    child.stdin?.on("error", (error) => {
      logger.debug("ACP agent stdin stream error", error);
    });
    child.stdout?.on("error", (error) => {
      logger.warn("ACP agent stdout stream error", error);
    });
    child.on("error", (error) => {
      logger.error("ACP agent process error", error);
    });

    child.once("exit", (code, signal) => {
      const info: ProcessExitInfo = {
        code,
        signal,
        expected: this.terminating,
        stderr: this.stderrBuffer.value,
      };
      this.exitInfo = info;
      for (const listener of [...this.exitListeners]) {
        try {
          listener(info);
        } catch (error) {
          logger.error("ACP process exit listener failed", error);
        }
      }
      this.exitListeners.clear();
    });

    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        reject(new Error(`Timed out after ${spawnMs}ms waiting for process spawn`));
      }, spawnMs);

      const finish = (error?: unknown): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (error === undefined) {
          resolve();
        } else {
          reject(error);
        }
      };

      child.once("spawn", () => finish());
      child.once("error", (error) => finish(error));
    });
  }

  async terminate(disposeMs: number): Promise<void> {
    this.terminating = true;
    const child = this.childProcess;
    if (!child) {
      return;
    }

    try {
      child.stdin?.end();
    } catch {
      // 进程可能已经退出，忽略关闭 stdin 的失败。
    }

    if (!this.isAlive) {
      return;
    }

    const exited = new Promise<void>((resolve) => {
      if (!this.isAlive) {
        resolve();
        return;
      }
      const dispose = this.onExit(() => {
        dispose();
        resolve();
      });
    });

    this.kill("SIGTERM");

    const forceTimer = setTimeout(() => {
      this.kill("SIGKILL");
    }, Math.max(1, disposeMs));

    await Promise.race([exited, sleep(disposeMs + 1_000)]);
    clearTimeout(forceTimer);
  }

  kill(signal: NodeJS.Signals): void {
    const child = this.childProcess;
    if (!child?.pid) {
      return;
    }

    if (process.platform === "win32") {
      if (signal === "SIGKILL") {
        const killer = spawn("taskkill", ["/pid", String(child.pid), "/T", "/F"], {
          stdio: "ignore",
          windowsHide: true,
        });
        killer.on("error", () => {
          // 忽略 taskkill 失败，随后仍会尝试 child.kill。
        });
      }
      try {
        child.kill(signal);
      } catch {
        // 进程已经退出。
      }
      return;
    }

    try {
      process.kill(-child.pid, signal);
    } catch {
      try {
        child.kill(signal);
      } catch {
        // 进程已经退出。
      }
    }
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
