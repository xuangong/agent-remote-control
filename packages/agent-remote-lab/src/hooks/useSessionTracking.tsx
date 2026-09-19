import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RemoteActivityClient, type RemoteAgentTransport } from '@agent-remote-controller/agent-remote-web';
import { SessionDirectoryClient, type OpenedSession } from '../directory-client.js';
import { sessionKey } from '../session-tree.js';
import type { SessionStar } from '../session-stars-client.js';
import { MAX_TRACKED_SESSIONS, nextObservation, readTrackedSessions, saveTrackedSessions, type SessionObservation } from '../tracking-state.js';
import { useFeedbackToast } from '../components/Toast.js';

const noOpenSessions: readonly OpenedSession[] = [];

export function useSessionTracking(baseUrl: string, transport: RemoteAgentTransport, currentSessionKey?: string, openSessions: readonly OpenedSession[] = noOpenSessions) {
  const [selection, setSelection] = useState(() => ({ scope: baseUrl, sessions: readTrackedSessions(baseUrl) }));
  const sessions = useMemo(() => selection.scope === baseUrl ? selection.sessions : [], [selection, baseUrl]);
  const [observationState, setObservationState] = useState<{ scope: string; transport: RemoteAgentTransport; values: Record<string, SessionObservation> }>(() => ({ scope: baseUrl, transport, values: {} }));
  const observations = observationState.scope === baseUrl && observationState.transport === transport ? observationState.values : {};
  const setObservations = useCallback((update: (values: Record<string, SessionObservation>) => Record<string, SessionObservation>) => {
    setObservationState(previous => {
      const sameScope = previous.scope === baseUrl && previous.transport === transport;
      const values = sameScope ? previous.values : {};
      const next = update(values);
      return sameScope && next === values ? previous : { scope: baseUrl, transport, values: next };
    });
  }, [baseUrl, transport]);
  const [retries, setRetries] = useState<Record<string, number>>({});
  const [error, setError] = useState<string>();
  const visibleKeys = useMemo(() => new Set([...openSessions.map(sessionKey), ...(currentSessionKey ? [currentSessionKey] : [])]), [openSessions, currentSessionKey]);
  const backgroundSessions = useMemo(() => sessions.filter(session => !visibleKeys.has(sessionKey(session))), [sessions, visibleKeys]);
  const observedSessions = useMemo(() => {
    const union = new Map<string, { session: SessionStar | OpenedSession; liveAgentId?: string }>();
    for (const session of sessions) union.set(sessionKey(session), { session });
    for (const session of openSessions) union.set(sessionKey(session), { session, liveAgentId: session.agentId });
    return [...union.values()];
  }, [sessions, openSessions]);
  const current = useRef(sessions); current.current = sessions;
  const observed = useRef(observedSessions); observed.current = observedSessions;
  const visible = useRef(visibleKeys); visible.current = visibleKeys;
  useEffect(() => { setObservations(values => {
    let next = values;
    for (const key of visibleKeys) {
      if (!values[key]?.changed && !values[key]?.attention) continue;
      next = { ...next, [key]: { ...values[key]!, changed: false, attention: undefined } };
    }
    return next;
  }); }, [visibleKeys, setObservations]);
  useEffect(() => { setSelection({ scope: baseUrl, sessions: readTrackedSessions(baseUrl) }); setError(undefined); }, [baseUrl]);
  function toggle(session: SessionStar) {
    const key = sessionKey(session), previous = current.current;
    const exists = previous.some(item => sessionKey(item) === key);
    if (!exists && previous.length >= MAX_TRACKED_SESSIONS) { setError(`Track up to ${MAX_TRACKED_SESSIONS} sessions on this client. Untrack one to add another.`); return; }
    const next = exists ? previous.filter(item => sessionKey(item) !== key) : [...previous, session];
    try { saveTrackedSessions(baseUrl, next); setError(undefined); }
    catch { setError('Tracking changed for this page, but this browser could not save it for the next visit.'); }
    current.current = next; setSelection({ scope: baseUrl, sessions: next });
    if (exists && !visible.current.has(key)) setObservations(values => { const next = { ...values }; delete next[key]; return next; });
  }
  const update = useCallback((key: string, value: SessionObservation) => {
    if (!observed.current.some(item => sessionKey(item.session) === key)) return;
    setObservations(previous => {
      const next = nextObservation(previous[key], value), old = previous[key];
      if (visible.current.has(key)) { next.changed = false; next.attention = undefined; }
      return old && old.connection === next.connection && old.activity === next.activity && old.error === next.error && old.changed === next.changed && old.attention === next.attention && old.agentId === next.agentId && old.cursor?.epoch === next.cursor?.epoch && old.cursor?.seq === next.cursor?.seq ? previous : { ...previous, [key]: next };
    });
  }, [setObservations]);
  const acknowledge = useCallback((key: string) => setObservations(previous => {
    const value = previous[key];
    return value?.changed ? { ...previous, [key]: { ...value, changed: false, attention: undefined } } : previous;
  }), [setObservations]);
  const retry = (key: string) => { setObservations(values => { const next = { ...values }; delete next[key]; return next; }); setRetries(values => ({ ...values, [key]: (values[key] ?? 0) + 1 })); };
  const observers = useMemo(() => observedSessions.map(({ session, liveAgentId }) => <SessionObserver key={`${baseUrl}:${sessionKey(session)}:${retries[sessionKey(session)] ?? 0}`} session={session} liveAgentId={liveAgentId} baseUrl={baseUrl} transport={transport} update={update} />), [observedSessions, baseUrl, transport, update, retries]);
  useFeedbackToast('Session tracking', error);
  return { sessions, backgroundSessions, observations, error, toggle, retry, acknowledge, observers };
}
export type SessionTracking = ReturnType<typeof useSessionTracking>;

