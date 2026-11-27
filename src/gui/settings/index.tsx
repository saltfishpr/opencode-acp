import { usePlugin, type ServerRef } from "@opencode/plugin/gui";
import {
  For,
  Show,
  createEffect,
  createMemo,
  createRenderEffect,
  createResource,
  createSignal,
  onCleanup,
} from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { LOG_LEVELS } from "../../log.js";
import {
  AcpSettings,
  PRESETS,
  type AgentInput,
  type AgentView,
  type MutationResult,
  type SettingsView,
} from "../../rpc.js";
import { definition } from "../definition.js";
import { ServerSwitcher } from "../shared/server-switcher.js";
import { AgentForm } from "./agent-form.js";
import { AgentRow } from "./agent-row.js";
import { SessionOptions } from "./session-options.js";

type Connection = { id: string; client: ServerRef["client"] };
type LoadError = "unavailable" | "updatePlugin" | "loadFailed";
type LoadResult = { connection: Connection; settings: SettingsView } | { connection: Connection; error: LoadError };

export function Settings() {
  const ctx = usePlugin<typeof definition>();
  const [selection, selectServer] = createSignal(ctx.sessions.current()?.server.id);
  const ids = () => ctx.servers.list();
  const selectedID = () => {
    const id = selection();
    const available = ids();
    if (id !== undefined && available.includes(id)) return id;
    return available.find((id) => ctx.servers.get(id)?.builtin) ?? available[0];
  };
  const selected = () => ctx.servers.get(selectedID() ?? "");
  const connection = createMemo<Connection | undefined>((previous) => {
    const server = selected();
    if (!server?.connected || !server.compatible) return undefined;
    const client = server.client;
    return previous?.id === server.id && previous.client === client ? previous : { id: server.id, client };
  });
  const [resource, { refetch }] = createResource(
    () => connection() ?? false,
    async (target): Promise<LoadResult> => {
      try {
        const settings = await target.client.rpc(AcpSettings).settings({}, { signal: AbortSignal.timeout(10_000) });
        return { connection: target, settings };
      } catch (error) {
        const type = typeof error === "object" && error !== null && "type" in error ? error.type : undefined;
        let loadError: LoadError = "loadFailed";
        if (type === "rpc.unavailable") loadError = "unavailable";
        else if (type === "rpc.method_not_found") loadError = "updatePlugin";
        return { connection: target, error: loadError };
      }
    },
  );
  const result = () => (resource.latest?.connection === connection() ? resource.latest : undefined);
  const settings = () => {
    const current = result();
    return current && "settings" in current ? current.settings : undefined;
  };
  const [agents, setAgents] = createStore<AgentView[]>([]);
  createRenderEffect(() => setAgents(reconcile([...(settings()?.agents ?? [])], { key: "id" })));

  createEffect(() => {
    if (connection() === undefined) return;
    const current = settings();
    const interval =
      current === undefined || current.agents.some((agent) => agent.status === "discovering") ? 1000 : 5000;
    const timer = setInterval(() => {
      if (!resource.loading) void refetch();
    }, interval);
    onCleanup(() => clearInterval(timer));
  });

  const [pending, setPending] = createSignal<string>();
  const [actionError, setActionError] = createSignal<{ id: string; text: string }>();
  const serverLabel = (server: ServerRef) =>
    server.builtin ? `${server.name} · ${ctx.t("thisComputer")}` : server.name;
  const statusMessage = () => {
    const server = selected();
    if (server === undefined) return ids().length === 0 ? undefined : ctx.t("offline");
    if (!server.compatible) return ctx.t("incompatible");
    if (!server.connected) return ctx.t("offline");
    const current = result();
    return current && "error" in current ? ctx.t(current.error) : undefined;
  };

  function rpcFor(id: string) {
    const server = ctx.servers.get(id);
    if (!server?.connected || !server.compatible) return;
    return server.client.rpc(AcpSettings);
  }

  async function run(
    id: string,
    request: (rpc: NonNullable<ReturnType<typeof rpcFor>>) => Promise<MutationResult>,
  ): Promise<MutationResult> {
    const rpc = rpcFor(id);
    if (rpc === undefined) return { status: "saveFailed" };
    try {
      return await request(rpc);
    } catch {
      return { status: "saveFailed" };
    } finally {
      if (selectedID() === id) await refetch();
    }
  }

  async function act(id: string, request: Parameters<typeof run>[1]) {
    if (pending() !== undefined) return;
    setPending(id);
    setActionError(undefined);
    try {
      const outcome = await run(id, request);
      if (outcome.status !== "ok")
        setActionError({
          id,
          text: outcome.status === "conflict" ? ctx.t("changed") : ctx.t(`error.${outcome.status}`),
        });
    } finally {
      setPending(undefined);
    }
  }

  function openForm(server: ServerRef, revision: number, preset?: AgentInput, agent?: AgentView) {
    const id = server.id;
    if (selectedID() !== id || pending() !== undefined) return;
    ctx.dialogs.open((dialog) => (
      <AgentForm
        preset={preset}
        agent={agent}
        close={dialog.close}
        save={(input) => run(id, (rpc) => rpc.saveAgent({ revision, create: agent === undefined, agent: input }))}
      />
    ));
  }

  async function removeAgent(server: ServerRef, agent: AgentView, revision: number) {
    const confirmed = await ctx.dialogs.confirm({
      title: ctx.t("removeTitle", { name: agent.name, server: serverLabel(server) }),
      description: ctx.t("removeDescription"),
      confirm: ctx.t("remove"),
      cancel: ctx.t("cancel"),
      danger: true,
    });
    if (confirmed) void act(server.id, (rpc) => rpc.removeAgent({ revision, id: agent.id }));
  }

  return (
    <ctx.ui.SettingsLayout
      title={ctx.t("title")}
      description={ctx.t("description")}
      actions={
        <Show when={ids().length > 1}>
          <ServerSwitcher
            ids={ids()}
            selected={selectedID()}
            onSelect={(id) => {
              selectServer(id);
              setActionError(undefined);
            }}
          />
        </Show>
      }
    >
      <section class="settings-section acp-agents" aria-label={ctx.t("agents")}>
        <div class="acp-agents-heading">
          <h3 class="settings-section-title">{ctx.t("agents")}</h3>
          <ctx.ui.Menu
            trigger="button"
            icon="plus"
            label={ctx.t("add")}
            disabled={settings() === undefined || pending() !== undefined}
            items={[
              ...PRESETS.map((preset) => {
                const added = settings()?.agents.some(({ id }) => id === preset.id) === true;
                return {
                  label: added ? `${preset.name} · ${ctx.t("added")}` : preset.name,
                  disabled: added,
                  onSelect() {
                    const server = selected();
                    const current = settings();
                    if (server !== undefined && current !== undefined) openForm(server, current.revision, preset);
                  },
                };
              }),
              { type: "separator" },
              {
                label: ctx.t("custom"),
                onSelect() {
                  const server = selected();
                  const current = settings();
                  if (server !== undefined && current !== undefined) openForm(server, current.revision);
                },
              },
            ]}
          />
        </div>
        <div data-component="settings-list" data-variant="catalog">
          <Show
            when={settings()}
            fallback={
              <div class="acp-agents-message" role="status">
                <Show
                  when={statusMessage()}
                  fallback={
                    <>
                      <ctx.ui.Loader size="small" />
                      {ctx.t("loading")}
                    </>
                  }
                >
                  {(text: () => string) => text()}
                </Show>
              </div>
            }
          >
            {(current: () => SettingsView) => (
              <For each={agents} fallback={<div class="acp-agents-message">{ctx.t("empty")}</div>}>
                {(agent) => (
                  <AgentRow
                    agent={agent}
                    pending={pending() !== undefined}
                    onEdit={() => {
                      const server = selected();
                      if (server !== undefined)
                        openForm(server, current().revision, undefined, {
                          ...agent,
                          args: [...agent.args],
                          envKeys: [...agent.envKeys],
                        });
                    }}
                    onToggle={() => {
                      const id = selectedID();
                      if (id !== undefined)
                        void act(id, (rpc) =>
                          rpc.setEnabled({ revision: current().revision, id: agent.id, enabled: !agent.enabled }),
                        );
                    }}
                    onRetry={() => {
                      const id = selectedID();
                      if (id !== undefined)
                        void act(id, (rpc) => rpc.retryAgent({ revision: current().revision, id: agent.id }));
                    }}
                    onRemove={() => {
                      const server = selected();
                      if (server !== undefined) void removeAgent(server, agent, current().revision);
                    }}
                  />
                )}
              </For>
            )}
          </Show>
        </div>
        <Show when={actionError()?.id === selectedID() ? actionError()?.text : undefined}>
          {(text: () => string) => (
            <span class="acp-error" role="alert">
              {text()}
            </span>
          )}
        </Show>
      </section>
      <SessionOptions />
      <Show when={settings()}>
        {(current: () => SettingsView) => (
          <ctx.ui.SettingsSection>
            <ctx.ui.SettingsRow id="acp-log" title={ctx.t("logLevel")}>
              <ctx.ui.Select
                label={ctx.t("logLevel")}
                value={current().logLevel}
                options={LOG_LEVELS.map((level) => ({ label: level, value: level }))}
                disabled={pending() !== undefined}
                onChange={(logLevel) => {
                  const id = selectedID();
                  if (id !== undefined)
                    void act(id, (rpc) => rpc.setLogLevel({ revision: current().revision, logLevel }));
                }}
              />
            </ctx.ui.SettingsRow>
          </ctx.ui.SettingsSection>
        )}
      </Show>
    </ctx.ui.SettingsLayout>
  );
}
