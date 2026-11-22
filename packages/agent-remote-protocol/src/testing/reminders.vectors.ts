import type { SessionActivityState } from '../session-states.js';
import type { AssistantReminder, WindowBotDetails, WindowBots } from '../window-groups.js';

/**
 * When a session's change of state is worth a reminder (`sessionReminder`): every pair of a last known state (or none) and a reported
 * one. Read by the protocol's test, by the Workbench's reminders from the shared states (`sharedReminders`) and by the Relay's push
 * decision, so a page and the Relay remind of the same changes.
 */
export const SESSION_REMINDER_VECTORS: readonly { readonly before?: SessionActivityState; readonly state?: SessionActivityState; readonly reminder?: 'waiting' | 'idle' }[] = [
  { state: 'waiting' }, { state: 'idle' }, { before: 'waiting' },
  { before: 'running', state: 'waiting', reminder: 'waiting' }, { before: 'idle', state: 'waiting', reminder: 'waiting' }, { before: 'failed', state: 'waiting', reminder: 'waiting' },
  { before: 'running', state: 'idle', reminder: 'idle' },
  { before: 'waiting', state: 'idle' }, { before: 'failed', state: 'idle' }, { before: 'running', state: 'failed' }, { before: 'waiting', state: 'running' },
  { before: 'idle', state: 'running' }, { before: 'running', state: 'running' }, { before: 'waiting', state: 'waiting' }, { before: 'idle', state: 'idle' },
];

/** Which reminders an assistant sends for its group's settings and its chat's details (`assistantReminders`). Read by the same consumers. */
export const ASSISTANT_REMINDER_VECTORS: readonly { readonly group?: Pick<WindowBots, 'muted' | 'notifications'>; readonly details?: WindowBotDetails; readonly reminders: readonly AssistantReminder[] }[] = [
  { reminders: ['waiting', 'idle'] },
  { group: {}, details: {}, reminders: ['waiting', 'idle'] },
  { group: { notifications: 'all' }, details: {}, reminders: ['waiting', 'idle'] },
  { group: { notifications: 'needs_you' }, details: {}, reminders: ['waiting'] },
  { group: { muted: true }, details: {}, reminders: [] },
  { group: {}, details: { muted: true }, reminders: [] },
  { group: { notifications: 'needs_you' }, details: { muted: true }, reminders: [] },
  { group: { muted: true, notifications: 'needs_you' }, reminders: [] },
];
