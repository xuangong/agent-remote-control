/**
 * Web Push reminders (I5c, owner decisions of 2026-11-22): the Relay pushes two reminders to the devices an account subscribed, and
 * nothing else. An assistant needs the person (`needs_you`), or finished a turn while no page of the account showed it (`finished`).
 */
import type { AssistantReminder } from './window-groups.js';

export const PUSH_REMINDER_KINDS = ['needs_you', 'finished'] as const;
export type PushReminderKind = typeof PUSH_REMINDER_KINDS[number];

/** The push a page's reminder is: waiting for the person is "needs you", a finished turn is "finished". */
export const pushReminderKind = (reminder: AssistantReminder): PushReminderKind => reminder === 'waiting' ? 'needs_you' : 'finished';