function SessionObserver({ session, liveAgentId, baseUrl, transport, update }: { session: SessionStar | OpenedSession; liveAgentId?: string; baseUrl: string; transport: RemoteAgentTransport; update(key: string, value: SessionObservation): void }) {
  const key = sessionKey(session);
  const binding = useRef<(agentId: string) => void>();
  useEffect(() => {
    const abort = new AbortController();
    const attachment = new AbortController();
    let client: RemoteActivityClient | undefined;
    let connectedAgentId: string | undefined;
    const start = (agentId: string) => {
      if (abort.signal.aborted || agentId === connectedAgentId) return;
      client?.stop();
      connectedAgentId = agentId;
      attachment.abort();
      client = new RemoteActivityClient(agentId, transport, value => {
        if (!abort.signal.aborted && connectedAgentId === agentId) update(key, { ...value, agentId });
      });
      client.start();
    };
    binding.current = start;
    update(key, { connection: 'connecting' });
    if (liveAgentId) start(liveAgentId);
    else {
      const directory = new SessionDirectoryClient(baseUrl, undefined, session.hostId);
      void (async () => {
        try {
          const signal = AbortSignal.any([abort.signal, attachment.signal, AbortSignal.timeout(35000)]);
          const attached = session.parentNativeSessionId
            ? await directory.attachChild(session.providerId, session.parentNativeSessionId, session.nativeSessionId, signal)
            : await directory.attach(session.providerId, session.nativeSessionId, signal);
          if (!connectedAgentId) start(attached.agentId);
        } catch (error) {
          if (!abort.signal.aborted && !connectedAgentId) update(key, { connection: 'disconnected', error: error instanceof Error ? error.message : 'Tracking could not connect. Try again.' });
        }
      })();
    }
    return () => { abort.abort(); client?.stop(); binding.current = undefined; };
    // Native identity owns the observer; moving between tracked and open must not restart it.
  }, [baseUrl, transport, key, update]);
  useEffect(() => { if (liveAgentId) binding.current?.(liveAgentId); }, [liveAgentId]);
  return null;
}
