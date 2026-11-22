import { expect, it } from 'vitest';
import { sessionReminder } from './session-states.js';
import { assistantReminders } from './window-groups.js';
import { ASSISTANT_REMINDER_VECTORS, SESSION_REMINDER_VECTORS } from './testing/reminders.vectors.js';

it.each(SESSION_REMINDER_VECTORS)('$before to $state reminds of $reminder', ({ before, state, reminder }) => {
  expect(sessionReminder(before, state)).toBe(reminder);
});

it.each(ASSISTANT_REMINDER_VECTORS)('a group set to $group and a chat set to $details send $reminders', ({ group, details, reminders }) => {
  expect(assistantReminders(group ? { bots: { rank: 'm', members: {}, ...group } } : undefined, details)).toEqual(reminders);
});
