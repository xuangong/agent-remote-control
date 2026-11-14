import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { RemoteAgentTransport, SessionDraftsView, SessionStateRef } from '@orchardworks/agent-remote-web';
import { conversationSessionStorage } from '../conversation-storage.js';
import type { DraftBinding } from '../draft-store.js';
import { createSharedDraftSync, type SharedDraftAgreement, type SharedDraftSync } from '../shared-draft-sync.js';

/** The account's drafts shared across devices, and how to save one; absent where the transport has none. */
export interface SharedDrafts {
  view: SessionDraftsView;
  /** Saves a session's draft for every device and resolves with the revision it got. */
  save(session: SessionStateRef, text: string): Promise<number>;
}
export const SharedDraftsContext = createContext<SharedDrafts | undefined>(undefined);

/** The account's shared drafts while enabled, with how to save one; undefined where the transport has none. */
export function useSessionDrafts(transport: Pick<RemoteAgentTransport, 'watchSessionDrafts' | 'saveSessionDraft'> | undefined, enabled: boolean): SharedDrafts | undefined {
  const [view, setView] = useState<SessionDraftsView>();
  useEffect(() => {
    if (!enabled || !transport?.watchSessionDrafts || !transport.saveSessionDraft) { setView(undefined); return; }
    return transport.watchSessionDrafts(setView);
  }, [transport, enabled]);
  // One save per transport, so composers keep their pending edits while drafts arrive.
  const save = useMemo(() => transport?.saveSessionDraft ? (session: SessionStateRef, text: string) => transport.saveSessionDraft!(session, text).then(draft => draft.revision) : undefined, [transport]);
  return useMemo(() => view && save ? { view, save } : undefined, [view, save]);
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
 */
export function useSharedDraft(binding: DraftBinding | undefined, session: SessionStateRef | undefined, enabled = true): void {
  const shared = useContext(SharedDraftsContext);
  const sync = useRef<SharedDraftSync>();
  const save = shared?.save, store = binding?.store, key = binding?.key;
  const hostId = session?.hostId, providerId = session?.providerId, nativeSessionId = session?.nativeSessionId;
  const latest = useRef(shared?.view); latest.current = shared?.view;
  useEffect(() => {
    if (!enabled || !save || !store || key === undefined || !hostId || !providerId || !nativeSessionId) return;
    const ref = { hostId, providerId, nativeSessionId }, id = JSON.stringify([key, hostId, providerId, nativeSessionId]);
    const current = createSharedDraftSync({
      read: () => store.get(key),
      apply: text => { store.set(key, text); },
      publish: text => save(ref, text),
      agreement: agreement(store.scope, id),
      remember: value => remember(store.scope, id, value),
    });
    sync.current = current;
    const stop = store.subscribe(key, () => current.local(store.get(key)));
    if (latest.current?.loaded) current.remote(latest.current.draft(ref));
    return () => { stop(); current.dispose(); if (sync.current === current) sync.current = undefined; };
  }, [enabled, save, store, key, hostId, providerId, nativeSessionId]);
  const view = shared?.view;
  useEffect(() => {
    if (!view?.loaded || !hostId || !providerId || !nativeSessionId) return;
    sync.current?.remote(view.draft({ hostId, providerId, nativeSessionId }));
  }, [view, hostId, providerId, nativeSessionId]);
}
