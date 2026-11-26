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
  onMount,
} from "solid-js";
import { createStore, reconcile } from "solid-js/store";
import { DropdownMenu } from "@kobalte/core/dropdown-menu";
import { Command, Plugin, SettingsPage, Style, usePlugin, type ServerRef } from "@opencode/plugin/gui";
import css from "./gui.css?inline";
import { LOG_LEVELS } from "./log.js";
import {
  AcpSettings,
  AGENT_ID,
  PRESETS,
  type AgentInput,
  type AgentView,
  type ImportableAgent,
  type ImportableSession,
  type ImportableView,
  type MutationResult,
  type PrepareImportResult,
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
      "import.command": "Import ACP session",
      "import.commandDescription": "Import an existing session from an ACP agent",
      "import.title": "Import ACP session",
      "import.description": "Choose an existing session in an ACP agent that is not yet bound to OpenCode.",
      "import.search": "Search title, agent or directory",
      "import.loading": "Reading ACP sessions…",
      "import.empty": "No sessions to import.",
      "import.untitled": "Untitled session",
      "import.cancel": "Cancel",
      "import.refresh": "Refresh",
      "import.directoryMissing": "Directory missing",
      "import.noServers": "No connected server is available.",
      "import.serverFailed": "Could not read ACP sessions from: {{servers}}",
      "import.agentNote": "{{agent}} on {{server}}: {{reason}}",
      "import.reason.disabled": "disabled",
      "import.reason.notRunning": "not running",
      "import.reason.discovering": "discovering models",
      "import.reason.failed": "startup failed",
      "import.reason.noList": "does not list sessions",
      "import.reason.noLoad": "cannot load sessions",
      "import.reason.listFailed": "could not list sessions",
      "import.reason.storageFailed": "could not read session bindings",
      "import.reason.busy": "busy",
      "import.reason.noModels": "no models",
      "import.age.now": "just now",
      "import.age.minutes.one": "{{count}} minute ago",
      "import.age.minutes.other": "{{count}} minutes ago",
      "import.age.hours.one": "{{count}} hour ago",
      "import.age.hours.other": "{{count}} hours ago",
      "import.age.days.one": "{{count}} day ago",
      "import.age.days.other": "{{count}} days ago",
      "import.error.notFound": "This ACP session no longer exists.",
      "import.error.unsupported": "This agent cannot list or load sessions.",
      "import.error.unavailable": "This agent is not available. Check Settings › ACP.",
      "import.error.alreadyBound": "This ACP session is already bound to an OpenCode session.",
      "import.error.loadFailed": "Could not load this ACP session. Its history was not imported.",
      "import.error.saveFailed": "Could not save the session binding.",
      "import.error.directoryMissing": "The ACP session's working directory is not available on this server.",
      "import.error.updatePlugin": "Update the ACP plugin on this server to import sessions.",
      "import.error.updateOpenCode": "This OpenCode version does not support session import.",
      "import.error.importFailed": "Could not import the session history.",
      "import.error.requestFailed": "The request failed. Try again.",
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
      "import.command": "导入 ACP 会话",
      "import.commandDescription": "从 ACP agent 中导入已有会话",
      "import.title": "导入 ACP 会话",
      "import.description": "选择 ACP agent 中已有但尚未绑定到 OpenCode 的会话。",
      "import.search": "搜索标题、agent 或目录",
      "import.loading": "正在读取 ACP 会话…",
      "import.empty": "没有可导入的会话。",
      "import.untitled": "未命名会话",
      "import.cancel": "取消",
      "import.refresh": "刷新",
      "import.directoryMissing": "目录不存在",
      "import.noServers": "没有可用的服务器。",
      "import.serverFailed": "无法读取以下服务器的 ACP 会话：{{servers}}",
      "import.agentNote": "{{server}} 上的 {{agent}}：{{reason}}",
      "import.reason.disabled": "已停用",
      "import.reason.notRunning": "未运行",
      "import.reason.discovering": "正在发现模型",
      "import.reason.failed": "启动失败",
      "import.reason.noList": "不支持列出会话",
      "import.reason.noLoad": "不支持恢复会话",
      "import.reason.listFailed": "无法列出会话",
      "import.reason.storageFailed": "无法读取会话绑定",
      "import.reason.busy": "正在使用",
      "import.reason.noModels": "没有可用模型",
      "import.age.now": "刚刚",
      "import.age.minutes.one": "{{count}} 分钟前",
      "import.age.minutes.other": "{{count}} 分钟前",
      "import.age.hours.one": "{{count}} 小时前",
      "import.age.hours.other": "{{count}} 小时前",
      "import.age.days.one": "{{count}} 天前",
      "import.age.days.other": "{{count}} 天前",
      "import.error.notFound": "这个 ACP 会话已不存在。",
      "import.error.unsupported": "该 agent 不支持列出或恢复会话。",
      "import.error.unavailable": "该 agent 当前不可用，请在 Settings › ACP 中检查。",
      "import.error.alreadyBound": "这个 ACP 会话已绑定到另一个 OpenCode 会话。",
      "import.error.loadFailed": "无法加载该 ACP 会话，历史未导入。",
      "import.error.saveFailed": "无法保存会话绑定。",
      "import.error.directoryMissing": "该 ACP 会话的工作目录在服务器上不存在。",
      "import.error.updatePlugin": "请更新此服务器上的 ACP 插件后再导入。",
      "import.error.updateOpenCode": "当前 OpenCode 版本不支持导入会话历史。",
      "import.error.importFailed": "无法导入会话历史。",
      "import.error.requestFailed": "请求失败，请重试。",
    },
  },
});

