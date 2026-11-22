// @vitest-environment node
import { expect, it } from 'vitest';
import { createSessionPresence } from './session-presence.js';

const session = { hostId: 'host', providerId: 'codex', nativeSessionId: 'thread' };

it('shows a session while a page of the account has a stream of it in use, and not after the stream ends', () => {
  const presence = createSessionPresence();
  let inUse = true;
  const release = presence.add('alice', session, () => inUse);
  expect(presence.shows('alice', session)).toBe(true);
  expect(presence.shows('bob', session)).toBe(false);
  expect(presence.shows('alice', { ...session, nativeSessionId: 'other' })).toBe(false);
  // The page is hidden, or shows another conversation: its intent report puts the stream out of use.
  inUse = false;
  expect(presence.shows('alice', session)).toBe(false);
  inUse = true;
  const second = presence.add('alice', session, () => false);
  release();
  expect(presence.shows('alice', session)).toBe(false);
  second();
  expect(presence.shows('alice', session)).toBe(false);
});
