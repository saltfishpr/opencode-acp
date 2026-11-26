/**
 * Titles reported by ACP agents, keyed by OpenCode session.
 *
 * The title hook may run before or after `session_info_update`; this store keeps
 * the latest ACP title so the hook can prefer it and fall back to the first
 * user prompt when the agent never names the session.
 */
export class SessionTitles {
  private readonly titles = new Map<string, string>();
  private readonly limit: number;

  constructor(limit = 500) {
    this.limit = limit;
  }

  /** Records a non-empty title. Returns true when it replaced a different value. */
  remember(sessionID: string, title: string): boolean {
    const value = title.trim();
    if (value.length === 0) return false;
    if (this.titles.get(sessionID) === value) return false;

    this.titles.delete(sessionID);
    this.titles.set(sessionID, value);

    while (this.titles.size > this.limit) {
      const oldest = this.titles.keys().next().value;
      if (oldest === undefined) break;
      this.titles.delete(oldest);
    }

    return true;
  }

  get(sessionID: string): string | undefined {
    return this.titles.get(sessionID);
  }

  clear(): void {
    this.titles.clear();
  }
}
