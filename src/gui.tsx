import {
  For,
  Index,
  Show,
  createEffect,
  createMemo,
  createRenderEffect,
  createResource,
  createSignal,
  onCleanup,
} from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { DropdownMenu } from "@kobalte/core/dropdown-menu";
import { Plugin, SettingsPage, Style, usePlugin, type ServerRef } from "@opencode/plugin/gui";
import css from "./gui.css?inline";
import { LOG_LEVELS } from "./log.js";
import {
  AcpSettings,
  AGENT_ID,
  PRESETS,
  type AgentInput,
  type AgentView,
  type MutationResult,
  type SettingsView,
} from "./rpc.js";

const definition = Plugin.define({
  i18n: {
    en: {
      title: "ACP",
      description: "Manage the ACP agents that run on the selected server.",
      server: "Server",
      thisComputer: "This computer",
      manageServers: "Manage servers…",
      unreachable: "Unreachable",
      serverIncompatible: "Incompatible",
      loading: "Loading ACP settings…",
      offline: "Server is offline. Reconnect to manage its ACP agents.",
      incompatible: "This server version is incompatible with OpenCode Desktop.",
      unavailable: "The ACP plugin is not loaded on this server.",
      updatePlugin: "Update the ACP plugin on this server to manage its settings.",
      loadFailed: "Couldn't read ACP settings on this server.",
      agents: "Configured agents",
      empty: "No ACP agents configured on this server.",
      add: "Add agent",
      added: "Already added",
      custom: "Custom",
      addPreset: "Add {{name}}",
      addCustom: "Add custom agent",
      editAgent: "Edit {{name}}",
      runOn: "Runs on: {{server}}",
      name: "Display name",
      id: "Provider ID",
      idHint: "Use lowercase letters, numbers and hyphens. The ID stays fixed after saving.",
      command: "Executable",
      args: "Arguments",
      arg: "Argument {{number}}",
      addArg: "Add argument",
      removeArg: "Remove argument {{number}}",
      env: "Environment variables",
      envKey: "Name",
      envValue: "Value",
      envSaved: "Saved · enter a new value to replace it",
      addEnv: "Add environment variable",
      removeEnv: "Remove environment variable {{number}}",
      save: "Save",
      saveEnable: "Save and enable",
      cancel: "Cancel",
      edit: "Edit",
      enable: "Enable",
      disable: "Disable",
      retry: "Retry",
      remove: "Remove",
      more: "Actions for {{name}}",
      removeTitle: "Remove {{name}} from {{server}}?",
      removeDescription: "This deletes the agent configuration. Existing chat history is kept.",
      logLevel: "Log level",
      "status.disabled": "Disabled",
      "status.missing": "Executable not found",
      "status.discovering": "Discovering models",
      "status.ready": "Available",
      "status.failed": "Startup failed",
      modelCount: "Models: {{count}}",
      "failure.login": "Sign in to the CLI on this server, then retry.",
      "failure.exited": "The agent process exited.",
      "failure.spawn": "The server couldn't start the executable.",
      "failure.timeout": "The agent did not respond in time.",
      "failure.noModels": "The agent did not report any models.",
      "failure.discovery": "Couldn't discover models from the agent. Check the server log.",
      "error.busy": "This agent is in use. Wait for the current turn to finish and try again.",
      "error.conflict": "Settings changed elsewhere. Reopen the form with the latest settings.",
      changed: "Settings changed elsewhere. Review the updated list and try again.",
      "error.notFound": "This agent no longer exists.",
      "error.saveFailed": "Couldn't save the change on this server.",
      "error.duplicate": "This provider ID is already in use on the server.",
      "error.invalid": "Check the configuration and try again.",
      "field.id": "Enter a provider ID using lowercase letters, numbers and hyphens.",
      "field.name": "Enter a display name.",
      "field.command": "Enter an executable name or path.",
      "field.args": "Check the launch arguments.",
      "field.env": "Enter a unique environment variable name for each row.",
    },
    zh: {
      title: "ACP",
      description: "管理在所选服务器上运行的 ACP agent。",
      server: "服务器",
      thisComputer: "此电脑",
      manageServers: "管理服务器…",
      unreachable: "无法连接",
      serverIncompatible: "版本不兼容",
      loading: "正在加载 ACP 设置…",
      offline: "服务器已离线。重新连接后可管理 ACP agent。",
      incompatible: "此服务器版本与 OpenCode Desktop 不兼容。",
      unavailable: "此服务器未加载 ACP 插件。",
      updatePlugin: "请更新此服务器上的 ACP 插件后再管理配置。",
      loadFailed: "无法读取此服务器的 ACP 设置。",
      agents: "已配置的 Agent",
      empty: "此服务器还没有配置 ACP agent。",
      add: "添加 Agent",
      added: "已添加",
      custom: "自定义",
      addPreset: "添加 {{name}}",
      addCustom: "添加自定义 Agent",
      editAgent: "编辑 {{name}}",
      runOn: "运行位置：{{server}}",
      name: "显示名称",
      id: "Provider ID",
      idHint: "使用小写字母、数字和连字符，保存后不可修改。",
      command: "可执行文件",
      args: "启动参数",
      arg: "参数 {{number}}",
      addArg: "添加参数",
      removeArg: "移除参数 {{number}}",
      env: "环境变量",
      envKey: "名称",
      envValue: "值",
      envSaved: "已保存 · 输入新值可替换",
      addEnv: "添加环境变量",
      removeEnv: "移除环境变量 {{number}}",
      save: "保存",
      saveEnable: "保存并启用",
      cancel: "取消",
      edit: "编辑",
      enable: "启用",
      disable: "停用",
      retry: "重试",
      remove: "移除",
      more: "{{name}} 的更多操作",
      removeTitle: "从 {{server}} 移除 {{name}}？",
      removeDescription: "这会删除该 Agent 的配置，已有对话记录会保留。",
      logLevel: "日志级别",
      "status.disabled": "已停用",
      "status.missing": "找不到可执行文件",
      "status.discovering": "正在发现模型",
      "status.ready": "可用",
      "status.failed": "启动失败",
      modelCount: "{{count}} 个模型",
      "failure.login": "请在此服务器上登录 CLI，然后重试。",
      "failure.exited": "Agent 进程已退出。",
      "failure.spawn": "服务器无法启动该可执行文件。",
      "failure.timeout": "等待 Agent 响应超时。",
      "failure.noModels": "Agent 没有报告任何模型。",
      "failure.discovery": "无法发现模型，请查看此服务器的日志。",
      "error.busy": "此 Agent 正在使用，请等待当前轮结束后再试。",
      "error.conflict": "配置已在别处更新，请重新打开表单。",
      changed: "配置已在别处更新，请查看最新列表后重试。",
      "error.notFound": "此 Agent 已不存在。",
      "error.saveFailed": "无法在此服务器上保存更改。",
      "error.duplicate": "此服务器上的 Provider ID 已被使用。",
      "error.invalid": "请检查配置后重试。",
      "field.id": "请输入由小写字母、数字和连字符组成的 Provider ID。",
      "field.name": "请输入显示名称。",
      "field.command": "请输入可执行文件名或路径。",
      "field.args": "请检查启动参数。",
      "field.env": "每行请填写变量名，名称不能重复。",
    },
  },
});

