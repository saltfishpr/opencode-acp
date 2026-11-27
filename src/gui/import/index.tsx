import { usePlugin } from "@opencode/plugin/gui";
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { AcpSettings } from "../../rpc.js";
import { definition } from "../definition.js";
import { importSession } from "./action.js";
import { createImportController } from "./controller.js";
import { ImportGroupSection } from "./group.js";
import {
  agentKey,
  groupSessions,
  matchesQuery,
  withinPath,
  type ImportGroup,
  type ImportRowData,
  type ImportScope,
} from "./model.js";

const PAGE_SIZE = 8;

export function ImportSessions(props: { close(): void }) {
  const ctx = usePlugin<typeof definition>();
  const [query, setQuery] = createSignal("");
  const [scope, setScope] = createSignal<ImportScope>(ctx.sessions.current() === undefined ? "all" : "current");
  const [expanded, setExpanded] = createSignal<Record<string, boolean>>({});
  const [limits, setLimits] = createSignal<Record<string, number>>({});
  const [order, setOrder] = createSignal<Record<string, number>>({});
  const [pending, setPending] = createSignal<string>();
  const [deleting, setDeleting] = createSignal<string>();
  const [now, setNow] = createSignal(Date.now());
  let list: { scrollTop: number } | undefined;

  const currentRoot = () => {
    const session = ctx.sessions.current();
    if (session === undefined) return undefined;
    const worktree = session.listedProject?.worktree;
    return worktree !== undefined && withinPath(session.directory, worktree) ? worktree : session.directory;
  };
  const effectiveScope = (): ImportScope => (scope() === "current" && currentRoot() === undefined ? "all" : scope());
  const scopeRoot = () => (effectiveScope() === "current" ? currentRoot() : undefined);

  const data = createImportController({ scopeRoot });
  const { agents, rows, reading, loading, error, setError, signal, load, reload } = data;

  const names = createMemo(() => new Map(agents().map((agent) => [agentKey(agent.server.id, agent.id), agent.name])));
  const nameOf = (serverID: string, agentID: string) => names().get(agentKey(serverID, agentID)) ?? agentID;

  const needle = () => query().trim().toLowerCase();
  const groups = createMemo(() => {
    const sorted = groupSessions(rows(), currentRoot());
    const rank = order();
    if (Object.keys(rank).length === 0) return sorted;
    // Keep groups seen before the first interaction in place; new groups append.
    return [...sorted].sort((a, b) => {
      const left = rank[a.key];
      const right = rank[b.key];
      if (left !== undefined && right !== undefined) return left - right;
      if (left !== undefined) return -1;
      if (right !== undefined) return 1;
      return 0;
    });
  });
  const filtered = createMemo(() =>
    groups()
      .map((group) => ({
        group,
        rows:
          needle().length === 0
            ? group.rows
            : group.rows.filter((row) =>
                matchesQuery(
                  [row.title, row.cwd, group.name, group.server.name, nameOf(row.server.id, row.agentID)],
                  needle(),
                ),
              ),
      }))
      .filter((item) => item.rows.length > 0),
  );

  const notes = createMemo(() => agents().filter((agent) => agent.status !== "ready"));
  const readingAgents = createMemo(() => agents().filter((agent) => reading()[agent.key] === true));
  const busy = () => loading() || readingAgents().length > 0;
  const skeleton = () => loading() || (rows().length === 0 && readingAgents().length > 0);
  const anyReady = () => agents().some((agent) => agent.status === "ready");
  const working = () => pending() !== undefined || deleting() !== undefined;

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

  const isExpanded = (group: ImportGroup) => {
    const explicit = expanded()[group.key];
    if (explicit !== undefined) return explicit;
    if (needle().length > 0) return true;
    const root = currentRoot();
    return root === undefined ? true : withinPath(group.directory, root);
  };

  const visible = (item: { group: ImportGroup; rows: ImportRowData[] }) => {
    const limit = limits()[item.group.key] ?? PAGE_SIZE;
    const shown = needle().length > 0 ? item.rows : item.rows.slice(0, limit);
    return { rows: shown, remaining: item.rows.length - shown.length };
  };

  onMount(() => {
    void load();
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    onCleanup(() => clearInterval(timer));
  });

  function changeScope(next: ImportScope) {
    if (next === scope() || loading()) return;
    setScope(next);
    if (next === "current" && currentRoot() === undefined) return;
    setOrder({});
    if (list !== undefined) list.scrollTop = 0;
    void reload();
  }

  function freezeOrder() {
    if (Object.keys(order()).length > 0) return;
    setOrder(Object.fromEntries(groups().map((group, index) => [group.key, index])));
  }

  function toggle(group: ImportGroup) {
    const value = !isExpanded(group);
    setExpanded((previous) => ({ ...previous, [group.key]: value }));
  }

  function showMore(group: ImportGroup) {
    setLimits((previous) => ({ ...previous, [group.key]: (previous[group.key] ?? PAGE_SIZE) + PAGE_SIZE }));
  }

  async function runImport(row: ImportRowData) {
    if (working() || !row.available) return;
    setPending(row.key);
    setError(undefined);
    try {
      await importSession(ctx, {
        row,
        signal: signal(),
        close: props.close,
        reload: () => void reload(),
        fail: (message) => setError(message),
      });
    } finally {
      setPending(undefined);
    }
  }

  async function runDelete(row: ImportRowData) {
    if (working()) return;

    const agent = nameOf(row.server.id, row.agentID);
    const confirmed = await ctx.dialogs.confirm({
      title: ctx.t("import.deleteTitle"),
      description: ctx.t("import.deleteDescription", { agent }),
      confirm: ctx.t("import.delete"),
      danger: true,
    });
    if (!confirmed) return;

    setDeleting(row.key);
    setError(undefined);
    try {
      const outcome = await row.server.client
        .rpc(AcpSettings)
        .deleteSession(
          { agentID: row.agentID, sessionID: row.id },
          { location: { directory: row.cwd }, signal: AbortSignal.timeout(60_000) },
        );

      if (outcome.status === "ok" || outcome.status === "notFound") {
        void reload();
        return;
      }

      setError(
        outcome.status === "unsupported"
          ? ctx.t("import.error.deleteUnsupported")
          : outcome.status === "conflict"
            ? ctx.t("import.error.deleteConflict")
            : ctx.t("import.error.deleteFailed"),
      );
    } catch (cause) {
      const type = typeof cause === "object" && cause !== null && "type" in cause ? cause.type : undefined;
      setError(
        type === "rpc.method_not_found" ? ctx.t("import.error.updatePlugin") : ctx.t("import.error.requestFailed"),
      );
    } finally {
      setDeleting(undefined);
    }
  }

  return (
    <ctx.ui.Dialog
      title={ctx.t("import.title")}
      description={ctx.t("import.description")}
      size="large"
      footer={
        <>
          <ctx.ui.Button variant="ghost" disabled={working()} onClick={props.close}>
            {ctx.t("import.cancel")}
          </ctx.ui.Button>
          <ctx.ui.Button
            variant="neutral"
            icon="refresh"
            busy={busy()}
            disabled={working() || loading()}
            onClick={() => void reload()}
          >
            {ctx.t("import.refresh")}
          </ctx.ui.Button>
        </>
      }
    >
      <div class="acp-import" onPointerDown={freezeOrder} onKeyDown={freezeOrder}>
        <ctx.ui.TextInput
          class="acp-import-search"
          label={ctx.t("import.search")}
          placeholder={ctx.t("import.search")}
          value={query()}
          onInput={setQuery}
          autofocus
        />
        <div class="acp-import-scopes" role="group" aria-label={ctx.t("import.scope.all")}>
          <button
            type="button"
            class="acp-scope"
            aria-pressed={effectiveScope() === "current"}
            disabled={loading() || working() || currentRoot() === undefined}
            onClick={() => changeScope("current")}
          >
            {ctx.t("import.scope.current")}
          </button>
          <button
            type="button"
            class="acp-scope"
            aria-pressed={effectiveScope() === "all"}
            disabled={loading() || working()}
            onClick={() => changeScope("all")}
          >
            {ctx.t("import.scope.all")}
          </button>
        </div>
        <Show when={error()}>
          {(text: () => string) => (
            <span class="acp-error" role="alert">
              {text()}
            </span>
          )}
        </Show>
        <Show when={!loading() && notes().length > 0}>
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
        <div class="acp-import-list" data-scrollable ref={(element: { scrollTop: number }) => (list = element)}>
          <Show
            when={!skeleton()}
            fallback={
              <div class="acp-import-skeleton" role="status" aria-label={ctx.t("import.loading")}>
                <For each={[0, 1, 2, 3]}>
                  {() => (
                    <div>
                      <span />
                      <span />
                    </div>
                  )}
                </For>
              </div>
            }
          >
            <For each={filtered()}>
              {(item) => {
                const shown = () => visible(item);
                return (
                  <ImportGroupSection
                    group={item.group}
                    rows={shown().rows}
                    remaining={shown().remaining}
                    expanded={isExpanded(item.group)}
                    serverName={ctx.servers.list().length > 1 ? item.group.server.name : undefined}
                    agentNameOf={(agentID) => nameOf(item.group.server.id, agentID)}
                    age={relativeTime}
                    pendingKey={pending()}
                    deletingKey={deleting()}
                    disabled={working()}
                    onToggle={() => toggle(item.group)}
                    onMore={() => showMore(item.group)}
                    onImport={(row) => void runImport(row)}
                    onDelete={(row) => void runDelete(row)}
                  />
                );
              }}
            </For>
            <Show when={readingAgents().length > 0}>
              <div class="acp-import-reading" role="status">
                <ctx.ui.Loader size="small" />
                {readingAgents().length === 1
                  ? ctx.t("import.reading", { agent: readingAgents()[0]!.name })
                  : ctx.plural("import.readingCount", readingAgents().length)}
              </div>
            </Show>
            <Show when={filtered().length === 0 && !busy() && needle().length > 0}>
              <div class="acp-import-state" role="status">
                <ctx.ui.Icon name="magnifying-glass" size="large" />
                <span>{ctx.t("import.noResults")}</span>
                <ctx.ui.Button variant="ghost-muted" onClick={() => setQuery("")}>
                  {ctx.t("import.clear")}
                </ctx.ui.Button>
              </div>
            </Show>
            <Show when={filtered().length === 0 && !busy() && needle().length === 0}>
              <div class="acp-import-state" role="status">
                <ctx.ui.Icon name="folder" size="large" />
                <Show when={anyReady()} fallback={<span>{ctx.t("import.emptyAgents")}</span>}>
                  <Show when={effectiveScope() === "current"} fallback={<span>{ctx.t("import.empty")}</span>}>
                    <span>{ctx.t("import.emptyCurrent")}</span>
                    <ctx.ui.Button variant="ghost-muted" onClick={() => changeScope("all")}>
                      {ctx.t("import.showAll")}
                    </ctx.ui.Button>
                  </Show>
                </Show>
              </div>
            </Show>
          </Show>
        </div>
      </div>
    </ctx.ui.Dialog>
  );
}
