import { usePanel, usePlugin, type MountedSession } from "@opencode/plugin/gui";
import { For, Show, createEffect, createMemo, createResource, createSignal, on } from "solid-js";
import { AcpSettings, type SessionOptionView, type SessionOptionsView } from "../../rpc.js";
import { definition } from "../definition.js";

type LoadResult = { target: string; view: SessionOptionsView } | { target: string; error: true };

/**
 * The ACP options of the session the side panel shows. The panel receives the
 * session from the host, so it keeps working while Settings replaces the
 * session screen, where `ctx.sessions.current()` is undefined.
 */
export function SessionOptions(props: { session: MountedSession }) {
  const ctx = usePlugin<typeof definition>();
  const panel = usePanel();
  // A move keeps the key but changes the directory, and the RPC routes by
  // directory, so the target covers both.
  const identity = createMemo(() => `${props.session.key}\n${props.session.directory}`);
  const [resource, { refetch }] = createResource(identity, async (target): Promise<LoadResult> => {
    const session = props.session;
    try {
      const view = await session.server.client
        .rpc(AcpSettings)
        .sessionOptions({ sessionID: session.id }, { location: { directory: session.directory } });
      return { target, view };
    } catch {
      return { target, error: true };
    }
  });
  const result = () => {
    const value = resource.latest;
    return value !== undefined && value.target === identity() ? value : undefined;
  };
  const view = () => {
    const value = result();
    return value !== undefined && "view" in value ? value.view : undefined;
  };
  const failed = () => {
    const value = result();
    return value !== undefined && "error" in value;
  };
  const [saving, setSaving] = createSignal(false);
  const [actionError, setActionError] = createSignal<string>();

  // Options change while the panel is hidden, e.g. when the agent switches its
  // own mode, so read them again each time the tab becomes visible.
  createEffect(
    on(
      panel.visible,
      (visible) => {
        if (visible) void refetch();
      },
      { defer: true },
    ),
  );

  async function change(configID: string, value: string | boolean) {
    if (saving()) return;

    const session = props.session;
    setSaving(true);
    setActionError(undefined);
    try {
      const outcome = await session.server.client.rpc(AcpSettings).setSessionOption(
        {
          sessionID: session.id,
          configID,
          value,
        },
        { location: { directory: session.directory } },
      );
      if (outcome.status !== "ok") setActionError(ctx.t(`error.${outcome.status}`));
    } catch {
      setActionError(ctx.t("error.saveFailed"));
    } finally {
      setSaving(false);
      await refetch();
    }
  }

  const optionLabel = (option: SessionOptionView) =>
    option.id === "__mode" ? ctx.t("session.modeOption") : option.name;
  const optionDescription = (option: SessionOptionView) =>
    option.description ?? (option.category === "mode" ? ctx.t("session.mode") : undefined);

  return (
    <div class="acp-panel">
      <header class="acp-panel-header">
        <h2 class="acp-panel-title">{ctx.t("session.title")}</h2>
        <ctx.ui.IconButton
          icon="refresh"
          label={ctx.t("refresh")}
          variant="ghost-muted"
          busy={resource.loading}
          onClick={() => void refetch()}
        />
      </header>
      <div class="acp-panel-body">
        <Show
          when={view()}
          fallback={
            <p class="acp-panel-message" role="status">
              <Show when={failed()} fallback={<ctx.ui.Loader size="small" />}>
                {ctx.t("session.failed")}
              </Show>
            </p>
          }
        >
          {(data: () => SessionOptionsView) => (
            <Show
              when={data().status === "ok"}
              fallback={<p class="acp-panel-message">{ctx.t(`session.status.${data().status}`)}</p>}
            >
              <Show
                when={data().options.length > 0}
                fallback={<p class="acp-panel-message">{ctx.t("session.noOptions")}</p>}
              >
                <div class="acp-panel-options">
                  <For each={data().options}>
                    {(option) => (
                      <div class="acp-panel-field">
                        <div class="acp-panel-copy">
                          <span class="acp-panel-label">{optionLabel(option)}</span>
                          <Show when={optionDescription(option)}>
                            {(text: () => string) => <span class="acp-panel-description">{text()}</span>}
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
                </div>
              </Show>
              <section class="acp-panel-commands">
                <h3 class="acp-panel-heading">{ctx.t("session.commands")}</h3>
                <Show
                  when={(data().commands ?? []).length > 0}
                  fallback={<p class="acp-panel-message">{ctx.t("session.noCommands")}</p>}
                >
                  <For each={data().commands ?? []}>
                    {(command) => (
                      <div class="acp-panel-command">
                        <code class="acp-panel-command-name">/{command.name}</code>
                        <Show
                          when={
                            command.hint === undefined
                              ? command.description
                              : `${command.description} · ${command.hint}`
                          }
                        >
                          {(text: () => string) => <span class="acp-panel-description">{text()}</span>}
                        </Show>
                      </div>
                    )}
                  </For>
                </Show>
              </section>
            </Show>
          )}
        </Show>
        <Show when={actionError()}>
          {(text: () => string) => (
            <span class="acp-error" role="alert">
              {text()}
            </span>
          )}
        </Show>
      </div>
    </div>
  );
}