export default Plugin.define({
  ...definition,
  setup(ctx) {
    ctx.add(Style, css);
    ctx.add(SettingsPage, {
      id: "acp",
      get title() {
        return ctx.t("title");
      },
      get entries() {
        return [{ id: "acp-log", title: ctx.t("logLevel"), keywords: "ACP log level" }];
      },
      render: () => <Settings />,
    });
  },
});

type Connection = { id: string; client: ServerRef["client"] };
type LoadError = "unavailable" | "updatePlugin" | "loadFailed";
type LoadResult = { connection: Connection; settings: SettingsView } | { connection: Connection; error: LoadError };

function ServerSwitcher(props: { ids: readonly string[]; selected?: string; onSelect(id: string): void }) {
  const ctx = usePlugin<typeof definition>();
  const server = () => ctx.servers.get(props.selected ?? "");
  const status = (server: ServerRef | undefined) => {
    if (server?.compatible === false) return "incompatible";
    return server?.connected ? "online" : "offline";
  };
  const statusText = (server: ServerRef | undefined) => {
    const state = status(server);
    if (state === "incompatible") return ctx.t("serverIncompatible");
    return state === "offline" ? ctx.t("unreachable") : undefined;
  };

  // The SDK's Menu only accepts text and leading icons. Use the same primitive as Providers for radio rows.
  return (
    <DropdownMenu placement="bottom-end" gutter={6} modal={false}>
      <DropdownMenu.Trigger
        class="acp-server-switcher"
        data-component="button-v2"
        data-variant="outline"
        data-size="small"
      >
        <span class="acp-server-dot" data-status={status(server())} aria-hidden="true" />
        <span class="acp-server-label">{ctx.t("server")}</span>
        <bdi class="acp-server-name">{server()?.name ?? props.selected}</bdi>
        <Show when={statusText(server())}>{(text: () => string) => <span class="sr-only">{text()}</span>}</Show>
        <ctx.ui.Icon name="chevron-down" class="acp-server-chevron" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Portal>
        <DropdownMenu.Content class="acp-server-menu" data-component="menu-v2-content" data-appearance="compact">
          <DropdownMenu.RadioGroup value={props.selected} onChange={props.onSelect}>
            <For each={props.ids}>
              {(id) => {
                const option = () => ctx.servers.get(id);
                const name = () => option()?.name ?? id;
                return (
                  <DropdownMenu.RadioItem
                    value={id}
                    textValue={name()}
                    closeOnSelect
                    data-component="menu-v2-item"
                    data-appearance="compact"
                  >
                    <span data-slot="menu-v2-item-content">
                      <span class="acp-server-dot" data-status={status(option())} aria-hidden="true" />
                      <span class="acp-server-option">
                        <bdi class="acp-server-name">{name()}</bdi>
                        <Show when={option()?.builtin}>
                          <span class="acp-server-label">· {ctx.t("thisComputer")}</span>
                        </Show>
                      </span>
                      <Show when={statusText(option())}>
                        {(text: () => string) => <span class="acp-server-status">{text()}</span>}
                      </Show>
                    </span>
                    <DropdownMenu.ItemIndicator forceMount data-slot="menu-v2-item-indicator">
                      <ctx.ui.Icon name="check" size="small" />
                    </DropdownMenu.ItemIndicator>
                  </DropdownMenu.RadioItem>
                );
              }}
            </For>
          </DropdownMenu.RadioGroup>
          <DropdownMenu.Separator data-slot="menu-v2-separator" data-appearance="compact" />
          <DropdownMenu.Item
            data-component="menu-v2-item"
            data-appearance="compact"
            onSelect={() => ctx.layout.settings("servers")}
          >
            <span data-slot="menu-v2-item-content">
              <ctx.ui.Icon name="server" class="acp-server-chevron" />
              {ctx.t("manageServers")}
            </span>
          </DropdownMenu.Item>
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu>
  );
}

