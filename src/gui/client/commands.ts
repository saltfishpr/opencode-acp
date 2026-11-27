import { Command, createKeyed, createLatest, type MountedSession } from "@opencode/plugin/gui";
import { createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import { AcpSettings, type RunCommandStatus, type SessionCommandView, type SessionCommandsView } from "../../rpc.js";
import type { GuiContext } from "../definition.js";
import { acpProviderID, isAcpSession } from "./session.js";

const EMPTY: readonly SessionCommandView[] = [];

interface Target {
  readonly key: string;
  readonly session: MountedSession;
}

interface Result {
  readonly key: string;
  readonly view: SessionCommandsView;
}

/**
 * Lists the current session's ACP commands as `/acp:<name>` and runs them
 * through the server. The command set follows the session and its ACP model;
 * when the session switches, the keyed scope withdraws the old commands.
 */
export function createSessionCommands(ctx: GuiContext) {
  const [refresh, setRefresh] = createSignal(0);
  let cached: Target | undefined;

  const target = createMemo<Target | undefined>(() => {
    const session = ctx.sessions.current();
    const providerID = session === undefined ? undefined : acpProviderID(session);
    if (session === undefined || providerID === undefined) {
      cached = undefined;
      return undefined;
    }

    const key = `${session.key}\n${session.directory}\n${providerID}\n${refresh()}`;
    if (cached?.key === key) return cached;
    cached = { key, session };
    return cached;
  });

  const latest = createLatest(target, async (value, signal): Promise<Result> => {
    try {
      const view = await value.session.server.client
        .rpc(AcpSettings)
        .sessionCommands({ sessionID: value.session.id }, { location: { directory: value.session.directory }, signal });
      return { key: value.key, view };
    } catch {
      return { key: value.key, view: { status: "unavailable", commands: [] } };
    }
  });

  const view = createMemo<SessionCommandsView | undefined>(() => {
    const current = target();
    const value = latest.latest;
    if (current === undefined || value === undefined || value.key !== current.key) return undefined;
    return value.view;
  });

  const commands = createMemo<readonly SessionCommandView[]>(() => {
    const value = view();
    if (value?.status !== "ok" && value?.status !== "cached") return EMPTY;
    return value.commands;
  });

  createKeyed(
    commands,
    (items) => {
      const seen = new Set<string>();
      for (const item of items) {
        if (item.name.length === 0 || /\s/.test(item.name) || seen.has(item.name)) continue;
        seen.add(item.name);

        ctx.add(Command, (): Command => ({
          id: `slash-${commandID(item.name)}`,
          title: item.name,
          description: item.hint === undefined ? item.description : `${item.description} · ${item.hint}`,
          hidden: true,
          slash: { name: `acp:${item.name}`, arguments: true },
          run: (input) => void run(item.name, input),
        }));
      }
    },
    { equals: sameCommands },
  );

  // The agent may still be discovering when the session mounts and report no
  // commands yet. Retry while it is unavailable; the idle effect below covers
  // updates that arrive during a turn.
  createEffect(() => {
    if (view()?.status !== "unavailable") return;

    const timer = setTimeout(() => setRefresh((value) => value + 1), 3000);
    onCleanup(() => clearTimeout(timer));
  });

  createEffect(
    on(
      () => {
        const session = ctx.sessions.current();
        if (session === undefined || !isAcpSession(session)) return "";
        return `${session.key}:${session.server.data.session.status(session.id)}`;
      },
      (value, previous) => {
        if (value.endsWith(":idle") && previous !== undefined && !previous.endsWith(":idle")) {
          setRefresh((current) => current + 1);
        }
      },
      { defer: true },
    ),
  );

  async function run(name: string, input?: string) {
    const session = ctx.sessions.current();
    if (session === undefined) return;

    const delivery = ctx.screen.current()?.composer.delivery();
    try {
      const result = await session.server.client.rpc(AcpSettings).runCommand(
        {
          sessionID: session.id,
          name,
          input: input ?? "",
          ...(delivery === "steer" || delivery === "queue" ? { delivery } : {}),
        },
        { location: { directory: session.directory } },
      );

      if (result.status !== "ok") {
        ctx.toast.show({
          title: ctx.t("command.failed"),
          description: commandError(ctx, result.status, result.message),
          variant: "error",
        });
      }
    } catch (error) {
      const type = typeof error === "object" && error !== null && "type" in error ? error.type : undefined;
      ctx.toast.show({
        title: ctx.t("command.failed"),
        description: type === "rpc.method_not_found" ? ctx.t("command.updatePlugin") : ctx.t("command.requestFailed"),
        variant: "error",
      });
    }
  }
}

function commandError(ctx: GuiContext, status: Exclude<RunCommandStatus, "ok">, message: string | undefined): string {
  switch (status) {
    case "notAcp":
      return ctx.t("command.notAcp");
    case "notFound":
      return ctx.t("command.notFound");
    case "unavailable":
      return ctx.t("command.unavailable");
    default:
      return message !== undefined && message.length > 0 ? message : ctx.t("command.requestFailed");
  }
}

function sameCommands(a: readonly SessionCommandView[], b: readonly SessionCommandView[]): boolean {
  if (a.length !== b.length) return false;

  return a.every((command, index) => {
    const other = b[index];
    return (
      other !== undefined &&
      command.name === other.name &&
      command.description === other.description &&
      command.hint === other.hint
    );
  });
}

/** A stable command id for names that may contain characters the host does not expect. */
function commandID(name: string): string {
  const base = name.replace(/[^a-zA-Z0-9_-]/g, "_") || "command";
  let hash = 0;
  for (const char of name) hash = (hash * 31 + (char.codePointAt(0) ?? 0)) >>> 0;
  return `${base}-${hash.toString(36)}`;
}
