import {
  ComposerPill,
  type ComposerPillMenuProps,
  type ComposerPillView,
  type MountedSession,
} from "@opencode/plugin/gui";
import { For, Show, createEffect, createMemo, createSignal, on, onCleanup } from "solid-js";
import { AcpRpc, type SessionOptionView, type SessionStateView } from "../../rpc.js";
import type { GuiContext } from "../definition.js";
import type { SessionHydrator } from "../hydrator.js";
import { retryUnavailable, waitForLocation } from "../shared/location.js";
import { acpMetadataOf, isAcpSession } from "../shared/session.js";

const STATE_TIMEOUT_MS = 60_000;

const SESSION_ERRORS = new Set([
  "notFound",
  "unsupported",
  "unavailable",
  "loadFailed",
  "directoryMissing",
  "sessionBusy",
  "updatePlugin",
  "locationNotReady",
  "updateOpenCode",
  "hydrateFailed",
  "requestFailed",
  "aborted",
]);

type ModeLabels = (key: string, label: string | undefined) => void;

export function createSessionPill(ctx: GuiContext, hydrator: SessionHydrator): ComposerPill {
  const [modes, setModes] = createSignal<Record<string, string>>({});
  const lifetime = new AbortController();
  onCleanup(() => lifetime.abort());

  const updateMode: ModeLabels = (key, label) => {
    setModes((current) => {
      if (label === undefined) {
        if (current[key] === undefined) return current;
        const next = { ...current };
        delete next[key];
        return next;
      }
      if (current[key] === label) return current;
      return { ...current, [key]: label };
    });
  };

  // A mode the agent switched on its own shows on the pill as soon as the
  // session is routed, without starting the agent.
  createEffect(
    on(
      () => ctx.sessions.current(),
      (session) => {
        if (session === undefined || !isAcpSession(session)) return;
        void refreshModeLabel(session, lifetime.signal).then((label) => {
          if (label !== undefined) updateMode(session.key, label);
        });
      },
    ),
  );

  // An agent can switch modes during a turn without telling the picker; follow
  // the idle boundary to keep the pill's label current.
  createEffect(
    on(
      () => {
        const session = ctx.sessions.current();
        if (session === undefined || !isAcpSession(session)) return "";
        return `${session.key}:${session.server.data.session.status(session.id)}`;
      },
      (value, previous) => {
        if (!value.endsWith(":idle") || previous === undefined || !previous.endsWith(":running")) return;
        const session = ctx.sessions.current();
        if (session === undefined || !isAcpSession(session)) return;
        void refreshModeLabel(session, lifetime.signal).then((label) => {
          if (label !== undefined) updateMode(session.key, label);
        });
      },
      { defer: true },
    ),
  );

  return {
    id: "session",
    show(input): ComposerPillView | undefined {
      if (!isAcpSession(input.session)) return undefined;
      if (hydrator.hydrating(input.session.key)) return { label: ctx.t("pill.reloading"), icon: "sliders" };
      return { label: modes()[input.session.key] ?? ctx.t("pill.title"), icon: "sliders" };
    },
    menu(input: ComposerPillMenuProps) {
      return <SessionPillMenu ctx={ctx} hydrator={hydrator} input={input} onMode={updateMode} />;
    },
  };
}

/** The name of the option that carries the session's mode, if the agent reports one. */
function modeOption(options: readonly SessionOptionView[]): SessionOptionView | undefined {
  return options.find((option) => option.id === "__mode" || option.category === "mode");
}

/** Model and thinking level belong to the model picker, not the pill. */
function isSessionOption(option: SessionOptionView): boolean {
  return (
    option.id !== "model" &&
    option.id !== "thought_level" &&
    option.category !== "model" &&
    option.category !== "thought_level"
  );
}

function modeName(state: SessionStateView | undefined): string | undefined {
  if (state === undefined) return undefined;
  const option = modeOption(state.options);
  if (option === undefined || typeof option.current !== "string") return undefined;
  return option.values?.find((value) => value.value === option.current)?.name;
}

async function refreshModeLabel(session: MountedSession, lifetime: AbortSignal): Promise<string | undefined> {
  try {
    const state = await retryUnavailable(
      () =>
        session.server.client.rpc(AcpRpc).sessionState(
          { sessionID: session.id, ensureLoaded: false },
          {
            location: { directory: session.directory },
            signal: AbortSignal.any([lifetime, AbortSignal.timeout(10_000)]),
          },
        ),
      lifetime,
    );
    if (state.status !== "ok" && state.status !== "cached") return undefined;
    return modeName(state);
  } catch {
    return undefined;
  }
}