function Settings() {
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
        return { connection: target, settings: settings as SettingsView };
      } catch (error) {
        const type = typeof error === "object" && error !== null && "type" in error ? error.type : undefined;
        return {
          connection: target,
          error:
            type === "rpc.unavailable"
              ? "unavailable"
              : type === "rpc.method_not_found"
                ? "updatePlugin"
                : "loadFailed",
        };
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
    request: (rpc: NonNullable<ReturnType<typeof rpcFor>>) => Promise<unknown>,
  ): Promise<MutationResult> {
    const rpc = rpcFor(id);
    if (rpc === undefined) return { status: "saveFailed" };
    try {
      return (await request(rpc)) as MutationResult;
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
        server={serverLabel(server)}
        preset={preset}
        agent={agent}
        close={dialog.close}
        save={(input) => run(id, (rpc) => rpc.saveAgent({ revision, create: agent === undefined, agent: input }))}
      />
    ));
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
                {(agent) => {
                  const target = () => ({ revision: current().revision, id: agent.id });
                  const command = () => [agent.command, ...agent.args].join(" ");
                  return (
                    <ctx.ui.SettingsRow
                      title={<bdi class="acp-agent-name">{agent.name}</bdi>}
                      description={
                        <>
                          <code class="acp-agent-command" title={command()} dir="auto">
                            {command()}
                          </code>
                          <Show when={agent.failure !== ""}>
                            <span class="acp-agent-failure">{ctx.t(`failure.${agent.failure}`)}</span>
                          </Show>
                        </>
                      }
                    >
                      <div class="acp-agent-actions">
                        <span class="acp-agent-status" data-status={agent.status} role="status">
                          <Show
                            when={agent.status === "discovering"}
                            fallback={<span class="acp-agent-dot" aria-hidden="true" />}
                          >
                            <ctx.ui.Loader size="small" class="acp-agent-loader" />
                          </Show>
                          {ctx.t(`status.${agent.status}`)}
                          {agent.modelCount > 0 ? ` · ${ctx.t("modelCount", { count: agent.modelCount })}` : ""}
                        </span>
                        <ctx.ui.Menu
                          label={ctx.t("more", { name: agent.name })}
                          disabled={pending() !== undefined}
                          items={[
                            {
                              label: ctx.t("edit"),
                              onSelect: () => {
                                const server = selected();
                                if (server !== undefined)
                                  openForm(server, current().revision, undefined, {
                                    ...agent,
                                    args: [...agent.args],
                                    envKeys: [...agent.envKeys],
                                  });
                              },
                            },
                            {
                              label: ctx.t(agent.enabled ? "disable" : "enable"),
                              onSelect: () => {
                                const id = selectedID();
                                if (id !== undefined)
                                  void act(id, (rpc) => rpc.setEnabled({ ...target(), enabled: !agent.enabled }));
                              },
                            },
                            ...(agent.status === "failed" || agent.status === "missing"
                              ? [
                                  {
                                    label: ctx.t("retry"),
                                    onSelect: () => {
                                      const id = selectedID();
                                      if (id !== undefined) void act(id, (rpc) => rpc.retryAgent(target()));
                                    },
                                  },
                                ]
                              : []),
                            { type: "separator" },
                            {
                              label: ctx.t("remove"),
                              onSelect: async () => {
                                const server = selected();
                                if (server === undefined) return;
                                const input = target();
                                const confirmed = await ctx.dialogs.confirm({
                                  title: ctx.t("removeTitle", { name: agent.name, server: serverLabel(server) }),
                                  description: ctx.t("removeDescription"),
                                  confirm: ctx.t("remove"),
                                  cancel: ctx.t("cancel"),
                                  danger: true,
                                });
                                if (confirmed) void act(server.id, (rpc) => rpc.removeAgent(input));
                              },
                            },
                          ]}
                        />
                      </div>
                    </ctx.ui.SettingsRow>
                  );
                }}
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

