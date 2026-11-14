import type { SessionStatesView } from '@orchardworks/agent-remote-web';
import { sessionKey, type SessionEntry } from './session-tree.js';

export interface SharedReminder { session: SessionEntry; reminder: 'waiting' | 'idle'; identity: string }
type Known = 'running' | 'waiting' | 'idle' | 'failed';

/**
 * Bot mode's reminders, from the states the Relay shares instead of a stream per bot: a bot that starts waiting for its
 * owner, and one that finishes working. Only changes between known states count; an unknown state or an offline Host
 * keeps the last known one, so a bot coming back in the same state is not news. `previous` holds the last known states.
 */
export function sharedReminders(previous: ReadonlyMap<string, Known>, sessions: readonly SessionEntry[], view: SessionStatesView | undefined): { next: Map<string, Known>; reminders: SharedReminder[] } {
  const next = new Map<string, Known>(), reminders: SharedReminder[] = [];
  for (const session of sessions) {
    const key = sessionKey(session), before = previous.get(key);
    const shared = view?.state({ hostId: session.hostId ?? 'local', providerId: session.providerId, nativeSessionId: session.nativeSessionId });
    const state = shared && (shared.state === 'running' || shared.state === 'waiting' || shared.state === 'idle' || shared.state === 'failed') ? shared.state : before;
    if (!state) continue;
    next.set(key, state);
    if (!before || before === state) continue;
    const reminder = state === 'waiting' ? 'waiting' : before === 'running' && state === 'idle' ? 'idle' : undefined;
    if (!reminder) continue;
    // The same on every page: the reply that finished the turn, and the native update time.
    const reply = view?.reply({ hostId: session.hostId ?? 'local', providerId: session.providerId, nativeSessionId: session.nativeSessionId });
    reminders.push({ session, reminder, identity: JSON.stringify([reply?.replyAt ?? null, shared?.updatedAt ?? null]) });
  }
  return { next, reminders };
}
