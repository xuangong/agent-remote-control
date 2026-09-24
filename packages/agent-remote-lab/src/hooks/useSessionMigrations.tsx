import { conversationSessionStorage } from '../conversation-storage.js';
import { workspaceFetch } from '../workspace-access.js';
import { useEffect, useRef, useState } from 'react';
import { watchPageResume, type RemoteAgentTransport } from '@orchardworks/agent-remote-web';
import { decodeSessionChannelServerMessage, PROTOCOL_VERSION, type SessionMigration } from '@orchardworks/agent-remote-protocol';
import type { OpenedSession } from '../directory-client.js';
import { sessionKey } from '../session-tree.js';
import { sessionUrl } from '../components/SessionLink.js';

export function useSessionMigrations(options: {
  baseUrl: string; enabled: boolean; transport: RemoteAgentTransport; current?: OpenedSession; loaded?: readonly OpenedSession[];
  apply(migration: SessionMigration): void;
  refreshReferences?(): void;
  follow(session: OpenedSession, source: OpenedSession): Promise<boolean>;
  blocked(migration: SessionMigration): boolean;
  needsPromptRestore?(migration: SessionMigration): boolean;
  stay?(migration: SessionMigration): void;
}) {
  const latest = useRef(options); latest.current = options;
  const [records, setRecords] = useState<SessionMigration[]>([]);
  const [seen, setSeen] = useState<Set<string>>(() => new Set());
  const [remaining, setRemaining] = useState(5);
  const [requested, setRequested] = useState<string>();
  const refreshRef = useRef<() => Promise<boolean>>();
  const [previous, setPrevious] = useState<OpenedSession>();
  const [failure, setFailure] = useState<string>();
  const [following, setFollowing] = useState(false);
  const scope = options.baseUrl;
  const applied = useRef(new Set<string>());
  const loaded = options.loaded ?? (options.current ? [options.current] : []);
  const location = new URL(window.location.href).searchParams;
  const originalKey = location.has('keepOriginal') && location.has('session')
    ? sessionKey({ hostId: location.get('host') ?? 'local', providerId: location.get('provider') ?? 'codex', nativeSessionId: location.get('session')! }) : undefined;
  const pending = options.enabled
    ? records.find(record => (!seen.has(record.id) || requested === record.id) && (sessionKey(record.from) !== originalKey || requested === record.id) && loaded.some(session => sessionKey(record.from) === sessionKey(session))) : undefined;
  function acknowledge(id: string) {
    setRequested(value => value === id ? undefined : value);
    setSeen(values => {
      const next = new Set(values); next.add(id);
      try { conversationSessionStorage.setItem('arc:prompt-edits:' + scope, JSON.stringify([...next].slice(-1024))); } catch { /* Tab-local memory still prevents repeat switches. */ }
      return next;
    });
  }
  useEffect(() => {
    applied.current.clear(); setRecords([]); setPrevious(undefined); setRequested(undefined);
    try { const saved: unknown = JSON.parse(conversationSessionStorage.getItem('arc:prompt-edits:' + scope) ?? '[]'); setSeen(new Set(Array.isArray(saved) ? saved.filter(value => typeof value === 'string') : [])); } catch { setSeen(new Set()); }
    if (!options.enabled) return;
    const abort = new AbortController();
    let fetching: Promise<boolean> | undefined;
    let referencesTimer: ReturnType<typeof setTimeout> | undefined;
    function receive(migration: SessionMigration) {
      if (abort.signal.aborted || applied.current.has(migration.id)) return;
      applied.current.add(migration.id);
      latest.current.apply(migration);
      clearTimeout(referencesTimer);
      referencesTimer = setTimeout(() => { if (!abort.signal.aborted) latest.current.refreshReferences?.(); }, 100);
      setRecords(values => [...values, migration]);
    }
    function refresh(): Promise<boolean> {
      if (abort.signal.aborted) return Promise.resolve(false);
      if (fetching) return fetching;
      fetching = (async () => {
        try {
          const response = await workspaceFetch(new URL('v1/session-migrations', scope), { credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.any([abort.signal, AbortSignal.timeout(12000)]) });
          if (!response.ok) return false;
          const result = await response.json();
          if (!Array.isArray(result.migrations)) return false;
          for (const migration of result.migrations) {
            const decoded = decodeSessionChannelServerMessage(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'session_migrated', migration }));
            if (decoded.status !== 'ok' || decoded.value.type !== 'session_migrated') return false;
            receive(decoded.value.migration);
          }
          return !abort.signal.aborted;
        } catch { return false; /* The channel and the next page resume retry recovery. */ }
        finally { fetching = undefined; }
      })();
      return fetching;
    }
    refreshRef.current = async () => { if (fetching) await fetching; return refresh(); };
    const remove = options.transport.onSessionMigration?.(receive);
    const resume = watchPageResume(() => void refresh());
    void refresh();
    return () => { abort.abort(); refreshRef.current = undefined; clearTimeout(referencesTimer); remove?.(); resume(); };
  }, [scope, options.transport, options.enabled]);
  useEffect(() => {
    setRemaining(5); setFailure(undefined); setFollowing(false);
    if (!pending) return;
    let remainingMs = 5000; let previousTick = Date.now(); let submitting = false; let canceled = false;
    const source: OpenedSession = { ...pending.from, title: loaded.find(session => sessionKey(session) === sessionKey(pending.from))?.title ?? 'Original conversation' };
    const resetClock = () => { previousTick = Date.now(); };
    document.addEventListener('visibilitychange', resetClock);
    window.addEventListener('pageshow', resetClock);
    const timer = setInterval(() => {
      const now = Date.now(); const elapsed = now - previousTick; previousTick = now;
      if (document.visibilityState === 'hidden' || latest.current.blocked(pending) || latest.current.needsPromptRestore?.(pending) || submitting || canceled) return;
      remainingMs -= Math.min(elapsed, 1000); setRemaining(Math.max(0, Math.ceil(remainingMs / 1000)));
      if (remainingMs > 0) return;
      submitting = true; setFollowing(true);
      void latest.current.follow({ ...pending.to, title: source.title }, source).then(opened => {
        if (latest.current.baseUrl !== scope) return;
        if (opened) { acknowledge(pending.id); setPrevious(source); clearInterval(timer); }
        else { setFailure('The new branch could not be opened. Retry when connected.'); clearInterval(timer); }
      }).catch(() => { if (!canceled) setFailure('The new branch could not be opened. Retry when connected.'); clearInterval(timer); })
        .finally(() => { if (!canceled) setFollowing(false); });
    }, 250);
    return () => { canceled = true; clearInterval(timer); document.removeEventListener('visibilitychange', resetClock); window.removeEventListener('pageshow', resetClock); };
  }, [pending?.id, scope]);
  const original = pending ? { ...pending.from, title: 'Original conversation' } : previous;
  const originalUrl = original ? new URL(sessionUrl(original)) : undefined;
  originalUrl?.searchParams.set('keepOriginal', '1');
  const needsPromptRestore = pending && options.needsPromptRestore?.(pending);
  const notice = original ? <div className="lab-prompt-edit-notice" role="status">
    <span>{failure ?? (needsPromptRestore ? 'Prompt edit interrupted. Retry editing the original message, or stay here.' : following ? 'Opening the edited branch…' : pending && options.blocked(pending) ? 'Automatic switching paused.' : pending ? `Prompt edited. Switching to the new branch in ${remaining}s…` : 'Opened the edited branch.')}</span>
    <a href={originalUrl!.href} target="_blank" rel="noreferrer">Original session</a>
    {failure && pending ? <button type="button" disabled={following} onClick={() => { setFailure(undefined); setFollowing(true); void latest.current.follow({ ...pending.to, title: options.current?.title ?? 'Conversation' }, original).then(opened => { if (latest.current.baseUrl !== scope) return; if (opened) { acknowledge(pending.id); setPrevious(original); } else setFailure('The new branch could not be opened. Retry when connected.'); }).catch(() => { if (latest.current.baseUrl === scope) setFailure('The new branch could not be opened. Retry when connected.'); }).finally(() => { if (latest.current.baseUrl === scope) setFollowing(false); }); }}>Retry</button> : null}
    {pending ? <button type="button" disabled={following || options.blocked(pending)} onClick={() => {
      latest.current.stay?.(pending); acknowledge(pending.id); setPrevious(undefined); setFailure(undefined);
    }}>Stay here</button> : null}
    {!pending ? <button type="button" aria-label="Dismiss branch notice" onClick={() => setPrevious(undefined)}>×</button> : null}
  </div> : null;
  return { notice, pending, refresh: () => refreshRef.current?.() ?? Promise.resolve(false), requestFollow(id: string) { setRequested(id); void refreshRef.current?.(); } };
}
