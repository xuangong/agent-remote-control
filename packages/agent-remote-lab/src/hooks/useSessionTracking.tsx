import type { ConversationConnections } from '../conversation-connections.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RemoteActivityClient, type RemoteAgentTransport } from '@orchardworks/agent-remote-web';
import { SessionDirectoryClient, type OpenedSession } from '../directory-client.js';
import { sessionKey } from '../session-tree.js';
import type { SessionStar } from '../session-stars-client.js';
import { MAX_TRACKED_SESSIONS, nextObservation, readTrackedSessions, saveTrackedSessions, type SessionObservation } from '../tracking-state.js';
import { useFeedbackToast } from '../components/Toast.js';

const noOpenSessions: readonly OpenedSession[] = [];
export interface AuxiliarySession { session: OpenedSession; liveAgentId?: string; visible: boolean }
const noAuxiliarySessions: readonly AuxiliarySession[] = [];

export function useSessionTracking(baseUrl: string, transport: RemoteAgentTransport, currentSessionKey?: string, openSessions: readonly OpenedSession[] = noOpenSessions, auxiliarySessions: readonly AuxiliarySession[] = noAuxiliarySessions, connections?: ConversationConnections, enabled = true) {
  const [selection, setSelection] = useState(() => ({ scope: baseUrl, sessions: readTrackedSessions(baseUrl) }));
  const sessions = useMemo(() => selection.scope === baseUrl ? selection.sessions : [], [selection, baseUrl]);
  useEffect(() => { connections?.retainTracked(enabled ? sessions : []); }, [connections, sessions, enabled]);
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
  const visibleKeys = useMemo(() => new Set([...openSessions.map(sessionKey), ...auxiliarySessions.filter(item => item.visible).map(item => sessionKey(item.session)), ...(currentSessionKey ? [currentSessionKey] : [])]), [openSessions, currentSessionKey, auxiliarySessions]);
  const auxiliaryKeys = useMemo(() => new Set(auxiliarySessions.map(item => sessionKey(item.session))), [auxiliarySessions]);
  const backgroundSessions = useMemo(() => sessions.filter(session => !visibleKeys.has(sessionKey(session)) && !auxiliaryKeys.has(sessionKey(session))), [sessions, visibleKeys, auxiliaryKeys]);
  const observedSessions = useMemo(() => {
    const union = new Map<string, { session: SessionStar | OpenedSession; liveAgentId?: string }>();
    for (const session of sessions) union.set(sessionKey(session), { session });
    for (const session of openSessions) union.set(sessionKey(session), { session, liveAgentId: session.agentId });
    for (const { session, liveAgentId } of auxiliarySessions) union.set(sessionKey(session), { session, liveAgentId: liveAgentId ?? union.get(sessionKey(session))?.liveAgentId });
    return [...union.values()];
  }, [sessions, openSessions, auxiliarySessions]);
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
  function reorder(key: string, targetKey: string, placement: 'before' | 'after') {
    const previous = current.current;
    const source = previous.find(session => sessionKey(session) === key);
    if (!source || key === targetKey || !previous.some(session => sessionKey(session) === targetKey)) return;
    const next = previous.filter(session => sessionKey(session) !== key);
    const index = next.findIndex(session => sessionKey(session) === targetKey);
    next.splice(index + (placement === 'after' ? 1 : 0), 0, source);
    if (next.every((session, index) => session === previous[index])) return;
    try { saveTrackedSessions(baseUrl, next); setError(undefined); }
    catch { setError('Tracking order changed for this page, but this browser could not save it for the next visit.'); }
    current.current = next; setSelection({ scope: baseUrl, sessions: next });
  }
  const rename = useCallback((session: import('@orchardworks/agent-remote-protocol').SessionTitleUpdate) => {
    const key = sessionKey(session);
    setSelection(previous => {
      if (previous.scope !== baseUrl || !previous.sessions.some(item => sessionKey(item) === key && item.title !== session.title)) return previous;
      const sessions = previous.sessions.map(item => sessionKey(item) === key ? { ...item, title: session.title } : item);
      try { saveTrackedSessions(baseUrl, sessions); } catch { /* Keep the confirmed title for this page. */ }
      return { ...previous, sessions };
    });
  }, [baseUrl]);
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
  const migrations = useRef({ scope: baseUrl, values: new Map<string, import('@orchardworks/agent-remote-protocol').SessionMigration>() });
  if (migrations.current.scope !== baseUrl) migrations.current = { scope: baseUrl, values: new Map() };
  function replace(migration: import('@orchardworks/agent-remote-protocol').SessionMigration) {
    migrations.current.values.set(sessionKey(migration.from), migration);
    const replacements = new Map(migrations.current.values);
    setSelection(value => {
      if (value.scope !== baseUrl || !value.sessions.some(item => replacements.has(sessionKey(item)))) return value;
      const next = new Map<string, SessionStar>();
      for (const item of value.sessions) {
        let updated = item;
        const visited = new Set<string>();
        for (let replacement = replacements.get(sessionKey(updated)); replacement && !visited.has(replacement.id); replacement = replacements.get(sessionKey(updated))) {
          visited.add(replacement.id);
          updated = { hostId: replacement.to.hostId, providerId: replacement.to.providerId, nativeSessionId: replacement.to.nativeSessionId,
            title: item.title, starredAt: item.starredAt, ...(item.workspace ? { workspace: item.workspace } : {}) };
        }
        next.set(sessionKey(updated), updated);
      }
      const sessions = [...next.values()];
      try { saveTrackedSessions(baseUrl, sessions); } catch { /* Keep the in-memory replacement when browser storage is unavailable. */ }
      return { ...value, sessions };
    });
  }
  const reconcileFavorites = useCallback((favorites: { scope: string; ready: boolean; stars: readonly SessionStar[] }) => {
    if (!enabled || !favorites.ready || favorites.scope !== baseUrl) return;
    const allowed = new Set(favorites.stars.map(sessionKey));
    // A migration can arrive before the refreshed favorites snapshot.
    for (const favorite of favorites.stars) {
      let key = sessionKey(favorite);
      const visited = new Set<string>();
      while (!visited.has(key)) {
        visited.add(key);
        const migration = migrations.current.values.get(key);
        if (!migration) break;
        key = sessionKey(migration.to);
        allowed.add(key);
      }
    }
    setSelection(previous => {
      if (previous.scope !== baseUrl) return previous;
      const sessions = previous.sessions.filter(session => allowed.has(sessionKey(session)));
      if (sessions.length === previous.sessions.length) return previous;
      try { saveTrackedSessions(baseUrl, sessions); }
      catch { setError('Tracking changed for this page, but this browser could not save it for the next visit.'); }
      return { ...previous, sessions };
    });
    setObservations(values => {
      const next = { ...values };
      for (const key of Object.keys(next)) {
        if (!allowed.has(key) && !visible.current.has(key) && !auxiliaryKeys.has(key)) delete next[key];
      }
      return next;
    });
  }, [baseUrl, enabled, setObservations, auxiliaryKeys]);
  const observers = useMemo(() => observedSessions.map(({ session, liveAgentId }) => <SessionObserver key={`${baseUrl}:${sessionKey(session)}:${retries[sessionKey(session)] ?? 0}`} session={session} liveAgentId={liveAgentId} baseUrl={baseUrl} transport={transport} update={update} />), [observedSessions, baseUrl, transport, update, retries]);
  useFeedbackToast('Session tracking', error);
  return { reorder, reconcileFavorites, rename, replace, sessions, backgroundSessions, observations, error, toggle, retry, acknowledge, observers };
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
