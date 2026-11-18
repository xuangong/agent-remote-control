import { createContext, useContext, useEffect, useMemo, useSyncExternalStore } from 'react';
import type { RemoteAgentTransport, SessionDraftsView, SessionOutboxView, SessionReadsView, SessionStatesView } from '@orchardworks/agent-client';

/** The account's shared IM state as the Relay shares it; a part is absent while it is not wanted or has not arrived. */
export interface SharedFeedsSnapshot {
  readonly states?: SessionStatesView;
  readonly reads?: SessionReadsView;
  readonly drafts?: SessionDraftsView;
  readonly outbox?: SessionOutboxView;
}
const EMPTY: SharedFeedsSnapshot = Object.freeze({});
const ignoreChanges = () => () => {};

/**
 * Holds the shared IM state outside React state. Its frames arrive whenever any bot of the account changes, so they
 * render only the components that show them (the roster, folded cards, a conversation's outbox bubbles) instead of
 * App and every conversation below it. Each change replaces the snapshot; unchanged parts keep their identity.
 */
export class SharedFeeds {
  #snapshot: SharedFeedsSnapshot = EMPTY;
  readonly #listeners = new Set<() => void>();
  readonly get = (): SharedFeedsSnapshot => this.#snapshot;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => { this.#listeners.delete(listener); };
  };
  set(part: Partial<SharedFeedsSnapshot>): void {
    const next = { ...this.#snapshot, ...part };
    for (const key of Object.keys(next) as Array<keyof SharedFeedsSnapshot>) if (next[key] === undefined) delete next[key];
    const keys = new Set([...Object.keys(next), ...Object.keys(this.#snapshot)]) as Set<keyof SharedFeedsSnapshot>;
    if ([...keys].every(key => next[key] === this.#snapshot[key])) return;
    this.#snapshot = Object.freeze(next);
    for (const listener of [...this.#listeners]) listener();
  }
}

export const SharedFeedsContext = createContext<SharedFeeds | undefined>(undefined);

export type SharedFeedsTransport = Pick<RemoteAgentTransport, 'watchSessionStates' | 'watchSessionReads' | 'watchSessionDrafts' | 'watchSessionOutbox'>;
/**
 * The page's shared feeds, opened while wanted: states and read positions travel together (rows show what is unread),
 * drafts and the outbox while the workbench is open. The store keeps its identity per transport.
 */
export function useSharedFeedsSource(transport: SharedFeedsTransport | undefined, wanted: { states: boolean; drafts: boolean; outbox: boolean }): SharedFeeds {
  const feeds = useMemo(() => new SharedFeeds(), [transport]);
  useEffect(() => {
    if (!wanted.states || !transport?.watchSessionStates) { feeds.set({ states: undefined }); return; }
    return transport.watchSessionStates(states => feeds.set({ states }));
  }, [feeds, transport, wanted.states]);
  useEffect(() => {
    if (!wanted.states || !transport?.watchSessionReads) { feeds.set({ reads: undefined }); return; }
    return transport.watchSessionReads(reads => feeds.set({ reads }));
  }, [feeds, transport, wanted.states]);
  useEffect(() => {
    if (!wanted.drafts || !transport?.watchSessionDrafts) { feeds.set({ drafts: undefined }); return; }
    return transport.watchSessionDrafts(drafts => feeds.set({ drafts }));
  }, [feeds, transport, wanted.drafts]);
  useEffect(() => {
    if (!wanted.outbox || !transport?.watchSessionOutbox) { feeds.set({ outbox: undefined }); return; }
    return transport.watchSessionOutbox(outbox => feeds.set({ outbox }));
  }, [feeds, transport, wanted.outbox]);
  return feeds;
}

/**
 * A value read from the shared feeds of the page; the component renders again only when it changes (by identity), so
 * select a part (`snapshot => snapshot.outbox`) or a primitive derived from it, never a newly built object.
 */
export function useSharedFeed<T>(select: (snapshot: SharedFeedsSnapshot) => T): T {
  return useSharedFeedOf(useContext(SharedFeedsContext), select);
}
/** useSharedFeed for the component that provides the feeds. */
export function useSharedFeedOf<T>(feeds: SharedFeeds | undefined, select: (snapshot: SharedFeedsSnapshot) => T): T {
  return useSyncExternalStore(feeds?.subscribe ?? ignoreChanges, () => select(feeds?.get() ?? EMPTY));
}

/** The shared session states, for components that show statuses: they render again when the states change. */
export function useSharedStates(): SessionStatesView | undefined {
  return useSharedFeed(snapshot => snapshot.states);
}