export default Plugin.define({
  ...definition,
  setup(ctx) {
    ctx.add(Style, css);
    ctx.add(Command, () => ({
      id: "import-session",
      get title() {
        return ctx.t("import.command");
      },
      get description() {
        return ctx.t("import.commandDescription");
      },
      keywords: "ACP import session 导入 会话",
      get group() {
        return ctx.t("title");
      },
      run() {
        ctx.dialogs.open((dialog) => <ImportSessions close={dialog.close} />);
      },
    }));
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

type ImportRow = ImportableSession & { server: ServerRef; key: string };
type AgentNote = ImportableAgent & { server: ServerRef; key: string };

const importRowKey = (row: ImportRow) => row.key;

function ImportSessions(props: { close(): void }) {
  const ctx = usePlugin<typeof definition>();
  const [query, setQuery] = createSignal("");
  const [rows, setRows] = createStore<ImportRow[]>([]);
  const [agents, setAgents] = createStore<AgentNote[]>([]);
  const [loading, setLoading] = createSignal(true);
  const [error, setError] = createSignal<string>();
  const [pending, setPending] = createSignal<string>();
  const [now, setNow] = createSignal(Date.now());
  const controller = new AbortController();

  onCleanup(() => controller.abort());
  onMount(() => {
    void load();
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    onCleanup(() => clearInterval(timer));
  });

  const targets = () =>
    ctx.servers
      .list()
      .map((id) => ctx.servers.get(id))
      .filter((server): server is ServerRef => server !== undefined && server.connected && server.compatible);

  const names = createMemo(() => new Map(agents.map((agent) => [`${agent.server.id}\0${agent.id}`, agent.name])));
  const nameOf = (serverID: string, agentID: string) => names().get(`${serverID}\0${agentID}`) ?? agentID;

  const filtered = createMemo(() => {
    const needle = query().trim().toLowerCase();
    if (needle.length === 0) return rows;
    return rows.filter((row) =>
      [row.title, row.cwd, row.server.name, nameOf(row.server.id, row.agentID)].some((value) =>
        value.toLowerCase().includes(needle),
      ),
    );
  });

  const notes = createMemo(() => agents.filter((agent) => agent.status !== "ready"));

  const reasonText = (reason: string) => {
    const failures = new Set(["login", "exited", "timeout", "spawn", "discovery", "noModels"]);
    return failures.has(reason) ? ctx.t(`failure.${reason}`) : ctx.t(`import.reason.${reason}`);
  };

  const relativeTime = (value: string) => {
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) return "";
    const seconds = Math.max(0, Math.floor((now() - parsed) / 1000));
    if (seconds < 60) return ctx.t("import.age.now");
    if (seconds < 3600) return ctx.plural("import.age.minutes", Math.floor(seconds / 60));
    if (seconds < 86_400) return ctx.plural("import.age.hours", Math.floor(seconds / 3600));
    return ctx.plural("import.age.days", Math.floor(seconds / 86_400));
  };

  async function load() {
    setLoading(true);
    setError(undefined);

    const servers = targets();
    if (servers.length === 0) {
      setRows([]);
      setAgents([]);
      setError(ctx.t("import.noServers"));
      setLoading(false);
      return;
    }

    const results = await Promise.allSettled(
      servers.map(async (server) => ({
        server,
        view: (await server.client
          .rpc(AcpSettings)
          .importableSessions({}, { signal: AbortSignal.timeout(60_000) })) as ImportableView,
      })),
    );
    if (controller.signal.aborted) return;

    const nextRows: ImportRow[] = [];
    const nextAgents: AgentNote[] = [];
    const failed: string[] = [];

    for (let index = 0; index < results.length; index++) {
      const result = results[index];
      const server = servers[index];
      if (result === undefined || server === undefined) continue;
      if (result.status === "rejected") {
        failed.push(server.name);
        continue;
      }
      for (const agent of result.value.view.agents) {
        nextAgents.push({ ...agent, server, key: `${server.id}\0${agent.id}` });
      }
      for (const session of result.value.view.sessions) {
        nextRows.push({
          ...session,
          server,
          key: `${server.id}\0${session.agentID}\0${session.id}`,
        });
      }
    }

    setRows(reconcile(nextRows, { key: "key" }));
    setAgents(reconcile(nextAgents, { key: "key" }));
    if (failed.length > 0) setError(ctx.t("import.serverFailed", { servers: failed.join(", ") }));
    setLoading(false);
  }

  async function importRow(row: ImportRow) {
    if (pending() !== undefined || !row.available) return;

    const key = importRowKey(row);
    setPending(key);
    setError(undefined);

    let prepared: PrepareImportResult | undefined;
    try {
      const rpc = row.server.client.rpc(AcpSettings);
      prepared = (await rpc.prepareImport(
        { agentID: row.agentID, sessionID: row.id },
        { signal: AbortSignal.timeout(120_000) },
      )) as PrepareImportResult;

      if (prepared.status !== "ok" || prepared.payload === undefined) {
        setError(
          prepared.status === "ok"
            ? ctx.t("import.error.importFailed")
            : prepared.status === "notFound" && prepared.reason === "directoryMissing"
              ? ctx.t("import.error.directoryMissing")
              : ctx.t(`import.error.${prepared.status}`),
        );
        if (prepared.status === "alreadyBound" || prepared.status === "notFound") void load();
        return;
      }

      if (controller.signal.aborted) {
        await rpc
          .abortImport({
            agentID: row.agentID,
            sessionID: row.id,
            opencodeSessionID: prepared.sessionID,
          })
          .catch(() => undefined);
        return;
      }

      const importer = row.server.client.experimental?.session?.import;
      if (typeof importer !== "function") {
        await rpc
          .abortImport({
            agentID: row.agentID,
            sessionID: row.id,
            opencodeSessionID: prepared.sessionID,
          })
          .catch(() => undefined);
        setError(ctx.t("import.error.updateOpenCode"));
        return;
      }

      try {
        await row.server.client.experimental.session.import(prepared.payload as never, {
          signal: AbortSignal.timeout(60_000),
        });
      } catch {
        await rpc
          .abortImport({
            agentID: row.agentID,
            sessionID: row.id,
            opencodeSessionID: prepared.sessionID,
          })
          .catch(() => undefined);
        setError(ctx.t("import.error.importFailed"));
        return;
      }

      if (controller.signal.aborted) return;
      ctx.tabs.open({ server: row.server.id, id: prepared.sessionID }, { focus: true });
      props.close();
    } catch (cause) {
      if (controller.signal.aborted) return;
      const type = typeof cause === "object" && cause !== null && "type" in cause ? cause.type : undefined;
      setError(
        type === "rpc.method_not_found" ? ctx.t("import.error.updatePlugin") : ctx.t("import.error.requestFailed"),
      );
    } finally {
      setPending(undefined);
    }
  }

  return (
    <ctx.ui.Dialog
      title={ctx.t("import.title")}
      description={ctx.t("import.description")}
      size="large"
      footer={
        <>
          <ctx.ui.Button variant="ghost" disabled={pending() !== undefined} onClick={props.close}>
            {ctx.t("import.cancel")}
          </ctx.ui.Button>
          <ctx.ui.Button
            variant="neutral"
            icon="refresh"
            busy={loading()}
            disabled={loading() || pending() !== undefined}
            onClick={() => void load()}
          >
            {ctx.t("import.refresh")}
          </ctx.ui.Button>
        </>
      }
    >
      <div class="acp-import">
        <ctx.ui.TextInput
          label={ctx.t("import.search")}
          placeholder={ctx.t("import.search")}
          value={query()}
          onInput={setQuery}
          autofocus
        />
        <Show when={loading()}>
          <div class="acp-import-state" role="status">
            <ctx.ui.Loader size="small" />
            {ctx.t("import.loading")}
          </div>
        </Show>
        <Show when={!loading()}>
          <Show when={error()}>
            {(text: () => string) => (
              <span class="acp-error" role="alert">
                {text()}
              </span>
            )}
          </Show>
          <Show when={filtered().length > 0} fallback={<div class="acp-import-state">{ctx.t("import.empty")}</div>}>
            <div class="acp-import-list" role="list">
              <For each={filtered()}>
                {(row) => {
                  const key = importRowKey(row);
                  return (
                    <button
                      type="button"
                      class="acp-import-row"
                      role="listitem"
                      disabled={pending() !== undefined || !row.available}
                      onClick={() => void importRow(row)}
                    >
                      <span class="acp-import-main">
                        <span class="acp-import-title" dir="auto">
                          {row.title || ctx.t("import.untitled")}
                        </span>
                        <span class="acp-import-meta-line">
                          <span class="acp-import-server">{row.server.name}</span>
                          <span class="acp-import-agent">{nameOf(row.server.id, row.agentID)}</span>
                          <span class="acp-import-cwd" dir="ltr">
                            {row.cwd}
                          </span>
                        </span>
                      </span>
                      <span class="acp-import-side">
                        <Show
                          when={row.available}
                          fallback={<span class="acp-import-missing">{ctx.t("import.directoryMissing")}</span>}
                        >
                          <Show
                            when={pending() === key}
                            fallback={<span class="acp-import-time">{relativeTime(row.updatedAt)}</span>}
                          >
                            <ctx.ui.Loader size="small" />
                          </Show>
                        </Show>
                      </span>
                    </button>
                  );
                }}
              </For>
            </div>
          </Show>
          <Show when={notes().length > 0}>
            <div class="acp-import-notes">
              <For each={notes()}>
                {(agent) => (
                  <p class="acp-import-note">
                    {ctx.t("import.agentNote", {
                      server: agent.server.name,
                      agent: agent.name,
                      reason: reasonText(agent.reason),
                    })}
                  </p>
                )}
              </For>
            </div>
          </Show>
        </Show>
      </div>
    </ctx.ui.Dialog>
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