interface EnvRow {
  readonly key: string;
  readonly savedKey?: string;
  readonly value?: string;
}

function AgentForm(props: {
  server: string;
  preset?: AgentInput;
  agent?: AgentView;
  close(): void;
  save(input: AgentInput): Promise<MutationResult>;
}) {
  const ctx = usePlugin<typeof definition>();
  const initial = props.agent ?? props.preset;
  const [name, setName] = createSignal(initial?.name ?? "");
  const [id, setID] = createSignal(initial?.id ?? "");
  const [command, setCommand] = createSignal(initial?.command ?? "");
  const [args, setArgs] = createSignal([...(initial?.args ?? [])]);
  const [env, setEnv] = createSignal<EnvRow[]>((props.agent?.envKeys ?? []).map((key) => ({ key, savedKey: key })));
  const [saving, setSaving] = createSignal(false);
  const [error, setError] = createSignal<MutationResult>();
  const errorFor = (field: string) => {
    const current = error();
    if (current?.field !== field) return;
    return current.status === "duplicate" ? ctx.t("error.duplicate") : ctx.t(`field.${field}`);
  };

  async function save() {
    if (saving()) return;
    setError(undefined);
    const values = env().map(
      ({ key, savedKey, value }) => [key.trim(), value ?? (key.trim() === savedKey ? null : "")] as const,
    );
    const field = !name().trim()
      ? "name"
      : !AGENT_ID.test(id().trim())
        ? "id"
        : !command().trim()
          ? "command"
          : values.some(([key]) => !key) || new Set(values.map(([key]) => key)).size !== values.length
            ? "env"
            : undefined;
    if (field !== undefined) {
      setError({ status: "invalid", field });
      return;
    }

    setSaving(true);
    try {
      const outcome = await props.save({
        id: id().trim(),
        name: name().trim(),
        command: command().trim(),
        args: args(),
        env: Object.fromEntries(values),
      });
      if (outcome.status === "ok") props.close();
      else setError(outcome);
    } finally {
      setSaving(false);
    }
  }

  return (
    <ctx.ui.Dialog
      title={
        props.agent
          ? ctx.t("editAgent", { name: props.agent.name })
          : props.preset
            ? ctx.t("addPreset", { name: props.preset.name })
            : ctx.t("addCustom")
      }
      description={ctx.t("runOn", { server: props.server })}
      footer={
        <>
          <ctx.ui.Button variant="ghost" disabled={saving()} onClick={props.close}>
            {ctx.t("cancel")}
          </ctx.ui.Button>
          <ctx.ui.Button variant="contrast" busy={saving()} onClick={() => void save()}>
            {ctx.t(props.agent ? "save" : "saveEnable")}
          </ctx.ui.Button>
        </>
      }
    >
      <div class="acp-agent-form">
        <div class="acp-form-field">
          <label class="acp-form-label">
            {ctx.t("name")}
            <ctx.ui.TextInput
              label={ctx.t("name")}
              size="large"
              value={name()}
              onInput={setName}
              onSubmit={() => void save()}
              invalid={!!errorFor("name")}
              disabled={saving()}
              autofocus
            />
          </label>
          <Show when={errorFor("name")}>
            {(text: () => string) => (
              <span class="acp-error" role="alert">
                {text()}
              </span>
            )}
          </Show>
        </div>
        <Show when={!props.preset}>
          <div class="acp-form-field">
            <label class="acp-form-label">
              {ctx.t("id")}
              <ctx.ui.TextInput
                label={ctx.t("id")}
                size="large"
                value={id()}
                onInput={setID}
                onSubmit={() => void save()}
                invalid={!!errorFor("id")}
                disabled={!!props.agent || saving()}
              />
            </label>
            <Show when={errorFor("id")} fallback={<span class="acp-form-hint">{ctx.t("idHint")}</span>}>
              {(text: () => string) => (
                <span class="acp-error" role="alert">
                  {text()}
                </span>
              )}
            </Show>
          </div>
        </Show>
        <div class="acp-form-field">
          <label class="acp-form-label">
            {ctx.t("command")}
            <ctx.ui.TextInput
              label={ctx.t("command")}
              size="large"
              value={command()}
              onInput={setCommand}
              onSubmit={() => void save()}
              invalid={!!errorFor("command")}
              disabled={saving()}
            />
          </label>
          <Show when={errorFor("command")}>
            {(text: () => string) => (
              <span class="acp-error" role="alert">
                {text()}
              </span>
            )}
          </Show>
        </div>
        <fieldset class="acp-form-field acp-form-group">
          <legend>{ctx.t("args")}</legend>
          <Index each={args()}>
            {(arg, index) => (
              <div class="acp-form-row">
                <ctx.ui.TextInput
                  label={ctx.t("arg", { number: index + 1 })}
                  size="large"
                  value={arg()}
                  onInput={(value) => setArgs((list) => list.with(index, value))}
                  disabled={saving()}
                />
                <ctx.ui.IconButton
                  icon="trash"
                  label={ctx.t("removeArg", { number: index + 1 })}
                  disabled={saving()}
                  onClick={() => setArgs((list) => list.filter((_, i) => i !== index))}
                />
              </div>
            )}
          </Index>
          <ctx.ui.Button
            size="small"
            variant="ghost-muted"
            icon="plus"
            disabled={saving()}
            onClick={() => setArgs((list) => [...list, ""])}
          >
            {ctx.t("addArg")}
          </ctx.ui.Button>
          <Show when={errorFor("args")}>
            {(text: () => string) => (
              <span class="acp-error" role="alert">
                {text()}
              </span>
            )}
          </Show>
        </fieldset>
        <fieldset class="acp-form-field acp-form-group">
          <legend>{ctx.t("env")}</legend>
          <Index each={env()}>
            {(row, index) => (
              <div class="acp-form-row acp-form-row-env">
                <ctx.ui.TextInput
                  label={ctx.t("envKey")}
                  size="large"
                  placeholder={ctx.t("envKey")}
                  value={row().key}
                  onInput={(key) => setEnv((list) => list.with(index, { ...row(), key }))}
                  disabled={saving()}
                />
                <ctx.ui.TextInput
                  label={ctx.t("envValue")}
                  type="password"
                  size="large"
                  placeholder={row().savedKey === row().key ? ctx.t("envSaved") : ctx.t("envValue")}
                  value={row().value ?? ""}
                  onInput={(value) => setEnv((list) => list.with(index, { ...row(), value }))}
                  disabled={saving()}
                />
                <ctx.ui.IconButton
                  icon="trash"
                  label={ctx.t("removeEnv", { number: index + 1 })}
                  disabled={saving()}
                  onClick={() => setEnv((list) => list.filter((_, i) => i !== index))}
                />
              </div>
            )}
          </Index>
          <ctx.ui.Button
            size="small"
            variant="ghost-muted"
            icon="plus"
            disabled={saving()}
            onClick={() => setEnv((list) => [...list, { key: "" }])}
          >
            {ctx.t("addEnv")}
          </ctx.ui.Button>
          <Show when={errorFor("env")}>
            {(text: () => string) => (
              <span class="acp-error" role="alert">
                {text()}
              </span>
            )}
          </Show>
        </fieldset>
        <Show when={error()?.field === undefined && error() !== undefined}>
          <span class="acp-error" role="alert">
            {ctx.t(`error.${error()?.status}`)}
          </span>
        </Show>
      </div>
    </ctx.ui.Dialog>
  );
}
