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
  deletingKey: string | undefined;
  disabled: boolean;
  onToggle(): void;
  onMore(): void;
  onImport(row: ImportRowData): void;
  onDelete(row: ImportRowData): void;
}) {
  const ctx = usePlugin<typeof definition>();
  // Matched rows, including the ones hidden behind "show more".
  const total = () => props.rows.length + props.remaining;
  const agentIDs = () => new Set(props.group.rows.map((row) => row.agentID));
  const singleAgent = () => {
    const ids = agentIDs();
    return ids.size === 1 ? props.agentNameOf([...ids][0]!) : undefined;
  };
  const mixedAgents = () => agentIDs().size > 1;

  return (
    <section class="acp-import-group" aria-label={props.group.name}>
      <button type="button" class="acp-import-project" aria-expanded={props.expanded} onClick={() => props.onToggle()}>
        <ctx.ui.Icon name={props.expanded ? "chevron-down" : "chevron-right"} />
        <ctx.ui.Icon name="folder" />
        <span class="acp-import-copy">
          <span class="acp-import-project-name" dir="auto">
            {props.group.name}
          </span>
          <span class="acp-import-directory" dir="ltr" title={props.group.directory}>
            {props.group.directory}
          </span>
        </span>
        <span class="acp-import-project-meta">
          <Show when={props.serverName}>{(name: () => string) => <span class="acp-import-server">{name()}</span>}</Show>
          <Show when={singleAgent()}>
            {(name: () => string) => <span class="acp-import-project-agent">{name()}</span>}
          </Show>
          <Show when={total()}>{(count: () => number) => <span class="acp-import-count">{count()}</span>}</Show>
        </span>
      </button>
      <Show when={props.expanded}>
        <div class="acp-import-sessions">
          <For each={props.rows}>
            {(row) => (
              <ImportSessionRow
                row={row}
                agentName={mixedAgents() ? props.agentNameOf(row.agentID) : ""}
                age={props.age(row.updatedAt)}
                pending={props.pendingKey === row.key}
                deleting={props.deletingKey === row.key}
                disabled={props.disabled || !row.available}
                deleteDisabled={props.disabled}
                onImport={() => props.onImport(row)}
                onDelete={() => props.onDelete(row)}
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
