import { clearCacheOnClose, conversationLocalStorage } from './conversation-storage.js';
import type { AgentStatus, TimelineCursor } from '@orchardworks/agent-remote-protocol';
import type { RemoteSessionStatus } from '@orchardworks/agent-remote-web';
import { validSessionStar, starKey, type SessionStar } from '@orchardworks/agent-remote-hosted/session-star-schema';
export interface SessionObservation { connection: RemoteSessionStatus; activity?: AgentStatus; background?: import('@orchardworks/agent-remote-protocol').BackgroundActivity; cursor?: TimelineCursor; changed?: boolean; attention?: 'pending' | 'idle'; error?: string; agentId?: string }
export const MAX_TRACKED_SESSIONS = 8;
export function nextObservation(previous: SessionObservation | undefined, next: SessionObservation, readCursor?: TimelineCursor): SessionObservation {
  const activity = next.connection === 'ready' ? next.activity : undefined;
  const runtimeChanged = previous?.connection === 'ready' && next.connection === 'ready' && previous.activity !== undefined && activity !== undefined && previous.activity !== activity;
  const observedCursor = next.connection === 'ready' ? next.cursor : undefined;
  const previousCursor = previous?.cursor;
  const replaced = !!observedCursor && !!previousCursor && observedCursor.epoch !== previousCursor.epoch;
  const progressed = !!observedCursor && !!previousCursor && !replaced && observedCursor.seq > previousCursor.seq;
  // Reconnects retain the content boundary; a different epoch establishes a new baseline.
  const cursor = !observedCursor || (previousCursor && !replaced && observedCursor.seq < previousCursor.seq) ? previousCursor : observedCursor;
  // The visible replica can receive content before its coalesced activity notification.
  const alreadyRead = !!cursor && readCursor?.epoch === cursor.epoch && readCursor.seq >= cursor.seq;
  let attention = previous?.attention;
  const visibleResult = next.background?.status === 'visible' && (next.background.id !== previous?.background?.id || previous?.background?.status !== 'visible');
  if (visibleResult && activity === 'idle') attention = 'idle';
  else if (runtimeChanged) {
    attention = activity === 'waiting' ? 'pending' : previous.activity === 'running' && activity === 'idle' ? 'idle' : undefined;
  } else if (next.connection === 'ready' && activity !== undefined) {
    // Retain an unread reminder across reconnect only while that state still applies.
    if ((attention === 'pending' && activity !== 'waiting') || (attention === 'idle' && activity !== 'idle')) attention = undefined;
  }
  if (next.background?.status === 'silent' && activity === 'idle') attention = undefined;
  return { ...next, activity, cursor, attention, changed: !replaced && !alreadyRead && (previous?.changed === true || progressed) };
}
export interface LocalTrackedSession extends SessionStar {
  entryId?: string;
  successionRole?: { controllerId: string; roleId: string; revision: number };
}
const trackEdits = new Map<string, number>();
export const trackingEditRevision = (scope: string) => trackEdits.get(scope) ?? 0;
const trackKey = (scope: string) => `agent-remote-tracking:${scope}`;
function localMetadata(value: LocalTrackedSession): Pick<LocalTrackedSession, 'entryId' | 'successionRole'> {
  return { ...(value.entryId ? { entryId: value.entryId } : {}), ...(value.successionRole ? { successionRole: { ...value.successionRole } } : {}) };
}
function validLocalTrack(value: unknown): value is LocalTrackedSession {
  if (!validSessionStar(value)) return false;
  const entry = value as LocalTrackedSession;
  return (entry.entryId === undefined || typeof entry.entryId === 'string' && !!entry.entryId)
    && (entry.successionRole === undefined || !!entry.successionRole && typeof entry.successionRole.controllerId === 'string' && !!entry.successionRole.controllerId
      && typeof entry.successionRole.roleId === 'string' && !!entry.successionRole.roleId && Number.isSafeInteger(entry.successionRole.revision) && entry.successionRole.revision >= 0);
}
export function readTrackedSessionsChecked(scope: string): { status: 'ready'; sessions: LocalTrackedSession[]; revision: number } | { status: 'failed'; error: unknown } {
  try {
    const value: unknown = JSON.parse(conversationLocalStorage.getItem(trackKey(scope)) ?? '[]');
    if (!Array.isArray(value) || !value.every(validLocalTrack) || value.length > MAX_TRACKED_SESSIONS
      || new Set(value.map(starKey)).size !== value.length || new Set(value.flatMap(item => item.entryId ? [item.entryId] : [])).size !== value.filter(item => item.entryId).length) throw new Error('Saved Track state is damaged or exceeds capacity.');
    return { status: 'ready', sessions: value, revision: trackingEditRevision(scope) };
  } catch (error) { return { status: 'failed', error }; }
}
export function readTrackedSessions(scope: string): LocalTrackedSession[] {
  try {
    const value: unknown = JSON.parse(conversationLocalStorage.getItem(trackKey(scope)) ?? '[]');
    if (!Array.isArray(value)) return [];
    return [...new Map(value.filter(validLocalTrack).map(item => [starKey(item), item])).values()].slice(0, MAX_TRACKED_SESSIONS);
  } catch { return []; }
}
function encodeTracks(sessions: readonly LocalTrackedSession[]): string {
  return JSON.stringify(sessions.map(({ hostId, providerId, nativeSessionId, title, starredAt, parentNativeSessionId, workspace, ...local }) =>
    ({ hostId, providerId, nativeSessionId, title, starredAt, parentNativeSessionId, workspace, ...localMetadata(local as LocalTrackedSession) })));
}
export function saveTrackedSessions(scope: string, sessions: LocalTrackedSession[]): void {
  trackEdits.set(scope, trackingEditRevision(scope) + 1);
  const previous = readTrackedSessions(scope);
  const next = sessions.map(item => ({ ...localMetadata(previous.find(value => starKey(value) === starKey(item)) ?? item), ...item }));
  conversationLocalStorage.setItem(trackKey(scope), encodeTracks(next));
}
export interface TrackedSessionPatch {
  entryId: string;
  from: Pick<SessionStar, 'hostId' | 'providerId' | 'nativeSessionId'>;
  to: Pick<SessionStar, 'hostId' | 'providerId' | 'nativeSessionId'>;
  successionRole?: LocalTrackedSession['successionRole'];
}
export type TrackWriteResult = { status: 'saved'; sessions: LocalTrackedSession[]; revision: number; retention: 'page' | 'local' }
  | { status: 'cancelled' | 'failed' | 'conflict'; retention: 'page' };
