import { isAbsolute, resolve } from "node:path";

import { AcpInvalidArgumentError } from "./errors.js";

export interface Deferred<T> {
  readonly promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export function mergeEnv(
  base: NodeJS.ProcessEnv,
  extra?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const merged: NodeJS.ProcessEnv = { ...base, ...extra };
  for (const [key, value] of Object.entries(merged)) {
    if (value === undefined) {
      delete merged[key];
    }
  }
  return merged;
}

export function resolveProcessCwd(cwd?: string): string {
  return resolve(cwd ?? process.cwd());
}

export function requireAbsolutePath(path: string, field: string): string {
  if (!isAbsolute(path)) {
    throw new AcpInvalidArgumentError(`${field} must be an absolute path, received "${path}"`);
  }
  return path;
}

export function requireAbsolutePaths(paths: readonly string[], field: string): string[] {
  return paths.map((path, index) => requireAbsolutePath(path, `${field}[${index}]`));
}

export function estimateBytes(value: unknown): number {
  try {
    return Buffer.byteLength(JSON.stringify(value), "utf8");
  } catch {
    return 0;
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => {
    const timer = setTimeout(resolveDelay, ms);
    timer.unref?.();
  });
}
