import type { ConversationConnections } from '../conversation-connections.js';
import type { TimelineCursor } from '@orchardworks/agent-remote-protocol';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { RemoteActivityClient, type RemoteActivityState, type RemoteAgentTransport } from '@orchardworks/agent-remote-web';
import { observeConversation } from '../conversation-activity.js';
import { SessionDirectoryClient, type OpenedSession } from '../directory-client.js';
import { sessionKey } from '../session-tree.js';
import type { SessionStar } from '../session-stars-client.js';
import { MAX_TRACKED_SESSIONS, nextObservation, readTrackedSessionsChecked, readTrackedSessions, saveTrackedSessions, type SessionObservation, patchTrackedSessions, trackingEditRevision, type TrackedSessionPatch, type LocalTrackedSession } from '../tracking-state.js';
import { useFeedbackToast } from '../components/Toast.js';
import { restoreSession } from '../session-restoration.js';

export type TrackRefreshResult =
  | { status: 'ready'; revision: number; sessions: readonly LocalTrackedSession[] }
  | { status: 'cancelled'; code: 'currentness' | 'revision' }
  | { status: 'failed'; code: 'track_read'; error: unknown };

const noOpenSessions: readonly OpenedSession[] = [];
export interface AuxiliarySession { session: OpenedSession; liveAgentId?: string; visible: boolean }
const noAuxiliarySessions: readonly AuxiliarySession[] = [];

