import { createKeyed, type MountedSession, type ServerRef } from "@opencode/plugin/gui";
import { createEffect, createSignal, on, onCleanup } from "solid-js";
import { AcpRpc, type RebuildSessionResult, type SessionMetaView } from "../rpc.js";
import type { GuiContext } from "./definition.js";
import { retryUnavailable, rpcFailure, waitForLocation } from "./shared/location.js";
import { acpMetadataOf, isAcpSession } from "./shared/session.js";

/** The server replays the whole ACP history before it answers. */
const REBUILD_TIMEOUT_MS = 120_000;
const IMPORT_TIMEOUT_MS = 60_000;
/** The host's import may emit `session.created` a little after it resolves. */
const CREATED_TIMEOUT_MS = 400;
const SESSION_LIST_LIMIT = 1_000;
/** The host publishes a new tab on a later microtask; retry briefly before giving up. */
const TAB_MOVE_DELAYS_MS = [0, 50, 150];

export interface OpenAcpSessionInput {
  readonly server: ServerRef;
  readonly agentID: string;
  readonly acpSessionID: string;
  readonly cwd: string;
  readonly replaceSession?: MountedSession;
  readonly signal?: AbortSignal;
}

export type OpenAcpSessionResult =
  { readonly ok: true; readonly sessionID: string } | { readonly ok: false; readonly code: string };

export interface SessionHydrator {
  openSession(input: OpenAcpSessionInput): Promise<OpenAcpSessionResult>;
  reloadSession(session: MountedSession): Promise<OpenAcpSessionResult>;
  removeProjections(server: ServerRef, agentID: string, acpSessionID: string, cwd: string): Promise<void>;
  hydrating(sessionKey: string): boolean;
  dispose(): void;
}

interface HydratedSession {
  readonly agentID: string;
  readonly acpSessionID: string;
  readonly updatedAt: string;
}

/**
 * Rebuilds ACP sessions from the agent's own history and replaces their
 * OpenCode projections atomically.
 *
 * The rebuilt session gets a new OpenCode id, so a tab that still routes the
 * old projection would otherwise rebuild it again on every visit. `hydrated`
 * records the (agent, session, timestamp) of each replacement before the tab
 * opens, and the session listener only rebuilds a known session when the
 * agent reports a newer history.
 */
