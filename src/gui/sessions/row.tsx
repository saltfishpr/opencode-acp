import { usePlugin } from "@opencode/plugin/gui";
import { Show } from "solid-js";
import { definition } from "../definition.js";
import type { SessionRowData } from "./model.js";

export function SessionRow(props: {
  row: SessionRowData;
  agentName: string;
  age: string;
  pending: boolean;
  deleting: boolean;
  disabled: boolean;
  canDelete: boolean;
  onOpen(): void;
  onDelete(): void;
}) {
  const ctx = usePlugin<typeof definition>();
  const title = () => props.row.title || ctx.t("sessions.untitled");

  return (
    <div
      class="acp-sessions-row"
      data-missing={!props.row.available || undefined}
      aria-busy={props.pending || props.deleting}
    >
      <button
        type="button"
        class="acp-sessions-session"
        aria-busy={props.pending}
        disabled={props.disabled}
        onClick={() => props.onOpen()}
      >
        <span class="acp-sessions-copy">
          <span class="acp-sessions-title" dir="auto" title={title()}>
            {title()}
          </span>
          <Show when={props.agentName}>
            <span class="acp-sessions-meta">
              <span class="acp-sessions-agent">{props.agentName}</span>
            </span>
          </Show>
        </span>
        <span class="acp-sessions-side">
          <Show
            when={props.row.available}
            fallback={<span class="acp-sessions-missing">{ctx.t("sessions.directoryMissing")}</span>}
          >
            <Show when={props.pending} fallback={<span class="acp-sessions-time">{props.age}</span>}>
              <ctx.ui.Loader size="small" />
            </Show>
          </Show>
        </span>
      </button>
      <Show when={props.canDelete}>
        <button
          type="button"
          class="acp-sessions-delete"
          aria-label={ctx.t("sessions.delete")}
          title={ctx.t("sessions.delete")}
          disabled={props.disabled || props.deleting}
          onClick={(event) => {
            event.stopPropagation();
            props.onDelete();
          }}
        >
          <Show when={props.deleting} fallback={<ctx.ui.Icon name="trash" />}>
            <ctx.ui.Loader size="small" />
          </Show>
        </button>
      </Show>
    </div>
  );
}