export function useSessionTracking(baseUrl: string, transport: RemoteAgentTransport, currentSessionKey?: string, openSessions: readonly OpenedSession[] = noOpenSessions, auxiliarySessions: readonly AuxiliarySession[] = noAuxiliarySessions, connections?: ConversationConnections, enabled = true, visibleSessions?: readonly OpenedSession[], onObservation?: (session: SessionStar | OpenedSession, value: SessionObservation) => void) {
  const [selection, setSelection] = useState(() => ({ scope: baseUrl, sessions: readTrackedSessions(baseUrl) }));
  const sessions = useMemo(() => selection.scope === baseUrl ? selection.sessions : [], [selection, baseUrl]);
  const [observationState, setObservationState] = useState<{ scope: string; transport: RemoteAgentTransport; values: Record<string, SessionObservation> }>(() => ({ scope: baseUrl, transport, values: {} }));
  const observations = observationState.scope === baseUrl && observationState.transport === transport ? observationState.values : {};
  const latestObservations = useRef(observations); latestObservations.current = observations;
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
  const visibleIdentity = JSON.stringify([...new Set([
    ...(visibleSessions ?? openSessions).map(sessionKey),
    ...auxiliarySessions.filter(item => item.visible).map(item => sessionKey(item.session)),
    ...(visibleSessions === undefined && currentSessionKey ? [currentSessionKey] : []),
  ])].sort());
  const visibleKeys = useMemo(() => new Set<string>(JSON.parse(visibleIdentity)), [visibleIdentity]);
  const auxiliaryKeys = useMemo(() => new Set(auxiliarySessions.map(item => sessionKey(item.session))), [auxiliarySessions]);
  const backgroundSessions = useMemo(() => sessions.filter(session => !visibleKeys.has(sessionKey(session)) && !auxiliaryKeys.has(sessionKey(session))), [sessions, visibleKeys, auxiliaryKeys]);
  const observedSessions = useMemo(() => {
    const union = new Map<string, { session: SessionStar | OpenedSession; liveAgentId?: string }>();
    for (const session of sessions) union.set(sessionKey(session), { session });
    for (const session of openSessions) union.set(sessionKey(session), { session, liveAgentId: session.agentId });
    for (const { session, liveAgentId } of auxiliarySessions) union.set(sessionKey(session), { session, liveAgentId: liveAgentId ?? union.get(sessionKey(session))?.liveAgentId });
    return [...union.values()];
  }, [sessions, openSessions, auxiliarySessions]);
  const current = useRef(sessions);
  const currentScope = useRef(baseUrl);
  const lifetime = useMemo(() => ({ mounted: true }), [baseUrl, transport]);
  const latestLifetime = useRef(lifetime); latestLifetime.current = lifetime;
  const publication = useRef(0);
  if (currentScope.current !== baseUrl) {
    currentScope.current = baseUrl;
    current.current = readTrackedSessions(baseUrl);
    publication.current++;
    setSelection({ scope: baseUrl, sessions: current.current });
  }
  const mutationCurrent = useCallback(() => latestLifetime.current === lifetime && lifetime.mounted && currentScope.current === baseUrl, [baseUrl, lifetime]);
  useEffect(() => { lifetime.mounted = true; return () => { lifetime.mounted = false; }; }, [lifetime]);
  const publishSelection = useCallback((sessions: LocalTrackedSession[], guard: () => boolean = () => true) => {
    const token = ++publication.current, before = current.current;
    current.current = sessions;
    setSelection(previous => {
      if (publication.current !== token || latestLifetime.current !== lifetime || !lifetime.mounted || !guard()) {
        if (publication.current === token && current.current === sessions) current.current = before;
        return previous;
      }
      return { scope: baseUrl, sessions };
    });
  }, [baseUrl, lifetime]);
  const refresh = useCallback((expectedRevision: number, isCurrent: () => boolean): TrackRefreshResult => {
    const live = () => latestLifetime.current === lifetime && lifetime.mounted && isCurrent();
    if (!live()) return { status: 'cancelled', code: 'currentness' };
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0 || trackingEditRevision(baseUrl) !== expectedRevision) return { status: 'cancelled', code: 'revision' };
    const read = readTrackedSessionsChecked(baseUrl);
    if (read.status !== 'ready') return { status: 'failed', code: 'track_read', error: read.error };
    if (!live()) return { status: 'cancelled', code: 'currentness' };
    if (read.revision !== expectedRevision || trackingEditRevision(baseUrl) !== expectedRevision) return { status: 'cancelled', code: 'revision' };
    const sessions = structuredClone(read.sessions);
    publishSelection(sessions, () => live() && trackingEditRevision(baseUrl) === expectedRevision);
    return { status: 'ready', revision: expectedRevision, sessions: structuredClone(sessions) };
  }, [baseUrl, lifetime, publishSelection]);
  const observed = useRef(observedSessions); observed.current = observedSessions;
  const visible = useRef(visibleKeys); visible.current = visibleKeys;
  // Read receipts are local to this transport and do not render on every streamed token.
  const readCursorState = useRef({ scope: baseUrl, transport, values: new Map<string, TimelineCursor>() });
  if (readCursorState.current.scope !== baseUrl || readCursorState.current.transport !== transport) {
    readCursorState.current = { scope: baseUrl, transport, values: new Map() };
  }
  const readCursors = readCursorState.current.values;
  const captureVisibleCursor = useCallback((key: string) => {
    if (!visible.current.has(key) || document.visibilityState === 'hidden') return;
    const session = observed.current.find(item => sessionKey(item.session) === key)?.session;
    const timeline = session && connections?.find(session)?.replica.getState().timeline;
    if (!timeline?.initialized || !timeline.epoch) return;
    const previous = readCursors.get(key);
    if (previous?.epoch !== timeline.epoch || previous.seq < timeline.nextSeq - 1) {
      readCursors.set(key, { epoch: timeline.epoch, seq: timeline.nextSeq - 1 });
    }
  }, [connections, readCursors]);
  const acknowledgeVisible = useCallback((key: string, value: SessionObservation): SessionObservation => {
    if ((!value.changed && !value.attention) || !visible.current.has(key) || document.visibilityState === 'hidden') return value;
    if (connections) {
      const session = observed.current.find(item => sessionKey(item.session) === key)?.session;
      const timeline = session && connections.find(session)?.replica.getState().timeline;
      // Opening a view is not a read receipt until its replica has received the notified content.
      if (!timeline?.initialized || (value.cursor && (timeline.epoch !== value.cursor.epoch || timeline.nextSeq - 1 < value.cursor.seq))) return value;
    }
    return { ...value, changed: false, attention: undefined };
  }, [connections]);
  const acknowledgeVisibleSessions = useCallback(() => {
    for (const key of visible.current) captureVisibleCursor(key);
    if (![...visible.current].some(key => latestObservations.current[key]?.changed || latestObservations.current[key]?.attention)) return;
    setObservations(values => {
      let next = values;
      for (const key of visible.current) {
        const value = values[key];
        if (!value) continue;
        const acknowledged = acknowledgeVisible(key, value);
        if (acknowledged !== value) next = { ...next, [key]: acknowledged };
      }
      return next;
    });
  }, [captureVisibleCursor, acknowledgeVisible, setObservations]);
  useEffect(() => {
    const subscriptions = new Map<string, { replica: import('@orchardworks/agent-remote-web').AgentReplica; stop(): void }>();
    const refresh = () => {
      for (const key of visibleKeys) {
        const session = observed.current.find(item => sessionKey(item.session) === key)?.session;
        const replica = session && connections?.find(session)?.replica;
        const previous = subscriptions.get(key);
        if (previous?.replica === replica) continue;
        previous?.stop(); subscriptions.delete(key);
        if (replica) subscriptions.set(key, { replica, stop: replica.subscribe(acknowledgeVisibleSessions) });
      }
      acknowledgeVisibleSessions();
    };
    const stop = connections?.subscribe(refresh);
    refresh();
    document.addEventListener('visibilitychange', acknowledgeVisibleSessions);
    return () => {
      stop?.();
      for (const subscription of subscriptions.values()) subscription.stop();
      document.removeEventListener('visibilitychange', acknowledgeVisibleSessions);
    };
  }, [visibleKeys, connections, acknowledgeVisibleSessions]);
  useEffect(() => { setError(undefined); }, [baseUrl]);
  function toggle(session: SessionStar) {
    if (!mutationCurrent()) return;
    const key = sessionKey(session), previous = current.current;
    const exists = previous.some(item => sessionKey(item) === key);
    if (!exists && previous.length >= MAX_TRACKED_SESSIONS) { setError(`Track up to ${MAX_TRACKED_SESSIONS} sessions on this client. Untrack one to add another.`); return; }
    const next = exists ? previous.filter(item => sessionKey(item) !== key) : [...previous, session];
    try { saveTrackedSessions(baseUrl, next); setError(undefined); }
    catch { setError('Tracking changed for this page, but this browser could not save it for the next visit.'); }
    publishSelection(next);
    if (exists && !visible.current.has(key)) {
      readCursors.delete(key);
      setObservations(values => { const next = { ...values }; delete next[key]; return next; });
    }
  }
  function reorder(key: string, targetKey: string, placement: 'before' | 'after') {
    if (!mutationCurrent()) return;
    const previous = current.current;
    const source = previous.find(session => sessionKey(session) === key);
    if (!source || key === targetKey || !previous.some(session => sessionKey(session) === targetKey)) return;
    const next = previous.filter(session => sessionKey(session) !== key);
    const index = next.findIndex(session => sessionKey(session) === targetKey);
    next.splice(index + (placement === 'after' ? 1 : 0), 0, source);
    if (next.every((session, index) => session === previous[index])) return;
    try { saveTrackedSessions(baseUrl, next); setError(undefined); }
    catch { setError('Tracking order changed for this page, but this browser could not save it for the next visit.'); }
    publishSelection(next);
  }
  const rename = useCallback((session: Pick<import('@orchardworks/agent-remote-protocol').SessionTitleUpdate, 'hostId' | 'providerId' | 'nativeSessionId' | 'title'>) => {
    if (!mutationCurrent()) return;
    const key = sessionKey(session);
    const previous = current.current;
    if (!previous.some(item => sessionKey(item) === key && item.title !== session.title)) return;
    const sessions = previous.map(item => sessionKey(item) === key ? { ...item, title: session.title } : item);
    try { saveTrackedSessions(baseUrl, sessions); } catch { /* Keep the confirmed title for this page. */ }
    publishSelection(sessions);
  }, [baseUrl, publishSelection, mutationCurrent]);
  const onObservationRef = useRef(onObservation); onObservationRef.current = onObservation;
  const update = useCallback((key: string, value: SessionObservation) => {
    const target = observed.current.find(item => sessionKey(item.session) === key);
    if (!target) return;
    onObservationRef.current?.(target.session, value);
    captureVisibleCursor(key);
    setObservations(previous => {
      const next = acknowledgeVisible(key, nextObservation(previous[key], value, readCursors.get(key))), old = previous[key];
      return old && old.connection === next.connection && old.activity === next.activity && old.background?.id === next.background?.id && old.background?.status === next.background?.status && old.error === next.error && old.changed === next.changed && old.attention === next.attention && old.agentId === next.agentId && old.cursor?.epoch === next.cursor?.epoch && old.cursor?.seq === next.cursor?.seq ? previous : { ...previous, [key]: next };
    });
  }, [setObservations, acknowledgeVisible, captureVisibleCursor, readCursors]);
  const acknowledge = useCallback((key: string) => setObservations(previous => {
    const value = previous[key];
    return value?.changed || value?.attention ? { ...previous, [key]: { ...value, changed: false, attention: undefined } } : previous;
  }), [setObservations]);
  const retry = (key: string) => { setObservations(values => { const next = { ...values }; delete next[key]; return next; }); setRetries(values => ({ ...values, [key]: (values[key] ?? 0) + 1 })); };
  const migrations = useRef({ scope: baseUrl, values: new Map<string, import('@orchardworks/agent-remote-protocol').SessionMigration>() });
  if (migrations.current.scope !== baseUrl) migrations.current = { scope: baseUrl, values: new Map() };
  function replace(migration: import('@orchardworks/agent-remote-protocol').SessionMigration) {
    if (!mutationCurrent()) return;
    if (migrations.current.values.has(migration.id)) return;
    migrations.current.values.set(migration.id, migration);
    const replacements = new Map([...migrations.current.values.values()]
      .sort((a, b) => a.createdAt - b.createdAt).map(value => [sessionKey(value.from), value]));
    const value = current.current;
      if (!value.some(item => replacements.has(sessionKey(item)))) return;
      const next = new Map<string, LocalTrackedSession>();
      for (const item of value) {
        let updated = item;
        const visited = new Set<string>();
        for (let replacement = replacements.get(sessionKey(updated)); replacement && !visited.has(replacement.id); replacement = replacements.get(sessionKey(updated))) {
          visited.add(replacement.id);
          updated = { ...item, parentNativeSessionId: undefined, hostId: replacement.to.hostId, providerId: replacement.to.providerId, nativeSessionId: replacement.to.nativeSessionId,
            title: item.title, starredAt: item.starredAt, ...(item.workspace ? { workspace: item.workspace } : {}) };
        }
        next.set(sessionKey(updated), updated);
      }
      const sessions = [...next.values()];
      try { saveTrackedSessions(baseUrl, sessions); } catch { /* Keep the in-memory replacement when browser storage is unavailable. */ }
      publishSelection(sessions);
  }
  const reconcileFavorites = useCallback((favorites: { scope: string; ready: boolean; stars: readonly SessionStar[] }) => {
    if (!mutationCurrent() || !enabled || !favorites.ready || favorites.scope !== baseUrl) return;
    const allowed = new Set(favorites.stars.map(sessionKey));
    // A migration can arrive before the refreshed favorites snapshot.
    const branches = new Map<string, Set<string>>();
    for (const migration of migrations.current.values.values()) {
      const source = sessionKey(migration.from);
      const targets = branches.get(source) ?? new Set<string>();
      targets.add(sessionKey(migration.to)); branches.set(source, targets);
    }
    // Sibling forks remain independent while the favorites snapshot catches up.
    const pending = [...allowed];
    for (let index = 0; index < pending.length; index++) {
      for (const target of branches.get(pending[index]!) ?? []) {
        if (allowed.has(target)) continue;
        allowed.add(target); pending.push(target);
      }
    }
    const previous = current.current;
    const sessions = previous.filter(session => allowed.has(sessionKey(session)));
    if (sessions.length !== previous.length) {
      try { saveTrackedSessions(baseUrl, sessions); }
      catch { setError('Tracking changed for this page, but this browser could not save it for the next visit.'); }
      publishSelection(sessions);
    }
    setObservations(values => {
      const next = { ...values };
      for (const key of Object.keys(next)) {
        if (!allowed.has(key) && !visible.current.has(key) && !auxiliaryKeys.has(key)) { delete next[key]; readCursors.delete(key); }
      }
      return next;
    });
  }, [baseUrl, enabled, setObservations, auxiliaryKeys, readCursors, publishSelection, mutationCurrent]);
  function project(patches: readonly TrackedSessionPatch[], expectedRevision: number, isCurrent: () => boolean, retainedDuplicates: readonly string[] = []) {
    // Projection persists navigation intent. The later explicit consumer owns attachment.
    return patchTrackedSessions(baseUrl, patches, expectedRevision, isCurrent, retainedDuplicates);
  }
  const observers = useMemo(() => observedSessions.map(({ session, liveAgentId }) => <SessionObserver key={`${baseUrl}:${sessionKey(session)}:${retries[sessionKey(session)] ?? 0}`} session={session} liveAgentId={liveAgentId} baseUrl={baseUrl} transport={transport} connections={connections} update={update} enabled={enabled} />), [observedSessions, baseUrl, transport, connections, update, retries, enabled]);
  useFeedbackToast('Session tracking', error);
  return { refresh, project, editRevision: () => trackingEditRevision(baseUrl), reorder, reconcileFavorites, rename, replace, sessions, backgroundSessions, observations, error, toggle, retry, acknowledge, observers };
}
export type SessionTracking = ReturnType<typeof useSessionTracking>;

