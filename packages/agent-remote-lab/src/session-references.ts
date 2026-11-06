import { useCallback, useEffect, useSyncExternalStore } from 'react';
import { appendSessionReferences, sessionReferencesAttachment, splitSessionExcerpts, splitSessionReferences, type SessionReferenceNote } from '@orchardworks/agent-remote-protocol';
import type { AgentReplicaState } from '@orchardworks/agent-remote-web';
import type { LabWorkbenchActions } from './components/LabWorkbench.js';
import { DirectoryError, SessionDirectoryClient } from './directory-client.js';

/** A session another session references, as its Host reports it. */
export interface LabSessionRef { providerId: string; nativeSessionId: string; title?: string; origin: 'source' | 'added'; addedAt?: string }
export interface LabSessionRefs { revision: number; refs: LabSessionRef[] }
/** The session whose references are read or changed. */
export interface SessionRefHolder { hostId?: string; providerId: string; nativeSessionId: string }

/**
 * References of the sessions a page shows, loaded from their Host. unsupported: the Host predates references, so the page
 * shows the source as before. delivered: the revision the page last told the session's agent about.
 */
interface Entry { value?: LabSessionRefs; unsupported?: boolean; error?: string; loading?: Promise<void>; delivered?: number }
const entries = new Map<string, Entry>();
const listeners = new Set<() => void>();
const notify = () => { for (const listener of listeners) listener(); };
const keyOf = (scope: string, holder: SessionRefHolder) => JSON.stringify([scope, holder.hostId ?? 'local', holder.providerId, holder.nativeSessionId]);
const client = (scope: string, holder: SessionRefHolder) => new SessionDirectoryClient(scope, undefined, holder.hostId ?? 'local');
const unsupported = (error: unknown) => error instanceof DirectoryError && (error.code === 'unsupported_configuration' || error.status === 404);

function update(key: string, change: Partial<Entry>) {
  entries.set(key, { ...entries.get(key), ...change });
  notify();
}

export function loadSessionRefs(scope: string, holder: SessionRefHolder): Promise<void> {
  const key = keyOf(scope, holder), current = entries.get(key);
  if (current?.loading) return current.loading;
  const loading = client(scope, holder).sessionRefs(holder.providerId, holder.nativeSessionId)
    .then(value => update(key, { value, unsupported: false, error: undefined, loading: undefined }))
    .catch(error => update(key, unsupported(error) ? { unsupported: true, loading: undefined } : { error: error instanceof Error ? error.message : 'References are unavailable.', loading: undefined }));
  update(key, { loading });
  return loading;
}

/** Adds or removes a reference and keeps the Host's answer; the change reaches the agent with the next message. */
export async function changeSessionRef(scope: string, holder: SessionRefHolder, action: 'add' | 'remove', target: Pick<LabSessionRef, 'providerId' | 'nativeSessionId'>): Promise<LabSessionRefs> {
  const value = await client(scope, holder).changeSessionRef(holder.providerId, holder.nativeSessionId, action, { providerId: target.providerId, nativeSessionId: target.nativeSessionId });
  update(keyOf(scope, holder), { value, unsupported: false, error: undefined });
  return value;
}

/** What the page knows of a session's references, without asking its Host. */
export function sessionRefsEntry(scope: string, holder: SessionRefHolder): Readonly<Entry> { return entries.get(keyOf(scope, holder)) ?? {}; }

export function useSessionRefs(scope: string, holder: SessionRefHolder | undefined): Entry {
  const key = holder ? keyOf(scope, holder) : undefined;
  const subscribe = useCallback((listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, []);
  const entry = useSyncExternalStore(subscribe, () => key ? entries.get(key) : undefined);
  const providerId = holder?.providerId, nativeSessionId = holder?.nativeSessionId, hostId = holder?.hostId;
  useEffect(() => {
    if (!providerId || !nativeSessionId) return;
    const target = { hostId, providerId, nativeSessionId };
    void loadSessionRefs(scope, target);
    // References also change from the agent's shell; a page that becomes visible asks again.
    const refresh = () => { if (document.visibilityState === 'visible') void loadSessionRefs(scope, target); };
    document.addEventListener('visibilitychange', refresh);
    return () => document.removeEventListener('visibilitychange', refresh);
  }, [scope, hostId, providerId, nativeSessionId]);
  return entry ?? {};
}

/** The revision the conversation last told its agent about, from the notes its user messages carry. */
export function notedRevision(state: AgentReplicaState | undefined): number {
  let revision = 0;
  for (const entry of state?.timeline.entries ?? []) {
    if (entry.item.type !== 'user_message') continue;
    const note = splitSessionReferences(splitSessionExcerpts(entry.item.text).text).note;
    if (note && note.revision > revision) revision = note.revision;
  }
  return revision;
}

/** The note the next message carries when the references changed since the agent was last told; none for a source alone. */
export function pendingReferenceNote(scope: string, holder: SessionRefHolder, state: AgentReplicaState | undefined): SessionReferenceNote | undefined {
  const entry = entries.get(keyOf(scope, holder));
  const value = entry?.value;
  if (!value || !value.revision || value.revision <= Math.max(notedRevision(state), entry.delivered ?? 0)) return undefined;
  const host = holder.hostId ?? 'local';
  return { revision: value.revision, references: value.refs.map(ref => ({ address: `${host}/${ref.providerId}/${ref.nativeSessionId}`, ...(ref.title ? { title: ref.title } : {}), origin: ref.origin })) };
}

/** The next message carries the current references when they changed; the quotes the inner actions add follow them. */
export function withSessionReferences(actions: LabWorkbenchActions, scope: string, holder: SessionRefHolder, state: () => AgentReplicaState | undefined): LabWorkbenchActions {
  async function deliver<T>(send: (note: SessionReferenceNote | undefined) => Promise<T>): Promise<T> {
    const note = pendingReferenceNote(scope, holder, state());
    const result = await send(note);
    if (note) update(keyOf(scope, holder), { delivered: note.revision });
    return result;
  }
  return { ...actions,
    ...(actions.sendMessage ? { sendMessage: (text, ...rest) => deliver(note => actions.sendMessage!(note ? appendSessionReferences(text, note) : text, ...rest)) } : {}),
    ...(actions.sendMessageContent ? { sendMessageContent: (content, ...rest) => deliver(note => actions.sendMessageContent!(
      note ? [...content, { type: 'text', text: sessionReferencesAttachment(note) }] : content, ...rest)) } : {}),
    ...(actions.steer ? { steer: text => deliver(note => actions.steer!(note ? appendSessionReferences(text, note) : text)) } : {}),
  };
}
