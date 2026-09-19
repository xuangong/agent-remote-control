import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RemoteActivityClient, type RemoteAgentTransport } from '@agent-remote-controller/agent-remote-web';
import { SessionDirectoryClient } from '../directory-client.js';
import { sessionKey } from '../session-tree.js';
import type { SessionStar } from '../session-stars-client.js';
import { MAX_TRACKED_SESSIONS, nextObservation, readTrackedSessions, saveTrackedSessions, type SessionObservation } from '../tracking-state.js';
import { useFeedbackToast } from '../components/Toast.js';

export function useSessionTracking(baseUrl: string, transport: RemoteAgentTransport) {
  const [selection, setSelection] = useState(() => ({ scope: baseUrl, sessions: readTrackedSessions(baseUrl) }));
  const sessions = useMemo(() => selection.scope === baseUrl ? selection.sessions : [], [selection, baseUrl]);
  const [observations, setObservations] = useState<Record<string, SessionObservation>>({});
  const [retries, setRetries] = useState<Record<string, number>>({});
  const [error, setError] = useState<string>();
  const current = useRef(sessions); current.current = sessions;
  useEffect(() => { setSelection({ scope: baseUrl, sessions: readTrackedSessions(baseUrl) }); setObservations({}); setError(undefined); }, [baseUrl]);
  function toggle(session: SessionStar) {
    const key = sessionKey(session), previous = current.current;
    const exists = previous.some(item => sessionKey(item) === key);
    if (!exists && previous.length >= MAX_TRACKED_SESSIONS) { setError(`Track up to ${MAX_TRACKED_SESSIONS} sessions on this client. Untrack one to add another.`); return; }
    const next = exists ? previous.filter(item => sessionKey(item) !== key) : [...previous, session];
    try { saveTrackedSessions(baseUrl, next); setError(undefined); }
    catch { setError('Tracking changed for this page, but this browser could not save it for the next visit.'); }
    current.current = next; setSelection({ scope: baseUrl, sessions: next });
    setObservations(values => { const next = { ...values }; delete next[key]; return next; });
  }
  const update = useCallback((key: string, value: SessionObservation) => {
    if (!current.current.some(item => sessionKey(item) === key)) return;
    setObservations(previous => {
      const next = nextObservation(previous[key], value), old = previous[key];
      return old && old.connection === next.connection && old.activity === next.activity && old.error === next.error && old.changed === next.changed && old.agentId === next.agentId ? previous : { ...previous, [key]: next };
    });
  }, []);
  const acknowledge = useCallback(() => setObservations(previous => Object.values(previous).some(value => value.changed)
    ? Object.fromEntries(Object.entries(previous).map(([key, value]) => [key, { ...value, changed: false }])) : previous), []);
  const retry = (key: string) => { setObservations(values => { const next = { ...values }; delete next[key]; return next; }); setRetries(values => ({ ...values, [key]: (values[key] ?? 0) + 1 })); };
  const observers = useMemo(() => sessions.map(session => <SessionObserver key={`${baseUrl}:${sessionKey(session)}:${retries[sessionKey(session)] ?? 0}`} session={session} baseUrl={baseUrl} transport={transport} update={update} />), [sessions, baseUrl, transport, update, retries]);
  useFeedbackToast('Session tracking', error);
  return { sessions, observations, error, toggle, retry, acknowledge, observers };
}
export type SessionTracking = ReturnType<typeof useSessionTracking>;

function SessionObserver({ session, baseUrl, transport, update }: { session: SessionStar; baseUrl: string; transport: RemoteAgentTransport; update(key: string, value: SessionObservation): void }) {
  const key = sessionKey(session);
  useEffect(() => {
    const abort = new AbortController();
    let client: RemoteActivityClient | undefined;
    update(key, { connection: 'connecting' });
    const directory = new SessionDirectoryClient(baseUrl, undefined, session.hostId);
    void (async () => {
      try {
        const signal = AbortSignal.any([abort.signal, AbortSignal.timeout(35000)]);
        const binding = session.parentNativeSessionId
          ? await directory.attachChild(session.providerId, session.parentNativeSessionId, session.nativeSessionId, signal)
          : await directory.attach(session.providerId, session.nativeSessionId, signal);
        if (abort.signal.aborted) return;
        client = new RemoteActivityClient(binding.agentId, transport, value => {
          if (!abort.signal.aborted) update(key, { ...value, agentId: binding.agentId });
        });
        client.start();
      } catch (error) {
        if (!abort.signal.aborted) update(key, { connection: 'disconnected', error: error instanceof Error ? error.message : 'Tracking could not connect. Try again.' });
      }
    })();
    return () => { abort.abort(); client?.stop(); };
  }, [baseUrl, transport, key, update]);
  return null;
}
