import { expect, it } from 'vitest';
import { ASSISTANT_REMINDER_VECTORS, SESSION_REMINDER_VECTORS } from '@orchardworks/agent-remote-protocol/testing';
import { decidePush } from './push-decision.js';
import { PUSH_DECISION_VECTORS } from './push-decision.vectors.js';

it.each(PUSH_DECISION_VECTORS)('$name', ({ input, decision }) => {
  expect(decidePush(input)).toEqual(decision);
});

// The pages' own tables: the Relay reminds of exactly the changes a page reminds of, for exactly the assistants that send them.
const DEVICE = { id: 'phone', signedIn: true };
const ASSISTANT = { group: { bots: { rank: 'm', members: {} } }, details: {} };
it.each(SESSION_REMINDER_VECTORS)('pushes for $before to $state what a page reminds of: $reminder', ({ before, state, reminder }) => {
  const decision = decidePush({ ...(before ? { before } : {}), ...(state ? { state } : {}), assistant: ASSISTANT, shown: false, sent: false, devices: [DEVICE] });
  expect('send' in decision ? decision.send : undefined).toBe(reminder === 'waiting' ? 'needs_you' : reminder === 'idle' ? 'finished' : undefined);
});
it.each(ASSISTANT_REMINDER_VECTORS)('a group set to $group and a chat set to $details push $reminders', ({ group, details, reminders }) => {
  const assistant = { group: group ? { bots: { rank: 'm', members: {}, ...group } } : {}, ...(details ? { details } : {}) };
  const pushes = (['waiting', 'idle'] as const).filter(state => 'send' in decidePush({ before: 'running', state, assistant, shown: false, sent: false, devices: [DEVICE] }));
  expect(pushes).toEqual(reminders);
});
