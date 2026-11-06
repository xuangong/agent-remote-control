import type { AgentStatus } from '@orchardworks/agent-remote-protocol';
import type { SessionStateRef, SessionStatesView } from '@orchardworks/agent-remote-web';
import { sessionKey } from './session-tree.js';
import type { SessionObservation } from './tracking-state.js';

/** offline: the session's Host is not connected. unknown: no live or recently confirmed state. */
export type SessionActivityStatus = AgentStatus | 'unknown' | 'offline';

/** The status groups Track counts, in the order it shows them. */
export const activityGroups: readonly { status: SessionActivityStatus; label: string; activities: readonly SessionActivityStatus[] }[] = [
  { status: 'running', label: 'Working', activities: ['running'] },
  { status: 'waiting', label: 'Pending', activities: ['waiting', 'starting'] },
  { status: 'idle', label: 'Idle', activities: ['idle'] },
  { status: 'failed', label: 'Failed', activities: ['failed'] },
  { status: 'closed', label: 'Closed', activities: ['closed'] },
  { status: 'unknown', label: 'Status unavailable', activities: ['unknown'] },
  { status: 'offline', label: 'Host offline', activities: ['offline'] },
];

export function activityLabel(status: SessionActivityStatus): string {
  return activityGroups.find(group => group.activities.includes(status))?.label ?? 'Status unavailable';
}

/** Track's live observation when it has one, otherwise the state the Relay shares for the session. */
export function sessionActivity(session: SessionStateRef, observations?: Readonly<Record<string, SessionObservation>>, states?: SessionStatesView): SessionActivityStatus {
  const observed = observations?.[sessionKey(session)];
  if (observed?.connection === 'ready' && observed.activity) return observed.activity;
  return states?.state(session).state ?? 'unknown';
}

/** What a group of sessions most needs: pending, then failed, then working, then idle. Nothing when none is known. */
export function windowActivity(statuses: readonly SessionActivityStatus[]): 'waiting' | 'failed' | 'running' | 'idle' | undefined {
  if (statuses.some(status => status === 'waiting' || status === 'starting')) return 'waiting';
  if (statuses.includes('failed')) return 'failed';
  if (statuses.includes('running')) return 'running';
  return statuses.includes('idle') ? 'idle' : undefined;
}
