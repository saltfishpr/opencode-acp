import type { ServerRef } from "@opencode/plugin/gui";
import type { AgentSessionView, SessionAgentView } from "../../rpc.js";

export type SessionScope = "current" | "all";

export interface SessionRowData extends AgentSessionView {
  readonly server: ServerRef;
  readonly key: string;
}

export interface SessionAgentNote extends SessionAgentView {
  readonly server: ServerRef;
  readonly key: string;
}

export interface SessionGroup {
  readonly key: string;
  readonly server: ServerRef;
  readonly directory: string;
  readonly name: string;
  readonly rows: SessionRowData[];
  readonly updatedAt: number;
}

export const rowKey = (server: string, agentID: string, sessionID: string) => `${server}\0${agentID}\0${sessionID}`;
export const agentKey = (server: string, agentID: string) => `${server}\0${agentID}`;

/** Comparable form of an absolute path, so `/a/` and `/a` match. */
export function pathKey(path: string): string {
  const normalized = path.replaceAll("\\", "/").replace(/\/+$/, "") || "/";
  return /^[a-z]:\//i.test(normalized) ? normalized.toLowerCase() : normalized;
}

export function withinPath(target: string, root: string): boolean {
  const key = pathKey(root);
  const value = pathKey(target);
  return key === "/" ? value.startsWith("/") : value === key || value.startsWith(`${key}/`);
}

export function activityTime(value: string): number {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function directoryName(directory: string): string {
  return pathKey(directory).split("/").at(-1) || directory;
}

/** Exact directory first, then its descendants, then everything else. */
function directoryRank(directory: string, currentRoot: string | undefined): number {
  if (currentRoot === undefined) return 0;
  const key = pathKey(currentRoot);
  const value = pathKey(directory);
  if (value === key) return 0;
  return withinPath(value, key) ? 1 : 2;
}

/** Groups sessions by server and directory, newest first. */
export function groupSessions(rows: readonly SessionRowData[], currentRoot: string | undefined): SessionGroup[] {
  const groups = new Map<
    string,
    { key: string; server: ServerRef; directory: string; name: string; rows: SessionRowData[]; updatedAt: number }
  >();

  for (const row of rows) {
    const key = `${row.server.id}\0${pathKey(row.cwd)}`;
    let group = groups.get(key);
    if (group === undefined) {
      group = { key, server: row.server, directory: row.cwd, name: directoryName(row.cwd), rows: [], updatedAt: 0 };
      groups.set(key, group);
    }
    group.rows.push(row);
    group.updatedAt = Math.max(group.updatedAt, activityTime(row.updatedAt));
  }

  const list = [...groups.values()];
  for (const group of list) group.rows.sort((a, b) => activityTime(b.updatedAt) - activityTime(a.updatedAt));

  return list.sort(
    (a, b) =>
      directoryRank(a.directory, currentRoot) - directoryRank(b.directory, currentRoot) ||
      b.updatedAt - a.updatedAt ||
      a.name.localeCompare(b.name),
  );
}

export function matchesQuery(fields: readonly string[], needle: string): boolean {
  if (needle.length === 0) return true;
  return fields.some((value) => value.toLowerCase().includes(needle));
}