export function createSessionHydrator(ctx: GuiContext): SessionHydrator {
  const hydrated = new Map<string, HydratedSession>();
  const inFlight = new Set<string>();
  const [hydrating, setHydrating] = createSignal<Record<string, boolean>>({});
  const lifetime = new AbortController();

  const markHydrating = (key: string, value: boolean): void => {
    setHydrating((current) => {
      if (value) return { ...current, [key]: true };
      if (current[key] === undefined) return current;
      const next = { ...current };
      delete next[key];
      return next;
    });
  };

  const openSession = async (input: OpenAcpSessionInput): Promise<OpenAcpSessionResult> => {
    const { server, agentID, acpSessionID, cwd } = input;
    const flight = flightKey(server, agentID, acpSessionID);
    if (inFlight.has(flight)) return { ok: false, code: "sessionBusy" };

    inFlight.add(flight);
    const replaceKey = input.replaceSession?.key;
    if (replaceKey !== undefined) markHydrating(replaceKey, true);
    const signal = callSignal(lifetime.signal, REBUILD_TIMEOUT_MS, input.signal);

    try {
      await waitForLocation(server, cwd, signal);
      if (signal.aborted) return { ok: false, code: "aborted" };

      let rebuilt: RebuildSessionResult;
      try {
        rebuilt = await server.client
          .rpc(AcpRpc)
          .rebuildSession({ agentID, acpSessionID, cwd }, { location: { directory: cwd }, signal });
      } catch (error) {
        return { ok: false, code: signal.aborted ? "aborted" : rpcFailure(error) };
      }

      if (rebuilt.status !== "ok" || rebuilt.payload === undefined) {
        return { ok: false, code: rebuildFailureCode(rebuilt) };
      }

      const importer = server.client.experimental?.session?.import;
      if (typeof importer !== "function") return { ok: false, code: "updateOpenCode" };

      // The client's bridge swallows `session.created` during an import, so
      // listen first and sync the new session explicitly once it lands.
      const created = watchSessionCreated(server, rebuilt.sessionID);
      let imported;
      try {
        imported = await importer(rebuilt.payload as never, {
          signal: AbortSignal.timeout(IMPORT_TIMEOUT_MS),
        });
      } catch {
        created.stop();
        return { ok: false, code: signal.aborted ? "aborted" : "hydrateFailed" };
      }

      await waitFor(created.ready, CREATED_TIMEOUT_MS);
      created.stop();
      await Promise.resolve();
      if (signal.aborted) {
        // The user left before the projection was registered; remove it so no
        // orphaned session or `hydrated` entry survives.
        void removeProjectionSessions(server, [imported.id]);
        return { ok: false, code: "aborted" };
      }

      const newID = imported.id;
      await syncSession(server, newID);
      if (signal.aborted) {
        void removeProjectionSessions(server, [newID]);
        return { ok: false, code: "aborted" };
      }

      // Register before the tab opens: mounting the new tab reads this map and
      // must not trigger another rebuild of the session it just loaded.
      hydrated.set(sessionKey(server, newID), { agentID, acpSessionID, updatedAt: rebuilt.updatedAt });

      const oldIDs = await collectProjections(server, agentID, acpSessionID, cwd, newID);
      if (signal.aborted) {
        // The user left while the projections were listed; drop the new one
        // rather than opening a tab that steals focus.
        void removeProjectionSessions(server, [newID]);
        return { ok: false, code: "aborted" };
      }
      if (input.replaceSession !== undefined && input.replaceSession.id !== newID) {
        oldIDs.add(input.replaceSession.id);
      }

      replaceTabs(server, newID, oldIDs);
      if (oldIDs.size > 0) void removeProjectionSessions(server, [...oldIDs]);

      return { ok: true, sessionID: newID };
    } finally {
      inFlight.delete(flight);
      if (replaceKey !== undefined) markHydrating(replaceKey, false);
    }
  };

  const reloadSession = async (session: MountedSession): Promise<OpenAcpSessionResult> => {
    const meta = acpMetadataOf(session);
    if (meta === undefined) return { ok: false, code: "notAcp" };
    return openSession({
      server: session.server,
      agentID: meta.agent,
      acpSessionID: meta.session,
      cwd: meta.cwd ?? session.directory,
      replaceSession: session,
    });
  };

  const removeProjections = async (
    server: ServerRef,
    agentID: string,
    acpSessionID: string,
    cwd: string,
  ): Promise<void> => {
    const ids = await collectProjections(server, agentID, acpSessionID, cwd);
    if (ids.size === 0) return;

    for (const tab of ctx.tabs.list()) {
      const owner = tab.session;
      if (owner === undefined || owner.server.id !== server.id || !ids.has(owner.id)) continue;
      ctx.tabs.close(tab.key);
    }
    await removeProjectionSessions(server, [...ids]);
  };

  const replaceTabs = (server: ServerRef, newID: string, oldIDs: ReadonlySet<string>): void => {
    const tabs = ctx.tabs.list();
    let oldIndex = -1;
    const oldTabKeys: string[] = [];

    for (let index = 0; index < tabs.length; index++) {
      const tab = tabs[index];
      const owner = tab?.session;
      if (tab === undefined || owner === undefined || owner.server.id !== server.id) continue;
      if (!oldIDs.has(owner.id)) continue;

      if (oldIndex < 0) oldIndex = index;
      oldTabKeys.push(tab.key);
    }

    ctx.tabs.open({ server: server.id, id: newID }, { focus: true });
    if (oldIndex < 0) return;

    const closeOld = (): void => {
      for (const key of oldTabKeys) ctx.tabs.close(key);
    };
    const settle = (attempt: number): void => {
      const opened = ctx.tabs.list().find((tab) => tab.session?.server.id === server.id && tab.session.id === newID);
      if (opened !== undefined) {
        ctx.tabs.move(opened.key, oldIndex);
        closeOld();
        return;
      }
      if (attempt >= TAB_MOVE_DELAYS_MS.length - 1) {
        closeOld();
        return;
      }
      setTimeout(() => settle(attempt + 1), TAB_MOVE_DELAYS_MS[attempt + 1]);
    };
    settle(0);
  };

  const monitor = async (session: MountedSession, signal: AbortSignal): Promise<void> => {
    let meta: SessionMetaView;
    try {
      meta = await retryUnavailable(
        () =>
          session.server.client
            .rpc(AcpRpc)
            .sessionMeta({ sessionID: session.id }, { location: { directory: session.directory }, signal }),
        signal,
      );
    } catch {
      return;
    }

    if (signal.aborted) return;
    // A session that has not sent its first ACP message has no binding yet.
    if (meta.status !== "ok" || meta.agentID === undefined || meta.acpSessionID === undefined) return;
    if (session.server.data.session.status(session.id) === "running") return;

    const record = hydrated.get(session.key);
    if (record !== undefined) {
      const remote = meta.remoteUpdatedAt;
      if (remote === undefined || remote.length === 0) return;
      const local = record.updatedAt.length > 0 ? record.updatedAt : (meta.localUpdatedAt ?? "");
      if (remote === local || !isNewer(remote, local)) return;
    }

    const result = await openSession({
      server: session.server,
      agentID: meta.agentID,
      acpSessionID: meta.acpSessionID,
      cwd: meta.cwd ?? session.directory,
      replaceSession: session,
      signal,
    });

    if (result.ok || signal.aborted || result.code === "aborted") return;
    ctx.toast.show({
      title: ctx.t("sessions.title"),
      description: sessionError(ctx, result.code),
      variant: "error",
    });
  };

  createKeyed(
    () => ctx.sessions.current(),
    (session) => {
      const controller = new AbortController();
      onCleanup(() => controller.abort());

      let started = false;

      // A restored tab can mount before its server reconnects or its session
      // finishes syncing, when it does not look like an ACP session yet. Wait
      // for those signals instead of letting this visit give up permanently.
      createEffect(() => {
        if (started) return;
        if (session.pending) return;
        if (!session.server.connected || !session.server.compatible) return;
        if (!isAcpSession(session)) return;

        started = true;
        if (session.server.data.session.status(session.id) !== "running") {
          void monitor(session, AbortSignal.any([controller.signal, lifetime.signal]));
        }
      });

      // A turn this window just finished already contains the agent's latest
      // history. Remember its timestamp so returning to the tab treats it as
      // warm instead of rebuilding it.
      createEffect(
        on(
          () => session.server.data.session.status(session.id),
          (status, previous) => {
            if (status !== "idle" || previous !== "running") return;
            if (!isAcpSession(session) && acpMetadataOf(session) === undefined) return;
            const meta = acpMetadataOf(session);
            if (meta === undefined) return;
            hydrated.set(session.key, {
              agentID: meta.agent,
              acpSessionID: meta.session,
              updatedAt: meta.updatedAt ?? "",
            });
          },
          { defer: true },
        ),
      );
    },
    { equals: (previous, next) => previous.key === next.key && previous.visit === next.visit },
  );

  async function syncSession(server: ServerRef, sessionID: string): Promise<void> {
    try {
      server.data.session.invalidate(sessionID);
      await server.data.session.sync(sessionID);
      server.data.session.message.invalidate(sessionID);
      await server.data.session.message.sync(sessionID);
    } catch (error) {
      console.warn(`[acp] could not sync rebuilt session ${sessionID}: ${message(error)}`);
    }
  }

  async function collectProjections(
    server: ServerRef,
    agentID: string,
    acpSessionID: string,
    cwd: string,
    exceptID?: string,
  ): Promise<Set<string>> {
    const ids = new Set<string>();
    try {
      const listed = await server.client.session.list({ directory: cwd, limit: SESSION_LIST_LIMIT });
      for (const info of listed.data) {
        if (info.id === exceptID) continue;
        if (matchesProjection(info.metadata, agentID, acpSessionID)) ids.add(info.id);
      }
    } catch (error) {
      console.warn(`[acp] could not list projections in ${cwd}: ${message(error)}`);
    }
    return ids;
  }

  async function removeProjectionSessions(server: ServerRef, ids: readonly string[]): Promise<void> {
    await Promise.all(
      ids.map(async (id) => {
        try {
          await server.client.session.remove({ sessionID: id });
        } catch (error) {
          console.warn(`[acp] could not remove stale session ${id}: ${message(error)}`);
        } finally {
          hydrated.delete(sessionKey(server, id));
        }
      }),
    );
  }

  return {
    openSession,
    reloadSession,
    removeProjections,
    hydrating: (sessionKey) => hydrating()[sessionKey] === true,
    dispose() {
      lifetime.abort();
      hydrated.clear();
      inFlight.clear();
      setHydrating({});
    },
  };
}

