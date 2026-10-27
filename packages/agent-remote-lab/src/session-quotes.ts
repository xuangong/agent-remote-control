import { useCallback, useSyncExternalStore } from 'react';
import { appendSessionExcerpts, isSessionExcerpt, MAX_SESSION_EXCERPTS_PER_MESSAGE, sessionExcerptAttachment, type SessionExcerpt } from '@orchardworks/agent-remote-protocol';
import type { LabWorkbenchActions } from './components/LabWorkbench.js';
import { conversationLocalStorage } from './conversation-storage.js';

/**
 * Excerpts quoted into a session view wait in its composer until the next message carries them. They belong to the
 * view, in any Window, and stay with it when its session is handed off. Closed views' quotes expire.
 */
interface SavedQuotes { version: 1; views: Record<string, { updatedAt: number; excerpts: SessionExcerpt[] }> }
const storageKey = (scope: string) => `agent-remote:recovery:${scope}:quotes`;
const MAX_VIEWS = 64;
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const listeners = new Set<() => void>();
const snapshots = new Map<string, { raw: string | null; excerpts: SessionExcerpt[] }>();
const none: SessionExcerpt[] = [];

function read(scope: string): SavedQuotes {
  let value: unknown;
  try { value = JSON.parse(conversationLocalStorage.getItem(storageKey(scope)) ?? 'null'); } catch { value = undefined; }
  const views: SavedQuotes['views'] = {};
  if (value && typeof value === 'object' && (value as SavedQuotes).version === 1 && (value as SavedQuotes).views && typeof (value as SavedQuotes).views === 'object') {
    for (const [viewId, entry] of Object.entries((value as SavedQuotes).views)) {
      if (!entry || typeof entry.updatedAt !== 'number' || !Array.isArray(entry.excerpts)) continue;
      const excerpts = entry.excerpts.filter(isSessionExcerpt);
      if (excerpts.length) views[viewId] = { updatedAt: entry.updatedAt, excerpts };
    }
  }
  return { version: 1, views };
}
function write(scope: string, change: (views: SavedQuotes['views']) => void): void {
  const saved = read(scope), now = Date.now();
  change(saved.views);
  const kept = Object.entries(saved.views).filter(([, entry]) => entry.excerpts.length && now - entry.updatedAt < RETENTION_MS)
    .sort(([, a], [, b]) => b.updatedAt - a.updatedAt).slice(0, MAX_VIEWS);
  const key = storageKey(scope);
  if (kept.length) conversationLocalStorage.setItem(key, JSON.stringify({ version: 1, views: Object.fromEntries(kept) }));
  else conversationLocalStorage.removeItem(key);
  for (const listener of listeners) listener();
}

export function readQuotes(scope: string, viewId: string): SessionExcerpt[] { return read(scope).views[viewId]?.excerpts ?? []; }
/** Quotes an excerpt into a view's composer; the view can hold as many as one message can carry. */
export function addQuote(scope: string, viewId: string, excerpt: SessionExcerpt): void {
  if (!isSessionExcerpt(excerpt)) throw new Error('The quoted messages could not be read.');
  const current = readQuotes(scope, viewId);
  if (current.some(item => item.id === excerpt.id)) return;
  if (current.length >= MAX_SESSION_EXCERPTS_PER_MESSAGE) throw new Error(`That message already carries ${MAX_SESSION_EXCERPTS_PER_MESSAGE} quotes. Send it or remove one first.`);
  try {
    write(scope, views => { views[viewId] = { updatedAt: Date.now(), excerpts: [...(views[viewId]?.excerpts ?? []), excerpt] }; });
  } catch { throw new Error('The quote could not be saved in this browser. Remove other quotes or free browser storage.'); }
}
export function removeQuotes(scope: string, viewId: string, ids: readonly string[]): void {
  write(scope, views => {
    const entry = views[viewId];
    if (entry) views[viewId] = { ...entry, excerpts: entry.excerpts.filter(excerpt => !ids.includes(excerpt.id)) };
  });
}
/** Puts excerpts back in front of any quoted since, for example after their message could not be sent or was edited. */
export function restoreQuotes(scope: string, viewId: string, excerpts: readonly SessionExcerpt[]): void {
  if (!excerpts.length) return;
  write(scope, views => {
    const current = views[viewId]?.excerpts ?? [];
    views[viewId] = { updatedAt: Date.now(), excerpts: [...excerpts.filter(excerpt => !current.some(item => item.id === excerpt.id)), ...current] };
  });
}

function subscribe(listener: () => void): () => void {
  const storage = (event: StorageEvent) => { if (event.key === null || event.key.endsWith(':quotes')) listener(); };
  listeners.add(listener); window.addEventListener('storage', storage);
  return () => { listeners.delete(listener); window.removeEventListener('storage', storage); };
}
/** The excerpts waiting in a view's composer, updated in every page of this browser. */
export function useViewQuotes(scope: string, viewId: string | undefined): SessionExcerpt[] {
  const snapshot = useCallback(() => {
    if (!viewId) return none;
    const raw = conversationLocalStorage.getItem(storageKey(scope)), id = JSON.stringify([scope, viewId]), previous = snapshots.get(id);
    if (previous && previous.raw === raw) return previous.excerpts;
    const excerpts = readQuotes(scope, viewId);
    const value = previous && JSON.stringify(previous.excerpts) === JSON.stringify(excerpts) ? previous.excerpts : excerpts;
    snapshots.set(id, { raw, excerpts: value });
    return value;
  }, [scope, viewId]);
  return useSyncExternalStore(subscribe, snapshot);
}

/**
 * The next message sent from the view carries its quotes after the user's text. They leave the composer when the message
 * is handed to the session, and return if it could not be sent.
 */
export function withViewQuotes(actions: LabWorkbenchActions, scope: string, viewId: string): LabWorkbenchActions {
  async function deliver<T>(send: (excerpts: SessionExcerpt[]) => Promise<T>): Promise<T> {
    const excerpts = readQuotes(scope, viewId);
    if (excerpts.length) removeQuotes(scope, viewId, excerpts.map(excerpt => excerpt.id));
    try { return await send(excerpts); }
    catch (error) { restoreQuotes(scope, viewId, excerpts); throw error; }
  }
  return { ...actions,
    // Other arguments pass through as they were given.
    ...(actions.sendMessage ? { sendMessage: (text, ...rest) => deliver(excerpts => actions.sendMessage!(appendSessionExcerpts(text, excerpts), ...rest)) } : {}),
    ...(actions.sendMessageContent ? { sendMessageContent: (content, ...rest) => deliver(excerpts => actions.sendMessageContent!(
      excerpts.length ? [...content, { type: 'text', text: sessionExcerptAttachment(excerpts) }] : content, ...rest)) } : {}),
    ...(actions.steer ? { steer: text => deliver(excerpts => actions.steer!(appendSessionExcerpts(text, excerpts))) } : {}),
  };
}
