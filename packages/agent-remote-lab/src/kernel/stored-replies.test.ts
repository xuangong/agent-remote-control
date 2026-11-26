import { afterEach, expect, it } from 'vitest';
import { readStoredReplies, writeStoredReplies } from './stored-replies.js';

afterEach(() => localStorage.clear());
const scope = 'https://relay.test/u/' + 'a'.repeat(64) + '/';

it('keeps the latest reply of each session for the next start', () => {
  writeStoredReplies(scope, new Map([['["h","claude","s1"]', { replyAt: 5, preview: 'Done.' }], ['["h","claude","s2"]', { replyAt: 9, preview: 'Ready.' }]]));
  expect([...readStoredReplies(scope)]).toEqual([['["h","claude","s1"]', { replyAt: 5, preview: 'Done.' }], ['["h","claude","s2"]', { replyAt: 9, preview: 'Ready.' }]]);
});

it('reads nothing from another Relay URL, a corrupt record or entries that are not replies', () => {
  writeStoredReplies(scope, new Map([['a', { replyAt: 1, preview: 'x' }]]));
  expect(readStoredReplies(scope.replace('a'.repeat(64), 'b'.repeat(64))).size).toBe(0);
  localStorage.setItem(`agent-remote:recovery:${scope}:replies`, '{not json');
  expect(readStoredReplies(scope).size).toBe(0);
  localStorage.setItem(`agent-remote:recovery:${scope}:replies`, JSON.stringify([['a', { replyAt: 'late', preview: 1 }], ['b', { replyAt: 2, preview: 'ok' }], 'junk']));
  expect([...readStoredReplies(scope)]).toEqual([['b', { replyAt: 2, preview: 'ok' }]]);
});
