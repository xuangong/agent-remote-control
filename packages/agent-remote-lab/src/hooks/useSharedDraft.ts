import { createContext, useContext, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import type { RemoteAgentTransport, SessionDraftsView, SessionStateRef } from '@orchardworks/agent-remote-web';
import { conversationSessionStorage } from '../conversation-storage.js';
import type { DraftBinding } from '../draft-store.js';
import { createSharedDraftSync, type SharedDraftAgreement, type SharedDraftSync } from '../shared-draft-sync.js';
import type { SharedFeeds } from '../shared-feeds.js';

/**
 * The account's drafts shared across devices, and how to save one; absent where the transport has none. Its identity
 * lasts as long as the page's feeds and transport: drafts reach composers through `subscribe`, without rendering them.
 */
export interface SharedDrafts {
  /** The drafts as last shared, once they arrived. */
  current(): SessionDraftsView | undefined;
  /** Calls back when the drafts may have changed. */
  subscribe(listener: () => void): () => void;
  /** Saves a session's draft for every device and resolves with the revision it got. */
  save(session: SessionStateRef, text: string): Promise<number>;
}
export const SharedDraftsContext = createContext<SharedDrafts | undefined>(undefined);
const ignoreChanges = () => () => {};

/** Shared drafts read from the page's feeds and saved through the transport; undefined where the transport cannot save them. */
export function useSharedDrafts(feeds: SharedFeeds, transport: Pick<RemoteAgentTransport, 'saveSessionDraft'> | undefined): SharedDrafts | undefined {
  return useMemo(() => transport?.saveSessionDraft ? {
    current: () => feeds.get().drafts, subscribe: feeds.subscribe,
    save: (session: SessionStateRef, text: string) => transport.saveSessionDraft!(session, text).then(draft => draft.revision),
  } : undefined, [feeds, transport]);
}

/** Agreements kept per tab, next to its drafts, so a reload tells text it agreed on from text edited since. */
const AGREEMENTS = 256;
const agreementsKey = (scope: string) => `agent-remote:recovery:${scope}:draft-sync`;
function readAgreements(scope: string): Record<string, [number, string]> {
  try {
    const value: unknown = JSON.parse(conversationSessionStorage.getItem(agreementsKey(scope)) ?? '{}');
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, [number, string]> : {};
  } catch { return {}; }
}
function agreement(scope: string, id: string): SharedDraftAgreement | undefined {
  const saved = readAgreements(scope)[id];
  return Array.isArray(saved) && Number.isSafeInteger(saved[0]) && typeof saved[1] === 'string' ? { revision: saved[0], hash: saved[1] } : undefined;
}
function remember(scope: string, id: string, value: SharedDraftAgreement) {
  const saved = readAgreements(scope);
  delete saved[id];
  saved[id] = [value.revision, value.hash];
  const ids = Object.keys(saved);
  for (const old of ids.slice(0, Math.max(0, ids.length - AGREEMENTS))) delete saved[old];
  try { conversationSessionStorage.setItem(agreementsKey(scope), JSON.stringify(saved)); } catch { /* Sharing still works; a reload decides as if new. */ }
}

/**
 * Keeps a composer's draft in step with the session's draft on every device. It follows another device's newer draft
 * only while nothing typed here is unpublished, and publishes what is typed here shortly after the last keystroke.
 * It starts once the account's drafts have arrived, so it never publishes over a draft it has not seen.
 */
export function useSharedDraft(binding: DraftBinding | undefined, session: SessionStateRef | undefined, enabled = true): void {
  const shared = useContext(SharedDraftsContext);
  const loaded = useSyncExternalStore(shared?.subscribe ?? ignoreChanges, () => !!shared?.current()?.loaded);
  const sync = useRef<SharedDraftSync>();
  const store = binding?.store, key = binding?.key;
  const hostId = session?.hostId, providerId = session?.providerId, nativeSessionId = session?.nativeSessionId;
  useEffect(() => {
    if (!enabled || !loaded || !shared || !store || key === undefined || !hostId || !providerId || !nativeSessionId) return;
    const ref = { hostId, providerId, nativeSessionId }, id = JSON.stringify([key, hostId, providerId, nativeSessionId]);
    const current = createSharedDraftSync({
      read: () => store.get(key),
      apply: text => { store.set(key, text); },
      publish: text => shared.save(ref, text),
      agreement: agreement(store.scope, id),
      remember: value => remember(store.scope, id, value),
    });
    sync.current = current;
    const stop = store.subscribe(key, () => current.local(store.get(key)));
    let seen = shared.current();
    if (seen?.loaded) current.remote(seen.draft(ref));
    // Drafts from other devices reach the sync directly; the conversation does not render for them.
    const unfollow = shared.subscribe(() => {
      const view = shared.current();
      if (!view?.loaded || view === seen) return;
      seen = view;
      current.remote(view.draft(ref));
    });
    return () => { stop(); unfollow(); current.dispose(); if (sync.current === current) sync.current = undefined; };
  }, [enabled, loaded, shared, store, key, hostId, providerId, nativeSessionId]);
}
