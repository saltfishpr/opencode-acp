import { usePlugin } from "@opencode/plugin/gui";
import { For, Show } from "solid-js";
import { definition } from "../definition.js";
import type { SessionGroup, SessionRowData } from "./model.js";
import { SessionRow } from "./row.js";

export function SessionGroupSection(props: {
  group: SessionGroup;
  rows: readonly SessionRowData[];
  remaining: number;
  expanded: boolean;
  serverName?: string;
  agentNameOf(agentID: string): string;
  canDeleteOf(agentID: string): boolean;
  age(updatedAt: string): string;
  pendingKey: string | undefined;
  deletingKey: string | undefined;
  disabled: boolean;
  onToggle(): void;
  onMore(): void;
  onOpen(row: SessionRowData): void;
  onDelete(row: SessionRowData): void;
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
    <section class="acp-sessions-group" aria-label={props.group.name}>
      <button
        type="button"
        class="acp-sessions-project"
        aria-expanded={props.expanded}
        onClick={() => props.onToggle()}
      >
        <ctx.ui.Icon name={props.expanded ? "chevron-down" : "chevron-right"} />
        <ctx.ui.Icon name="folder" />
        <span class="acp-sessions-copy">
          <span class="acp-sessions-project-name" dir="auto">
            {props.group.name}
          </span>
          <span class="acp-sessions-directory" dir="ltr" title={props.group.directory}>
            {props.group.directory}
          </span>
        </span>
        <span class="acp-sessions-project-meta">
          <Show when={props.serverName}>
            {(name: () => string) => <span class="acp-sessions-server">{name()}</span>}
          </Show>
          <Show when={singleAgent()}>
            {(name: () => string) => <span class="acp-sessions-project-agent">{name()}</span>}
          </Show>
          <Show when={total()}>{(count: () => number) => <span class="acp-sessions-count">{count()}</span>}</Show>
        </span>
      </button>
      <Show when={props.expanded}>
        <div class="acp-sessions-list-rows">
          <For each={props.rows}>
            {(row) => (
              <SessionRow
                row={row}
                agentName={mixedAgents() ? props.agentNameOf(row.agentID) : ""}
                age={props.age(row.updatedAt)}
                pending={props.pendingKey === row.key}
                deleting={props.deletingKey === row.key}
                disabled={props.disabled || !row.available}
                canDelete={props.canDeleteOf(row.agentID)}
                onOpen={() => props.onOpen(row)}
                onDelete={() => props.onDelete(row)}
              />
            )}
          </For>
          <Show when={props.remaining > 0}>
            <button type="button" class="acp-sessions-more" onClick={() => props.onMore()}>
              {ctx.t("sessions.showMore", { count: props.remaining })}
            </button>
          </Show>
        </div>
      </Show>
    </section>
  );
}
