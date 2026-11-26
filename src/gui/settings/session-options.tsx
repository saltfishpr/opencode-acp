import { usePlugin, type MountedSession } from "@opencode/plugin/gui";
import { For, Show, createMemo, createResource, createSignal } from "solid-js";
import { AcpSettings, type MutationResult, type SessionOptionsView } from "../../rpc.js";
import { definition } from "../definition.js";

type LoadResult =
  | { sessionID: string; directory: string | undefined; view: SessionOptionsView }
  | { sessionID: string; directory: string | undefined; error: true };

/**
 * Settings for the ACP session behind the session currently open in the app.
 * The values live on the server's ACP agent, so the RPC goes to that session's
 * own server rather than the one selected in the switcher.
 */
export function SessionOptions() {
  const ctx = usePlugin<typeof definition>();
  const current = () => ctx.sessions.current();
  // `current()` returns a new object when the routed session changes; keep the
  // reference stable so the resource only refetches on real switches.
  const source = createMemo(current);
  const [resource, { refetch }] = createResource(source, async (session): Promise<LoadResult> => {
    const directory = session.location?.directory;
    try {
      const view = (await session.server.client
        .rpc(AcpSettings)
        .sessionOptions({ sessionID: session.id }, rpcOptions(session))) as SessionOptionsView;
      return { sessionID: session.id, directory, view };
    } catch {
      return { sessionID: session.id, directory, error: true };
    }
  });
  const result = () => {
    const value = resource.latest;
    const active = current();
    if (value === undefined || active === undefined) return undefined;
    return value.sessionID === active.id && value.directory === active.location?.directory ? value : undefined;
  };
  const view = () => {
    const value = result();
    return value !== undefined && "view" in value ? value.view : undefined;
  };
  const failed = () => {
    const value = result();
    return value !== undefined && "error" in value;
  };
  const [pending, setPending] = createSignal<string>();
  const [actionError, setActionError] = createSignal<string>();

  async function change(session: MountedSession, configID: string, value: string | boolean) {
    if (pending() !== undefined) return;

    setPending(configID);
    setActionError(undefined);
    try {
      const outcome = (await session.server.client.rpc(AcpSettings).setSessionOption(
        {
          sessionID: session.id,
          configID,
          value,
        },
        rpcOptions(session),
      )) as MutationResult;
      if (outcome.status !== "ok") setActionError(ctx.t(`error.${outcome.status}`));
    } catch {
      setActionError(ctx.t("error.saveFailed"));
    } finally {
      setPending(undefined);
      await refetch();
    }
  }

  return (
    <ctx.ui.SettingsSection
      title={ctx.t("session.title")}
      footer={
        <Show when={actionError()}>
          {(text: () => string) => (
            <span class="acp-error" role="alert">
              {text()}
            </span>
          )}
        </Show>
      }
    >
      <Show
        when={current()}
        fallback={<ctx.ui.SettingsRow title={ctx.t("session.empty")} description={ctx.t("session.emptyDescription")} />}
      >
        {(session: () => MountedSession) => (
          <Show
            when={view()}
            fallback={<ctx.ui.SettingsRow title={failed() ? ctx.t("session.failed") : ctx.t("loading")} />}
          >
            {(data: () => SessionOptionsView) => (
              <Show
                when={data().status === "ok"}
                fallback={<ctx.ui.SettingsRow title={ctx.t(`session.status.${data().status}`)} />}
              >
                <Show
                  when={data().options.length > 0}
                  fallback={<ctx.ui.SettingsRow title={ctx.t("session.noOptions")} />}
                >
                  <For each={data().options}>
                    {(option) => (
                      <ctx.ui.SettingsRow
                        title={option.id === "__mode" ? ctx.t("session.modeOption") : option.name}
                        description={
                          option.description ?? (option.category === "mode" ? ctx.t("session.mode") : undefined)
                        }
                      >
                        <Show
                          when={option.type === "select"}
                          fallback={
                            <ctx.ui.Switch
                              checked={option.current === true}
                              disabled={pending() !== undefined}
                              label={option.id === "__mode" ? ctx.t("session.modeOption") : option.name}
                              onChange={(checked) => void change(session(), option.id, checked)}
                            />
                          }
                        >
                          <ctx.ui.Select
                            label={option.id === "__mode" ? ctx.t("session.modeOption") : option.name}
                            value={typeof option.current === "string" ? option.current : undefined}
                            options={(option.values ?? []).map((item) => ({ label: item.name, value: item.value }))}
                            disabled={pending() !== undefined}
                            onChange={(value) => void change(session(), option.id, value)}
                          />
                        </Show>
                      </ctx.ui.SettingsRow>
                    )}
                  </For>
                </Show>
              </Show>
            )}
          </Show>
        )}
      </Show>
    </ctx.ui.SettingsSection>
  );
}

/** The RPC endpoint is location-scoped; route to the session's own location. */
function rpcOptions(session: MountedSession): { location: { directory: string } } | undefined {
  const directory = session.location?.directory;
  return directory === undefined ? undefined : { location: { directory } };
}