function callSignal(lifetime: AbortSignal, timeoutMs: number, signal?: AbortSignal): AbortSignal {
  const signals = [lifetime, AbortSignal.timeout(timeoutMs)];
  if (signal !== undefined) signals.push(signal);
  return AbortSignal.any(signals);
}

function watchSessionCreated(server: ServerRef, sessionID: string): { readonly ready: Promise<void>; stop(): void } {
  let settle: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    settle = resolve;
  });

  let stopped = false;
  const off = server.data.on("session.created", (event) => {
    if (event.data.sessionID !== sessionID) return;
    stop();
    settle();
  });

  const stop = (): void => {
    if (stopped) return;
    stopped = true;
    off();
  };

  return { ready, stop };
}

/** Resolves with `promise`, or after `ms`, whichever comes first. */
function waitFor(promise: Promise<void>, ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    void promise.then(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function rebuildFailureCode(result: RebuildSessionResult): string {
  if (result.reason === "directoryMissing") return "directoryMissing";
  if (result.reason === "busy") return "sessionBusy";

  switch (result.status) {
    case "notFound":
      return "notFound";
    case "unsupported":
      return "unsupported";
    case "unavailable":
      return "unavailable";
    default:
      return "loadFailed";
  }
}

const SESSION_ERRORS = new Set([
  "notFound",
  "unsupported",
  "unavailable",
  "loadFailed",
  "directoryMissing",
  "sessionBusy",
  "deleteUnsupported",
  "deleteFailed",
  "updatePlugin",
  "locationNotReady",
  "updateOpenCode",
  "hydrateFailed",
  "requestFailed",
  "aborted",
]);

function sessionError(ctx: GuiContext, code: string): string {
  return ctx.t(`sessions.error.${SESSION_ERRORS.has(code) ? code : "requestFailed"}`);
}

function matchesProjection(metadata: unknown, agentID: string, acpSessionID: string): boolean {
  if (!isRecord(metadata)) return false;
  const acp = metadata["acp"];
  if (!isRecord(acp)) return false;
  return acp["agent"] === agentID && acp["session"] === acpSessionID;
}

function isNewer(remote: string, local: string): boolean {
  const left = Date.parse(remote);
  const right = Date.parse(local);
  if (Number.isFinite(left) && Number.isFinite(right)) return left > right;
  return remote !== local;
}

function sessionKey(server: ServerRef, sessionID: string): string {
  return `${server.id}\n${sessionID}`;
}

function flightKey(server: ServerRef, agentID: string, acpSessionID: string): string {
  return `${server.id}\n${agentID}\n${acpSessionID}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
