import { For, Show, createResource } from "solid-js"
import { Plugin, SettingsPage } from "@opencode/plugin/gui"
import type { Diagnostics } from "./diagnostics.js"
import { AcpSettings } from "./rpc.js"

/** The settings page reads agent state from whichever server loaded the plugin. */
export default Plugin.define({
  i18n: {
    en: {
      title: "ACP agents",
      description: "External agents exposed through the Agent Client Protocol.",
      agents: "Agents",
      plugin: "Plugin",
      loading: "Reading agent status…",
      unavailable: "The plugin is not running on a connected server.",
      model: "Default model",
      models: "Models",
      context: "Context window",
      process: "Process",
      running: "running",
      stopped: "stopped",
      logLevel: "Log level",
      contextOverride: "Context override",
      yes: "yes",
      no: "no",
      refresh: "Refresh",
      version: "version",
      path: "path",
      notFound: "not found",
      "status.ready": "Available",
      "status.missing": "Not installed",
      "status.disabled": "Disabled",
      "status.deferred": "Not implemented yet",
      "usage.tokens": "tokens",
      "usage.inherit": "learned from the agent",
      "usage.override": "configured",
    },
    zh: {
      title: "ACP agent",
      description: "通过 Agent Client Protocol 接入的外部 agent。",
      agents: "Agent 列表",
      plugin: "插件",
      loading: "正在读取 agent 状态…",
      unavailable: "已连接的 server 上没有运行该插件。",
      model: "默认模型",
      models: "模型",
      context: "上下文窗口",
      process: "进程",
      running: "运行中",
      stopped: "未运行",
      logLevel: "日志级别",
      contextOverride: "上下文覆盖",
      yes: "是",
      no: "否",
      refresh: "刷新",
      version: "版本",
      path: "路径",
      notFound: "未找到",
      "status.ready": "可用",
      "status.missing": "未安装",
      "status.disabled": "已禁用",
      "status.deferred": "暂未接入",
      "usage.tokens": "tokens",
      "usage.inherit": "从 agent 学习",
      "usage.override": "配置覆盖",
    },
  },
  setup(ctx) {
    const [data, { refetch }] = createResource(
      () => ctx.servers.list().join(","),
      async () => {
        for (const id of ctx.servers.list()) {
          const server = ctx.servers.get(id)
          if (server === undefined) continue

          try {
            return (await server.client.rpc(AcpSettings).read({})) as Diagnostics
          } catch {
            // The plugin may be loaded on another server; try the next one.
          }
        }

        return undefined
      },
    )

    const number = (value: number) => new Intl.NumberFormat(ctx.locale.locale()).format(value)

    ctx.add(SettingsPage, {
      id: "acp",
      title: ctx.t("title"),
      render: () => (
        <ctx.ui.SettingsLayout
          title={ctx.t("title")}
          description={ctx.t("description")}
          actions={
            <ctx.ui.Button variant="ghost-muted" onClick={() => void refetch()}>
              {ctx.t("refresh")}
            </ctx.ui.Button>
          }
        >
          <Show
            when={data()}
            fallback={
              <ctx.ui.SettingsSection>
                <ctx.ui.SettingsRow
                  id="acp-loading"
                  title={data.loading ? ctx.t("loading") : ctx.t("unavailable")}
                />
              </ctx.ui.SettingsSection>
            }
          >
            {(diagnostics: () => Diagnostics) => (
              <>
                <ctx.ui.SettingsSection title={ctx.t("agents")}>
                  <For each={diagnostics().agents}>
                    {(agent) => (
                      <ctx.ui.SettingsRow
                        id={`acp-${agent.id}`}
                        title={agent.name}
                        description={
                          <span>
                            {[agent.command, ...agent.args].join(" ")}
                            {agent.installed
                              ? ` · ${ctx.t("version")} ${agent.version || "?"} · ${agent.path}`
                              : ` · ${ctx.t("notFound")}`}
                          </span>
                        }
                      >
                        <span>
                          {ctx.t(`status.${agent.status}`)}
                          {agent.note === "" ? "" : ` — ${agent.note}`}
                        </span>
                      </ctx.ui.SettingsRow>
                    )}
                  </For>
                </ctx.ui.SettingsSection>

                <ctx.ui.SettingsSection title={ctx.t("plugin")}>
                  <For each={diagnostics().agents}>
                    {(agent) => (
                      <ctx.ui.SettingsRow
                        id={`acp-model-${agent.id}`}
                        title={`${agent.name} · ${ctx.t("model")}`}
                        description={[
                          agent.defaultModel || ctx.t("notFound"),
                          agent.models.length === 0 ? "" : `${agent.models.length} ${ctx.t("models")}`,
                        ]
                          .filter((item) => item.length > 0)
                          .join(" · ")}
                      >
                        <span>
                          {ctx.t("context")}: {number(agent.contextLimit)} {ctx.t("usage.tokens")}
                          {agent.running
                            ? ` · ${ctx.t("process")}: ${ctx.t("running")} (${agent.pid})`
                            : ` · ${ctx.t("process")}: ${ctx.t("stopped")}`}
                          {agent.lastFailure === "" ? "" : ` · ${agent.lastFailure}`}
                        </span>
                      </ctx.ui.SettingsRow>
                    )}
                  </For>

                  <ctx.ui.SettingsRow id="acp-log" title={ctx.t("logLevel")}>
                    <span>{diagnostics().plugin.logLevel}</span>
                  </ctx.ui.SettingsRow>
                  <ctx.ui.SettingsRow id="acp-context" title={ctx.t("contextOverride")}>
                    <span>
                      {diagnostics().plugin.contextLimit === 0
                        ? ctx.t("usage.inherit")
                        : `${number(diagnostics().plugin.contextLimit)} ${ctx.t("usage.tokens")} (${ctx.t("usage.override")})`}
                    </span>
                  </ctx.ui.SettingsRow>
                </ctx.ui.SettingsSection>

                <Show when={diagnostics().note !== ""}>
                  <ctx.ui.SettingsSection>
                    <ctx.ui.SettingsRow id="acp-note" title={diagnostics().note} />
                  </ctx.ui.SettingsSection>
                </Show>
              </>
            )}
          </Show>
        </ctx.ui.SettingsLayout>
      ),
    })
  },
})