function SessionPillMenu(props: {
  ctx: GuiContext;
  hydrator: SessionHydrator;
  input: ComposerPillMenuProps;
  onMode: ModeLabels;
}) {
  const ctx = props.ctx;
  const [state, setState] = createSignal<SessionStateView>();
  const [failed, setFailed] = createSignal(false);
  const [saving, setSaving] = createSignal(false);
  const [reloading, setReloading] = createSignal(false);

  const lifetime = new AbortController();
  let generation = 0;
  onCleanup(() => lifetime.abort());

  // A move keeps the session key but changes the directory, and the RPC
  // routes by directory, so the target covers both.
  const identity = createMemo(() => `${props.input.session.key}\n${props.input.session.directory}`);

  createEffect(() => {
    identity();
    void refresh(true);
  });

  async function refresh(ensureLoaded: boolean) {
    const session = props.input.session;
    const current = ++generation;
    setFailed(false);
    try {
      const view = await retryUnavailable(
        () =>
          session.server.client.rpc(AcpRpc).sessionState(
            { sessionID: session.id, ensureLoaded },
            {
              location: { directory: session.directory },
              signal: AbortSignal.any([lifetime.signal, AbortSignal.timeout(STATE_TIMEOUT_MS)]),
            },
          ),
        lifetime.signal,
      );
      if (current !== generation || lifetime.signal.aborted) return;
      setState(view);
      props.onMode(session.key, modeName(view));
    } catch {
      if (current !== generation || lifetime.signal.aborted) return;
      setState(undefined);
      setFailed(true);
    }
  }

  const options = () => (state()?.options ?? []).filter(isSessionOption);
  const agentName = () => state()?.agentName ?? state()?.agentID ?? ctx.t("pill.title");
  const running = () => {
    try {
      return props.input.session.server.data.session.status(props.input.session.id) === "running";
    } catch {
      return false;
    }
  };
  const reloadDisabled = () =>
    running() ||
    props.hydrator.hydrating(props.input.session.key) ||
    reloading() ||
    acpMetadataOf(props.input.session) === undefined;

  const optionLabel = (option: SessionOptionView) => (option.id === "__mode" ? ctx.t("pill.mode") : option.name);

  async function change(configID: string, value: string | boolean) {
    if (saving()) return;

    const session = props.input.session;
    setSaving(true);
    try {
      await waitForLocation(session.server, session.directory);
      const outcome = await session.server.client
        .rpc(AcpRpc)
        .setSessionOption({ sessionID: session.id, configID, value }, { location: { directory: session.directory } });
      if (outcome.status !== "ok") {
        ctx.toast.show({
          title: ctx.t("session.title"),
          description: ctx.t(`error.${outcome.status}`),
          variant: "error",
        });
      }
    } catch {
      ctx.toast.show({ title: ctx.t("session.title"), description: ctx.t("error.saveFailed"), variant: "error" });
    } finally {
      setSaving(false);
      await refresh(true);
    }
  }

  async function reload() {
    if (reloadDisabled()) return;

    setReloading(true);
    try {
      const result = await props.hydrator.reloadSession(props.input.session);
      if (result.ok) {
        props.input.close();
        ctx.toast.show({ title: ctx.t("pill.reloaded"), variant: "success" });
        return;
      }
      ctx.toast.show({
        title: ctx.t("pill.reloadFailed"),
        description: ctx.t(`sessions.error.${SESSION_ERRORS.has(result.code) ? result.code : "requestFailed"}`),
        variant: "error",
      });
    } finally {
      setReloading(false);
    }
  }

  return (
    <div class="acp-pill">
      <header class="acp-pill-header">
        <span class="acp-pill-agent" dir="auto" title={agentName()}>
          {agentName()}
        </span>
        <ctx.ui.Button
          size="small"
          variant="ghost"
          icon="refresh"
          busy={reloading()}
          disabled={reloadDisabled()}
          onClick={() => void reload()}
        >
          {ctx.t("pill.reload")}
        </ctx.ui.Button>
      </header>
      <Show
        when={state()}
        fallback={
          <p class="acp-pill-message" role="status">
            <Show when={failed()} fallback={<ctx.ui.Loader size="small" />}>
              {ctx.t("pill.failed")}
            </Show>
          </p>
        }
      >
        {(view: () => SessionStateView) => (
          <Show
            when={view().status === "ok" || view().status === "cached"}
            fallback={
              <p class="acp-pill-message" role="status">
                {ctx.t(`pill.status.${view().status}`)}
              </p>
            }
          >
            <div class="acp-pill-options">
              <Show when={options().length > 0} fallback={<p class="acp-pill-message">{ctx.t("pill.noOptions")}</p>}>
                <For each={options()}>
                  {(option) => (
                    <div class="acp-pill-field">
                      <div class="acp-pill-copy">
                        <span class="acp-pill-label">{optionLabel(option)}</span>
                        <Show when={option.description}>
                          {(text: () => string) => <span class="acp-pill-description">{text()}</span>}
                        </Show>
                      </div>
                      <Show
                        when={option.type === "select"}
                        fallback={
                          <ctx.ui.Switch
                            checked={option.current === true}
                            disabled={saving()}
                            label={optionLabel(option)}
                            hideLabel
                            onChange={(checked) => void change(option.id, checked)}
                          />
                        }
                      >
                        <ctx.ui.Select
                          label={optionLabel(option)}
                          value={typeof option.current === "string" ? option.current : undefined}
                          options={(option.values ?? []).map((item) => ({ label: item.name, value: item.value }))}
                          disabled={saving()}
                          placement="bottom-end"
                          onChange={(value) => void change(option.id, value)}
                        />
                      </Show>
                    </div>
                  )}
                </For>
              </Show>
            </div>
          </Show>
        )}
      </Show>
    </div>
  );
}
