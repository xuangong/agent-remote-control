import { conversationLocalStorage } from './conversation-storage.js';
import type { AgentStatus, TimelineCursor } from '@orchardworks/agent-remote-protocol';
import type { RemoteSessionStatus } from '@orchardworks/agent-remote-web';
import { validSessionStar, starKey, type SessionStar } from '@orchardworks/agent-remote-hosted/session-star-schema';
export interface SessionObservation { connection: RemoteSessionStatus; activity?: AgentStatus; cursor?: TimelineCursor; changed?: boolean; attention?: 'pending' | 'idle'; error?: string; agentId?: string }
export const MAX_TRACKED_SESSIONS = 8;
export function nextObservation(previous: SessionObservation | undefined, next: SessionObservation): SessionObservation {
  const activity = next.connection === 'ready' ? next.activity : undefined;
  const runtimeChanged = previous?.connection === 'ready' && next.connection === 'ready' && previous.activity !== undefined && activity !== undefined && previous.activity !== activity;
  const disconnected = previous?.connection === 'ready' && next.connection === 'disconnected';
  let attention = previous?.attention;
  if (runtimeChanged) {
    attention = activity === 'waiting' ? 'pending' : previous.activity === 'running' && activity === 'idle' ? 'idle' : undefined;
  } else if (next.connection === 'ready' && activity !== undefined) {
    // Retain an unread reminder across reconnect only while that state still applies.
    if ((attention === 'pending' && activity !== 'waiting') || (attention === 'idle' && activity !== 'idle')) attention = undefined;
  }
  return { ...next, activity, attention, changed: previous?.changed === true || runtimeChanged || disconnected };
}
export function readTrackedSessions(scope: string): SessionStar[] {
  try {
    const value: unknown = JSON.parse(conversationLocalStorage.getItem(`agent-remote-tracking:${scope}`) ?? '[]');
    if (!Array.isArray(value)) return [];
    return [...new Map(value.filter(validSessionStar).map(item => [starKey(item), item])).values()].slice(0, MAX_TRACKED_SESSIONS);
  } catch { return []; }
}
export function saveTrackedSessions(scope: string, sessions: SessionStar[]): void {
  conversationLocalStorage.setItem(`agent-remote-tracking:${scope}`, JSON.stringify(sessions.map(({ hostId, providerId, nativeSessionId, title, starredAt, parentNativeSessionId, workspace }) => ({ hostId, providerId, nativeSessionId, title, starredAt, parentNativeSessionId, workspace }))));
}
export function observationLabel(value?: SessionObservation): string {
  if (!value) return 'Connecting';
  if (value.error) return 'Connection failed';
  if (value.connection !== 'ready') return value.connection === 'disconnected' ? 'Disconnected' : 'Connecting';
  return value.activity === 'starting' ? 'Starting' : value.activity === 'running' ? 'Working' : value.activity === 'waiting' ? 'Waiting' : value.activity === 'failed' ? 'Failed' : value.activity === 'closed' ? 'Closed' : 'Ready';
}
