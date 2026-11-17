/** The sessions of each Host that have a journal head: the ones whose reads a journal may serve, answered from memory. */
export class JournalHeadIndex {
  private readonly heads = new Map<string, Set<string>>();
  private readonly loadedHosts = new Set<string>();
  private everyHostLoaded = false;

  /** Whether the Host's sessions were loaded. */
  loaded(hostId: string): boolean { return this.everyHostLoaded || this.loadedHosts.has(hostId); }

  /** Whether the session has a head; undefined while the Host's sessions have not been loaded. */
  served(hostId: string, sessionKey: string): boolean | undefined {
    if (!this.loaded(hostId)) return undefined;
    return this.heads.get(hostId)?.has(sessionKey) ?? false;
  }

  /** Adds the sessions a store lists for the Host and counts the Host as loaded; sessions added since are kept. */
  load(hostId: string, sessionKeys: Iterable<string>): void {
    const sessions = this.heads.get(hostId) ?? new Set<string>();
    for (const sessionKey of sessionKeys) sessions.add(sessionKey);
    this.heads.set(hostId, sessions);
    this.loadedHosts.add(hostId);
  }

  /** Every Host the store holds was loaded: a Host it listed nothing for has no session with a head. */
  markEveryHostLoaded(): void { this.everyHostLoaded = true; }

  add(hostId: string, sessionKey: string): void {
    const sessions = this.heads.get(hostId) ?? new Set<string>();
    sessions.add(sessionKey);
    this.heads.set(hostId, sessions);
  }

  remove(hostId: string, sessionKey: string): void { this.heads.get(hostId)?.delete(sessionKey); }

  sessions(hostId: string): string[] { return [...(this.heads.get(hostId) ?? [])].sort(); }

  /** Forgets every session of a Host and counts the Host as loaded and empty. */
  clearHost(hostId: string): void {
    this.heads.set(hostId, new Set());
    this.loadedHosts.add(hostId);
  }
}
