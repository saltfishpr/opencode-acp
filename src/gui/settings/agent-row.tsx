import { usePlugin } from "@opencode/plugin/gui";
import { Show } from "solid-js";
import type { AgentView } from "../../rpc.js";
import { definition } from "../definition.js";

export function AgentRow(props: {
  agent: AgentView;
  pending: boolean;
  onEdit(): void;
  onToggle(): void;
  onRetry(): void;
  onRemove(): void;
}) {
  const ctx = usePlugin<typeof definition>();
  const command = () => [props.agent.command, ...props.agent.args].join(" ");

  return (
    <ctx.ui.SettingsRow
      title={<bdi class="acp-agent-name">{props.agent.name}</bdi>}
      description={
        <>
          <code class="acp-agent-command" title={command()} dir="auto">
            {command()}
          </code>
          <Show when={props.agent.failure !== ""}>
            <span class="acp-agent-failure">{ctx.t(`failure.${props.agent.failure}`)}</span>
          </Show>
        </>
      }
    >
      <div class="acp-agent-actions">
        <span class="acp-agent-status" data-status={props.agent.status} role="status">
          <Show
            when={props.agent.status === "discovering"}
            fallback={<span class="acp-agent-dot" aria-hidden="true" />}
          >
            <ctx.ui.Loader size="small" class="acp-agent-loader" />
          </Show>
          {ctx.t(`status.${props.agent.status}`)}
          {props.agent.modelCount > 0 ? ` · ${ctx.t("modelCount", { count: props.agent.modelCount })}` : ""}
        </span>
        <ctx.ui.Menu
          label={ctx.t("more", { name: props.agent.name })}
          disabled={props.pending}
          items={[
            { label: ctx.t("edit"), onSelect: props.onEdit },
            {
              label: ctx.t(props.agent.enabled ? "disable" : "enable"),
              onSelect: props.onToggle,
            },
            ...(props.agent.status === "failed" || props.agent.status === "missing"
              ? [{ label: ctx.t("retry"), onSelect: props.onRetry }]
              : []),
            { type: "separator" as const },
            { label: ctx.t("remove"), onSelect: props.onRemove },
          ]}
        />
      </div>
    </ctx.ui.SettingsRow>
  );
}
