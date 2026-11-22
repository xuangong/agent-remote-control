import { afterEach, expect, it, vi } from 'vitest';
import { DirectoryError } from './directory-client.js';
import { UNAVAILABLE_SESSION_MS, unavailableSessions } from './unavailable-sessions.js';

afterEach(() => vi.useRealTimers());
const session = (nativeSessionId: string, hostId = 'host') => ({ hostId, providerId: 'codex', nativeSessionId });
const missing = () => new DirectoryError('The native runtime could not find this session.', 'native_session_unavailable', 404);

it('remembers what a Host reported missing for its page, for ten minutes', () => {
  vi.useFakeTimers();
  const page = {}, other = {};
  const error = missing();
  unavailableSessions(page).remember(session('A'), error);
  expect(unavailableSessions(page).get(session('A'))).toBe(error);
  expect(unavailableSessions(page).get(session('B'))).toBeUndefined();
  expect(unavailableSessions(page).get(session('A', 'other-host'))).toBeUndefined();
  expect(unavailableSessions(other).get(session('A'))).toBeUndefined();
  vi.advanceTimersByTime(UNAVAILABLE_SESSION_MS - 1);
  expect(unavailableSessions(page).get(session('A'))).toBe(error);
  vi.advanceTimersByTime(1);
  expect(unavailableSessions(page).get(session('A'))).toBeUndefined();
});

it('forgets a session on request, and every session of a Host that came back', () => {
  const page = {};
  const sessions = unavailableSessions(page);
  for (const id of ['A', 'B']) sessions.remember(session(id), missing());
  sessions.remember(session('C', 'other-host'), missing());
  sessions.forget(session('A'));
  expect(sessions.get(session('A'))).toBeUndefined();
  expect(sessions.get(session('B'))).toBeDefined();
  sessions.forgetHost('host');
  expect(sessions.get(session('B'))).toBeUndefined();
  expect(sessions.get(session('C', 'other-host'))).toBeDefined();
});

it('remembers only a missing native session, not other failures', () => {
  const sessions = unavailableSessions({});
  sessions.remember(session('A'), new DirectoryError('The Host is offline.', 'host_offline', 503));
  sessions.remember(session('B'), new Error('Network'));
  expect(sessions.get(session('A'))).toBeUndefined();
  expect(sessions.get(session('B'))).toBeUndefined();
});

it('counts the ten minutes from the Host\'s own report, not from reports this page replays', () => {
  vi.useFakeTimers();
  const sessions = unavailableSessions({}), error = missing();
  sessions.remember(session('A'), error);
  vi.advanceTimersByTime(UNAVAILABLE_SESSION_MS - 1_000);
  // A view replays the remembered report; that is not news from the Host.
  sessions.remember(session('A'), sessions.get(session('A')));
  vi.advanceTimersByTime(1_000);
  expect(sessions.get(session('A'))).toBeUndefined();
});