/** Final read, affected-ID patch and write are synchronous. This is not cross-tab CAS. */
export function patchTrackedSessions(scope: string, patches: readonly TrackedSessionPatch[], expectedRevision: number, isCurrent: () => boolean, retainedDuplicates: readonly string[] = []): TrackWriteResult {
  const current = () => isCurrent() && trackingEditRevision(scope) === expectedRevision;
  if (!current()) return { status: 'cancelled', retention: 'page' };
  const read = readTrackedSessionsChecked(scope);
  if (read.status !== 'ready') return { status: 'failed', retention: 'page' };
  const retained = new Set(retainedDuplicates);
  const next = read.sessions.filter(item => !(item.entryId && retained.has(item.entryId)) && !retained.has(starKey(item))).map(item => ({ ...item }));
  for (const patch of patches) {
    const item = next.find(item => item.entryId === patch.entryId || !item.entryId && starKey(item) === starKey(patch.from));
    if (!item || starKey(item) !== starKey(patch.from) && starKey(item) !== starKey(patch.to)) return { status: 'conflict', retention: 'page' };
    Object.assign(item, { hostId: patch.to.hostId, providerId: patch.to.providerId, nativeSessionId: patch.to.nativeSessionId }, { entryId: patch.entryId }, patch.successionRole ? { successionRole: patch.successionRole } : {});
  }
  const sessions = next;
  if (new Set(sessions.map(starKey)).size !== sessions.length || sessions.length > MAX_TRACKED_SESSIONS) return { status: 'conflict', retention: 'page' };
  try {
    const encoded = encodeTracks(sessions);
    if (!current()) return { status: 'cancelled', retention: 'page' };
    conversationLocalStorage.setItem(trackKey(scope), encoded);
    trackEdits.set(scope, expectedRevision + 1);
    return { status: 'saved', sessions, revision: expectedRevision + 1, retention: clearCacheOnClose() ? 'page' : 'local' };
  } catch { return { status: 'failed', retention: 'page' }; }
}
export function observationLabel(value?: SessionObservation): string {
  if (!value) return 'Connecting';
  if (value.error) return 'Connection failed';
  if (value.connection !== 'ready') return value.connection === 'disconnected' ? 'Disconnected' : 'Connecting';
  return value.activity === 'starting' ? 'Starting' : value.activity === 'running' ? 'Working' : value.activity === 'waiting' ? 'Waiting' : value.activity === 'failed' ? 'Failed' : value.activity === 'closed' ? 'Closed' : 'Ready';
}
