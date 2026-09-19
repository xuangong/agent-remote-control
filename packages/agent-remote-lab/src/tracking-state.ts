import type { AgentStatus } from '@agent-remote-controller/agent-remote-protocol';
import type { RemoteSessionStatus } from '@agent-remote-controller/agent-remote-web';
import { validSessionStar, starKey, type SessionStar } from '@agent-remote-controller/agent-remote-hosted/session-stars';
export interface SessionObservation { connection: RemoteSessionStatus; activity?: AgentStatus; changed?: boolean; error?: string; agentId?: string }
export const MAX_TRACKED_SESSIONS = 8;
export function nextObservation(previous: SessionObservation | undefined, next: SessionObservation): SessionObservation {
  const activity = next.connection === 'ready' ? next.activity : undefined;
  const runtimeChanged = previous?.connection === 'ready' && next.connection === 'ready' && previous.activity !== undefined && activity !== undefined && previous.activity !== activity;
  const disconnected = previous?.connection === 'ready' && next.connection === 'disconnected';
  return { ...next, activity, changed: previous?.changed === true || runtimeChanged || disconnected };
}
export function readTrackedSessions(scope: string): SessionStar[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(`agent-remote-tracking:${scope}`) ?? '[]');
    if (!Array.isArray(value)) return [];
    return [...new Map(value.filter(validSessionStar).map(item => [starKey(item), item])).values()].slice(0, MAX_TRACKED_SESSIONS);
  } catch { return []; }
}
export function saveTrackedSessions(scope: string, sessions: SessionStar[]): void {
  localStorage.setItem(`agent-remote-tracking:${scope}`, JSON.stringify(sessions.map(({ hostId, providerId, nativeSessionId, title, starredAt, parentNativeSessionId, workspace }) => ({ hostId, providerId, nativeSessionId, title, starredAt, parentNativeSessionId, workspace }))));
}
export function observationLabel(value?: SessionObservation): string {
  if (!value) return 'Connecting';
  if (value.error) return 'Connection failed';
  if (value.connection !== 'ready') return value.connection === 'disconnected' ? 'Disconnected' : 'Connecting';
  return value.activity === 'starting' ? 'Starting' : value.activity === 'running' ? 'Working' : value.activity === 'waiting' ? 'Waiting' : value.activity === 'failed' ? 'Failed' : value.activity === 'closed' ? 'Closed' : 'Ready';
}