function SessionObserver({ session, liveAgentId, baseUrl, transport, connections, update, enabled }: { session: SessionStar | OpenedSession; liveAgentId?: string; baseUrl: string; transport: RemoteAgentTransport; connections?: ConversationConnections; update(key: string, value: SessionObservation): void; enabled: boolean }) {
  const key = sessionKey(session);
  const binding = useRef<(agentId: string) => void>();
  const attachment = useRef<(enabled: boolean) => void>();
  useEffect(() => {
    const abort = new AbortController();
    let stopAttachment: (() => void) | undefined;
    // A shown conversation's own connection reports its activity, so one session holds one stream;
    // otherwise an activity-only subscription does.
    let source: { shown: boolean; stop(): void } | undefined;
    let connectedAgentId: string | undefined;
    const stopSource = () => { source?.stop(); source = undefined; };
    const choose = () => {
      const agentId = connectedAgentId;
      if (abort.signal.aborted || !agentId) return;
      const shown = connections?.shown(session, agentId);
      if (source && source.shown === !!shown) return;
      stopSource();
      const report = (value: RemoteActivityState) => {
        if (!abort.signal.aborted && connectedAgentId === agentId) update(key, { ...value, agentId });
      };
      if (shown) { source = { shown: true, stop: observeConversation(shown, report) }; return; }
      const client = new RemoteActivityClient(agentId, transport, report);
      client.start();
      source = { shown: false, stop: () => client.stop() };
    };
    const unwatchConnections = connections?.subscribe(choose);
    const start = (agentId: string) => {
      if (abort.signal.aborted || agentId === connectedAgentId) return;
      stopSource();
      connectedAgentId = agentId;
      stopAttachment?.(); stopAttachment = undefined;
      choose();
    };
    binding.current = start;
    update(key, { connection: 'connecting' });
    attachment.current = ready => {
      stopAttachment?.(); stopAttachment = undefined;
      if (!ready || connectedAgentId) return;
      const attached = connections?.find(session);
      if (attached) { start(attached.agentId); return; }
      const directory = new SessionDirectoryClient(baseUrl, undefined, session.hostId);
      update(key, { connection: 'connecting' });
      stopAttachment = restoreSession({
        active: () => !abort.signal.aborted && !connectedAgentId,
        open: signal => session.parentNativeSessionId
          ? directory.attachChild(session.providerId, session.parentNativeSessionId, session.nativeSessionId, signal)
          : directory.attach(session.providerId, session.nativeSessionId, signal),
        restored: attached => start(attached.agentId),
        failed: error => update(key, { connection: 'disconnected', error: error instanceof Error ? error.message : 'Tracking could not connect. Try again.' }),
      });
    };
    return () => { abort.abort(); stopAttachment?.(); unwatchConnections?.(); stopSource(); binding.current = undefined; attachment.current = undefined; };
    // Native identity owns the observer; moving between tracked and open must not restart it.
  }, [baseUrl, transport, connections, key, update]);
  useEffect(() => {
    if (enabled && liveAgentId) binding.current?.(liveAgentId);
    attachment.current?.(enabled);
  }, [baseUrl, transport, key, update, enabled, liveAgentId]);
  return null;
}
