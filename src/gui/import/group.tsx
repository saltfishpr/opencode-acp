import { usePlugin } from "@opencode/plugin/gui";
import { For, Show } from "solid-js";
import { definition } from "../definition.js";
import type { ImportGroup, ImportRowData } from "./model.js";
import { ImportSessionRow } from "./row.js";

export function ImportGroupSection(props: {
  group: ImportGroup;
  rows: readonly ImportRowData[];
  remaining: number;
  expanded: boolean;
  serverName?: string;
  agentNameOf(agentID: string): string;
  age(updatedAt: string): string;
  pendingKey: string | undefined;
  disabled: boolean;
  onToggle(): void;
  onMore(): void;
  onImport(row: ImportRowData): void;
}) {
  const ctx = usePlugin<typeof definition>();
  const total = () => props.group.rows.length;

  return (
    <section class="acp-import-group" aria-label={props.group.name}>
      <button type="button" class="acp-import-project" aria-expanded={props.expanded} onClick={() => props.onToggle()}>
        <ctx.ui.Icon name={props.expanded ? "chevron-down" : "chevron-right"} />
        <ctx.ui.Icon name="folder" />
        <span class="acp-import-copy">
          <span class="acp-import-project-name" dir="auto">
            {props.group.name}
          </span>
          <span class="acp-import-directory" dir="auto">
            {props.group.directory}
          </span>
        </span>
        <span class="acp-import-project-meta">
          <Show when={props.serverName}>{(name: () => string) => <span class="acp-import-server">{name()}</span>}</Show>
          <Show when={total()}>{(count: () => number) => <span class="acp-import-count">{count()}</span>}</Show>
        </span>
      </button>
      <Show when={props.expanded}>
        <div class="acp-import-sessions">
          <For each={props.rows}>
            {(row) => (
              <ImportSessionRow
                row={row}
                agentName={props.agentNameOf(row.agentID)}
                age={props.age(row.updatedAt)}
                pending={props.pendingKey === row.key}
                disabled={props.disabled || !row.available}
                onImport={() => props.onImport(row)}
              />
            )}
          </For>
          <Show when={props.remaining > 0}>
            <button type="button" class="acp-import-more" onClick={() => props.onMore()}>
              {ctx.t("import.showMore", { count: props.remaining })}
            </button>
          </Show>
        </div>
      </Show>
    </section>
  );
}
