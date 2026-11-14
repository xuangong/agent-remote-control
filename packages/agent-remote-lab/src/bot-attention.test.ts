import { expect, it } from 'vitest';
import { SessionStateStore } from '@orchardworks/agent-remote-web';
import { sharedReminders } from './bot-attention.js';

const bot = (id: string) => ({ hostId: 'host', providerId: 'codex', nativeSessionId: id, title: id, agentId: '' });
const store = new SessionStateStore();
const states = (entries: Array<[string, 'running' | 'waiting' | 'idle' | 'failed']>, online = true) => {
  store.apply({ protocolVersion: '1.8.0', type: 'session_states', snapshot: true, hosts: [{ hostId: 'host', online, confirmedAgeMs: 0 }],
    states: entries.map(([id, state]) => ({ hostId: 'host', providerId: 'codex', nativeSessionId: id, state, ageMs: 0, replyAt: 3, preview: 'Done.' })) });
  return store.view();
};

it('reminds when a bot starts waiting or finishes working, and not on first sight', () => {
  let result = sharedReminders(new Map(), [bot('a'), bot('b')], states([['a', 'running'], ['b', 'waiting']]));
  expect(result.reminders).toEqual([]);
  result = sharedReminders(result.next, [bot('a'), bot('b')], states([['a', 'idle'], ['b', 'running']]));
  expect(result.reminders.map(item => [item.session.nativeSessionId, item.reminder])).toEqual([['a', 'idle']]);
  result = sharedReminders(result.next, [bot('a'), bot('b')], states([['a', 'idle'], ['b', 'waiting']]));
  expect(result.reminders.map(item => [item.session.nativeSessionId, item.reminder])).toEqual([['b', 'waiting']]);
  // The same transition gets the same identity on every page.
  expect(result.reminders[0]!.identity).toBe(JSON.stringify([3, null]));
});

it('keeps the last known state through an offline Host, so coming back the same is not news', () => {
  let result = sharedReminders(new Map(), [bot('a')], states([['a', 'waiting']]));
  result = sharedReminders(result.next, [bot('a')], states([], false));
  expect(result.next.get(JSON.stringify(['host', 'codex', 'a']))).toBe('waiting');
  result = sharedReminders(result.next, [bot('a')], states([['a', 'waiting']]));
  expect(result.reminders).toEqual([]);
  result = sharedReminders(result.next, [bot('a')], states([['a', 'failed']]));
  expect(result.reminders).toEqual([]);
});
