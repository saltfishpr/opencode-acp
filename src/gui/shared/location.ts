import type { ServerRef } from "@opencode/plugin/gui";
import type { Rpc } from "@opencode/plugin/rpc";
import { AcpSettings } from "../../rpc.js";

const PROBE_TIMEOUT_MS = 5_000;
const BACKOFF_MS = [0, 100, 200, 400, 800, 1600] as const;

/** The failures the host's RPC layer returns; handler errors carry their own names. */
type SystemErrorType = Rpc.SystemError["type"];

function errorType(error: unknown): SystemErrorType | undefined {
  if (typeof error !== "object" || error === null || !("type" in error)) return undefined;
  const type = error.type;
  return typeof type === "string" ? (type as SystemErrorType) : undefined;
}

/** The host rejects RPCs until the directory's location has registered its plugins. */
function isLocationUnavailable(error: unknown): boolean {
  return errorType(error) === "rpc.unavailable";
}

/** The suffix of the `command.*` and `import.error.*` keys that explain a failed RPC. */
export type RpcFailure = "updatePlugin" | "locationNotReady" | "requestFailed";

/**
 * A missing method means the host's plugin is outdated, an unavailable location
 * means it is still booting, and anything else is a plain request failure.
 */
export function rpcFailure(error: unknown): RpcFailure {
  if (isLocationUnavailable(error)) return "locationNotReady";
  if (errorType(error) === "rpc.method_not_found") return "updatePlugin";
  return "requestFailed";
}

/**
 * The host boots a directory's location on demand and loads its plugins
 * asynchronously, so the first RPC into an unopened directory answers
 * `rpc.unavailable`. `importAgents` only reads plugin state, which makes it safe
 * to probe until the plugin has registered its methods.
 */
export async function waitForLocation(server: ServerRef, directory: string, signal?: AbortSignal): Promise<void> {
  for (const delay of BACKOFF_MS) {
    if (delay > 0) await pause(delay);
    if (signal?.aborted) return;

    const timeout = AbortSignal.timeout(PROBE_TIMEOUT_MS);
    try {
      await server.client.rpc(AcpSettings).importAgents(
        {},
        {
          location: { directory },
          signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]),
        },
      );
      return;
    } catch (error) {
      // Any other answer means the plugin is registered or absent; the real
      // call reports the actual problem.
      if (!isLocationUnavailable(error)) return;
    }
  }
}

/**
 * Retries a read-only call while its location finishes loading. Never use this
 * for a mutation: `rpc.unavailable` also covers a call interrupted midway, so a
 * retry could apply the change twice.
 */
export async function retryUnavailable<T>(call: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  for (let attempt = 0; ; attempt++) {
    try {
      return await call();
    } catch (error) {
      const delay = BACKOFF_MS[attempt];
      if (delay === undefined || !isLocationUnavailable(error)) throw error;
      if (delay > 0) await pause(delay);
      signal?.throwIfAborted();
    }
  }
}

function pause(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
