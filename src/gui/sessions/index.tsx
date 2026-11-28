import { usePlugin } from "@opencode/plugin/gui";
import { For, Show, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { AcpRpc } from "../../rpc.js";
import { definition } from "../definition.js";
import type { SessionHydrator } from "../hydrator.js";
import { rpcFailure, waitForLocation } from "../shared/location.js";
import { createSessionListController } from "./controller.js";
import { SessionGroupSection } from "./group.js";
import {
  agentKey,
  groupSessions,
  matchesQuery,
  withinPath,
  type SessionGroup,
  type SessionRowData,
  type SessionScope,
} from "./model.js";

const PAGE_SIZE = 8;
const DELETE_TIMEOUT_MS = 60_000;

const OPEN_ERRORS = new Set([
  "notFound",
  "unsupported",
  "unavailable",
  "loadFailed",
  "directoryMissing",
  "sessionBusy",
  "updatePlugin",
  "locationNotReady",
  "updateOpenCode",
  "hydrateFailed",
  "requestFailed",
]);

export function OpenSessions(props: { hydrator: SessionHydrator; close(): void }) {
  const ctx = usePlugin<typeof definition>();
  const [query, setQuery] = createSignal("");
  const [scope, setScope] = createSignal<SessionScope>(ctx.sessions.current() === undefined ? "all" : "current");
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
  const effectiveScope = (): SessionScope => (scope() === "current" && currentRoot() === undefined ? "all" : scope());
  const scopeRoot = () => (effectiveScope() === "current" ? currentRoot() : undefined);

  const data = createSessionListController({ scopeRoot });
  const { agents, rows, reading, loading, error, setError, signal, load, reload } = data;

  const names = createMemo(() => new Map(agents().map((agent) => [agentKey(agent.server.id, agent.id), agent.name])));
  const nameOf = (serverID: string, agentID: string) => names().get(agentKey(serverID, agentID)) ?? agentID;
  const canDeleteOf = (serverID: string, agentID: string) =>
    agents().find((agent) => agent.server.id === serverID && agent.id === agentID)?.canDelete ?? false;

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
    return failures.has(reason) ? ctx.t(`failure.${reason}`) : ctx.t(`sessions.reason.${reason}`);
  };

  const relativeTime = (value: string) => {
    const parsed = Date.parse(value);
    if (!Number.isFinite(parsed)) return "";
    const seconds = Math.max(0, Math.floor((now() - parsed) / 1000));
    if (seconds < 60) return ctx.t("sessions.age.now");
    if (seconds < 3600) return ctx.plural("sessions.age.minutes", Math.floor(seconds / 60));
    if (seconds < 86_400) return ctx.plural("sessions.age.hours", Math.floor(seconds / 3600));
    return ctx.plural("sessions.age.days", Math.floor(seconds / 86_400));
  };

  const isExpanded = (group: SessionGroup) => {
    const explicit = expanded()[group.key];
    if (explicit !== undefined) return explicit;
    if (needle().length > 0) return true;
    const root = currentRoot();
    return root === undefined ? true : withinPath(group.directory, root);
  };

  const visible = (item: { group: SessionGroup; rows: SessionRowData[] }) => {
    const limit = limits()[item.group.key] ?? PAGE_SIZE;
    const shown = needle().length > 0 ? item.rows : item.rows.slice(0, limit);
    return { rows: shown, remaining: item.rows.length - shown.length };
  };

  onMount(() => {
    void load();
    const timer = setInterval(() => setNow(Date.now()), 30_000);
    onCleanup(() => clearInterval(timer));
  });

  function changeScope(next: SessionScope) {
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

  function toggle(group: SessionGroup) {
    const value = !isExpanded(group);
    setExpanded((previous) => ({ ...previous, [group.key]: value }));
  }

  function showMore(group: SessionGroup) {
    setLimits((previous) => ({ ...previous, [group.key]: (previous[group.key] ?? PAGE_SIZE) + PAGE_SIZE }));
  }

  async function runOpen(row: SessionRowData) {
    if (working() || !row.available) return;
    setPending(row.key);
    setError(undefined);
    try {
      const result = await props.hydrator.openSession({
        server: row.server,
        agentID: row.agentID,
        acpSessionID: row.id,
        cwd: row.cwd,
        signal: signal(),
      });
      if (result.ok) {
        props.close();
        return;
      }
      if (result.code === "aborted") {
        if (signal().aborted) return;
        setError(ctx.t("sessions.error.hydrateFailed"));
        return;
      }
      setError(ctx.t(`sessions.error.${OPEN_ERRORS.has(result.code) ? result.code : "requestFailed"}`));
    } finally {
      setPending(undefined);
    }
  }

  async function runDelete(row: SessionRowData) {
    if (working()) return;

    const agent = nameOf(row.server.id, row.agentID);
    const confirmed = await ctx.dialogs.confirm({
      title: ctx.t("sessions.deleteTitle"),
      description: ctx.t("sessions.deleteDescription", { agent }),
      confirm: ctx.t("sessions.delete"),
      danger: true,
    });
    if (!confirmed) return;

    setDeleting(row.key);
    setError(undefined);
    try {
      await waitForLocation(row.server, row.cwd, signal());
      if (signal().aborted) return;
      const outcome = await row.server.client.rpc(AcpRpc).deleteSession(
        { agentID: row.agentID, sessionID: row.id },
        {
          location: { directory: row.cwd },
          signal: AbortSignal.any([signal(), AbortSignal.timeout(DELETE_TIMEOUT_MS)]),
        },
      );

      if (outcome.status === "ok" || outcome.status === "notFound") {
        await props.hydrator.removeProjections(row.server, row.agentID, row.id, row.cwd);
        void reload();
        return;
      }

      if (outcome.status === "unsupported") setError(ctx.t("sessions.error.deleteUnsupported"));
      else setError(ctx.t("sessions.error.deleteFailed"));
    } catch (cause) {
      if (signal().aborted) return;
      setError(ctx.t(`sessions.error.${rpcFailure(cause)}`));
    } finally {
      setDeleting(undefined);
    }
  }

  return (
    <ctx.ui.Dialog
      title={ctx.t("sessions.title")}
      description={ctx.t("sessions.description")}
      size="large"
      footer={
        <>
          <ctx.ui.Button variant="ghost" disabled={working()} onClick={props.close}>
            {ctx.t("sessions.cancel")}
          </ctx.ui.Button>
          <ctx.ui.Button
            variant="neutral"
            icon="refresh"
            busy={busy()}
            disabled={working() || loading()}
            onClick={() => void reload()}
          >
            {ctx.t("sessions.refresh")}
          </ctx.ui.Button>
        </>
      }
    >
      <div class="acp-sessions" onPointerDown={freezeOrder} onKeyDown={freezeOrder}>
        <ctx.ui.TextInput
          class="acp-sessions-search"
          label={ctx.t("sessions.search")}
          placeholder={ctx.t("sessions.search")}
          value={query()}
          onInput={setQuery}
          autofocus
        />
        <div class="acp-sessions-scopes" role="group" aria-label={ctx.t("sessions.scope.all")}>
          <button
            type="button"
            class="acp-scope"
            aria-pressed={effectiveScope() === "current"}
            disabled={loading() || working() || currentRoot() === undefined}
            onClick={() => changeScope("current")}
          >
            {ctx.t("sessions.scope.current")}
          </button>
          <button
            type="button"
            class="acp-scope"
            aria-pressed={effectiveScope() === "all"}
            disabled={loading() || working()}
            onClick={() => changeScope("all")}
          >
            {ctx.t("sessions.scope.all")}
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
          <div class="acp-sessions-notes">
            <For each={notes()}>
              {(agent) => (
                <p class="acp-sessions-note">
                  {ctx.t("sessions.agentNote", {
                    server: agent.server.name,
                    agent: agent.name,
                    reason: reasonText(agent.reason),
                  })}
                </p>
              )}
            </For>
          </div>
        </Show>
        <div class="acp-sessions-scroll" data-scrollable ref={(element: { scrollTop: number }) => (list = element)}>
          <Show
            when={!skeleton()}
            fallback={
              <div class="acp-sessions-skeleton" role="status" aria-label={ctx.t("sessions.loading")}>
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
                  <SessionGroupSection
                    group={item.group}
                    rows={shown().rows}
                    remaining={shown().remaining}
                    expanded={isExpanded(item.group)}
                    serverName={ctx.servers.list().length > 1 ? item.group.server.name : undefined}
                    agentNameOf={(agentID) => nameOf(item.group.server.id, agentID)}
                    canDeleteOf={(agentID) => canDeleteOf(item.group.server.id, agentID)}
                    age={relativeTime}
                    pendingKey={pending()}
                    deletingKey={deleting()}
                    disabled={working()}
                    onToggle={() => toggle(item.group)}
                    onMore={() => showMore(item.group)}
                    onOpen={(row) => void runOpen(row)}
                    onDelete={(row) => void runDelete(row)}
                  />
                );
              }}
            </For>
            <Show when={readingAgents().length > 0}>
              <div class="acp-sessions-reading" role="status">
                <ctx.ui.Loader size="small" />
                {readingAgents().length === 1
                  ? ctx.t("sessions.reading", { agent: readingAgents()[0]!.name })
                  : ctx.plural("sessions.readingCount", readingAgents().length)}
              </div>
            </Show>
            <Show when={filtered().length === 0 && !busy() && needle().length > 0}>
              <div class="acp-sessions-state" role="status">
                <ctx.ui.Icon name="magnifying-glass" size="large" />
                <span>{ctx.t("sessions.noResults")}</span>
                <ctx.ui.Button variant="ghost-muted" onClick={() => setQuery("")}>
                  {ctx.t("sessions.clear")}
                </ctx.ui.Button>
              </div>
            </Show>
            <Show when={filtered().length === 0 && !busy() && needle().length === 0}>
              <div class="acp-sessions-state" role="status">
                <ctx.ui.Icon name="folder" size="large" />
                <Show when={anyReady()} fallback={<span>{ctx.t("sessions.emptyAgents")}</span>}>
                  <Show when={effectiveScope() === "current"} fallback={<span>{ctx.t("sessions.empty")}</span>}>
                    <span>{ctx.t("sessions.emptyCurrent")}</span>
                    <ctx.ui.Button variant="ghost-muted" onClick={() => changeScope("all")}>
                      {ctx.t("sessions.showAll")}
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
