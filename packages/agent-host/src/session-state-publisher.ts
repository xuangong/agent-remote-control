import { SESSION_STATE_CONFIRMATION_MS, SESSION_STATE_LIMIT, SESSION_STATE_STALE_MS, type HostSessionState, type HostSessionStates, type SessionActivityState } from '@orchardworks/agent-remote-protocol';

export interface SessionStateCatalog {
  readonly providerId: string;
  /** The states a provider's own catalog reports; sessions without one are left out. */
  read(): Promise<HostSessionState[]>;
}
export interface SessionStateSources {
  /** Sessions this Controller holds open, read from memory. */
  live(): HostSessionState[];
  /** The enabled providers' catalogs, read from the native agents. */
  catalogs(): readonly SessionStateCatalog[];
}
export interface SessionStatePublisherOptions {
  liveIntervalMs?: number;
  confirmationMs?: number;
  /** A catalog that reported nothing beyond the open sessions is read again only after this long. */
  quietCatalogMs?: number;
  now?(): number;
}
export interface SessionStatePublisher {
  snapshot(): HostSessionState[];
  subscribe(listener: (report: HostSessionStates) => void): () => void;
}

/** What an open session's agent manager reports about its work. */
export interface LiveSessionFacts { closed: boolean; connected: boolean; pendingInteractions: number; status: string; activeTurn: boolean }
/** The state an open session shows, or undefined while it is closed or out of touch with its agent. */
export function liveSessionState(facts: LiveSessionFacts): SessionActivityState | undefined {
  if (facts.closed || !facts.connected) return undefined;
  if (facts.pendingInteractions > 0 || facts.status === 'waiting') return 'waiting';
  if (facts.status === 'failed') return 'failed';
  if (facts.status === 'running' || facts.status === 'starting' || facts.activeTurn) return 'running';
  return facts.status === 'idle' ? 'idle' : undefined;
}

const key = (state: Pick<HostSessionState, 'providerId' | 'nativeSessionId'>) => JSON.stringify([state.providerId, state.nativeSessionId]);
const same = (left: HostSessionState, right: HostSessionState) => left.state === right.state && left.updatedAt === right.updatedAt;

/**
 * Reports session states for the Relay to share: open sessions are checked every couple of seconds and their changes
 * sent at once; provider catalogs are read about once a minute, which also confirms every state. Catalog states not
 * read again in time are dropped, so they become unknown instead of stale. Runs only while someone listens.
 */
export function createSessionStatePublisher(sources: SessionStateSources, options: SessionStatePublisherOptions = {}): SessionStatePublisher {
  const liveIntervalMs = options.liveIntervalMs ?? 2_000;
  const confirmationMs = options.confirmationMs ?? SESSION_STATE_CONFIRMATION_MS;
  const quietCatalogMs = options.quietCatalogMs ?? 10 * confirmationMs;
  const now = options.now ?? Date.now;
  const listeners = new Set<(report: HostSessionStates) => void>();
  const catalogs = new Map<string, { states: HostSessionState[]; readAt: number; nextReadAt: number }>();
  let published = new Map<string, HostSessionState>();
  let liveTimer: ReturnType<typeof setInterval> | undefined, confirmTimer: ReturnType<typeof setInterval> | undefined;
  let confirming: Promise<void> | undefined;

  function live(): HostSessionState[] {
    try { return sources.live(); } catch { return []; }
  }
  function current(): Map<string, HostSessionState> {
    const merged = new Map<string, HostSessionState>(), at = now();
    for (const catalog of catalogs.values()) if (at - catalog.readAt < SESSION_STATE_STALE_MS) for (const state of catalog.states) merged.set(key(state), state);
    // An open session knows its state better than its catalog does; the catalog may still know when it last changed.
    for (const state of live()) {
      const updatedAt = state.updatedAt ?? merged.get(key(state))?.updatedAt;
      merged.set(key(state), { ...state, ...(updatedAt === undefined ? {} : { updatedAt }) });
    }
    if (merged.size <= SESSION_STATE_LIMIT) return merged;
    const ordered = [...merged].sort(([, a], [, b]) => (b.updatedAt ?? Infinity) - (a.updatedAt ?? Infinity));
    return new Map(ordered.slice(0, SESSION_STATE_LIMIT));
  }
  function emit(report: HostSessionStates) {
    for (const listener of [...listeners]) { try { listener(report); } catch { /* A failed delivery only affects its listener. */ } }
  }
  function sendChanges() {
    if (!listeners.size) return;
    const next = current(), states: HostSessionState[] = [], removed: NonNullable<HostSessionStates['removed']> = [];
    for (const [id, state] of next) { const previous = published.get(id); if (!previous || !same(previous, state)) states.push(state); }
    for (const [id, state] of published) if (!next.has(id)) removed.push({ providerId: state.providerId, nativeSessionId: state.nativeSessionId });
    published = next;
    if (states.length || removed.length) emit({ full: false, states, ...(removed.length ? { removed } : {}) });
  }
  async function readCatalogs() {
    const open = new Set(live().map(key)), enabled = sources.catalogs();
    for (const providerId of catalogs.keys()) if (!enabled.some(catalog => catalog.providerId === providerId)) catalogs.delete(providerId);
    await Promise.all(enabled.map(async catalog => {
      const previous = catalogs.get(catalog.providerId);
      if (previous && previous.nextReadAt > now()) return;
      try {
        const states = await catalog.read(), at = now();
        const informative = states.some(state => !open.has(key(state)));
        catalogs.set(catalog.providerId, { states, readAt: at, nextReadAt: at + (informative ? 0 : quietCatalogMs) });
      } catch {
        // The previous reading stays until it is too old to trust.
        if (previous) previous.nextReadAt = 0;
      }
    }));
  }
  function confirm(): Promise<void> {
    return confirming ??= readCatalogs().catch(() => undefined).then(() => {
      if (!listeners.size) return;
      published = current();
      emit({ full: true, states: [...published.values()] });
    }).finally(() => { confirming = undefined; });
  }
  function start() {
    liveTimer = setInterval(sendChanges, liveIntervalMs);
    confirmTimer = setInterval(() => void confirm(), confirmationMs);
    liveTimer.unref?.(); confirmTimer.unref?.();
    void confirm();
  }
  function stop() {
    clearInterval(liveTimer); clearInterval(confirmTimer);
    liveTimer = confirmTimer = undefined;
  }
  return {
    snapshot() { published = current(); return [...published.values()]; },
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1) start();
      return () => { if (listeners.delete(listener) && !listeners.size) stop(); };
    },
  };
}
