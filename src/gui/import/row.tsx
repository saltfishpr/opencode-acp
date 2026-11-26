import { usePlugin } from "@opencode/plugin/gui";
import { Show } from "solid-js";
import { definition } from "../definition.js";
import type { ImportRowData } from "./model.js";

export function ImportSessionRow(props: {
  row: ImportRowData;
  agentName: string;
  age: string;
  pending: boolean;
  disabled: boolean;
  onImport(): void;
}) {
  const ctx = usePlugin<typeof definition>();
  const title = () => props.row.title || ctx.t("import.untitled");
  return (
    <button
      type="button"
      class="acp-import-session"
      data-missing={!props.row.available || undefined}
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
  );
}
