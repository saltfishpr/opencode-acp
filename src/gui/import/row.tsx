import { usePlugin } from "@opencode/plugin/gui";
import { Show } from "solid-js";
import { definition } from "../definition.js";
import type { ImportRowData } from "./model.js";

export function ImportSessionRow(props: {
  row: ImportRowData;
  agentName: string;
  age: string;
  pending: boolean;
  deleting: boolean;
  disabled: boolean;
  deleteDisabled: boolean;
  onImport(): void;
  onDelete(): void;
}) {
  const ctx = usePlugin<typeof definition>();
  const title = () => props.row.title || ctx.t("import.untitled");
  return (
    <div
      class="acp-import-session-row"
      data-missing={!props.row.available || undefined}
      aria-busy={props.pending || props.deleting}
    >
      <button
        type="button"
        class="acp-import-session"
        aria-busy={props.pending}
        disabled={props.disabled}
        onClick={() => props.onImport()}
      >
        <span class="acp-import-copy">
          <span class="acp-import-title" dir="auto" title={title()}>
            {title()}
          </span>
          <Show when={props.agentName}>
            <span class="acp-import-meta">
              <span class="acp-import-agent">{props.agentName}</span>
            </span>
          </Show>
        </span>
        <span class="acp-import-side">
          <Show
            when={props.row.available}
            fallback={<span class="acp-import-missing">{ctx.t("import.directoryMissing")}</span>}
          >
            <Show when={props.pending} fallback={<span class="acp-import-time">{props.age}</span>}>
              <ctx.ui.Loader size="small" />
            </Show>
          </Show>
        </span>
      </button>
      <button
        type="button"
        class="acp-import-delete"
        aria-label={ctx.t("import.delete")}
        title={ctx.t("import.delete")}
        disabled={props.deleteDisabled || props.deleting}
        onClick={(event) => {
          event.stopPropagation();
          props.onDelete();
        }}
      >
        <Show when={props.deleting} fallback={<ctx.ui.Icon name="trash" />}>
          <ctx.ui.Loader size="small" />
        </Show>
      </button>
    </div>
  );
}
