import { afterEach, expect, it, vi } from 'vitest';
import { conversationLocalStorage, conversationSessionStorage, setClearCacheOnClose } from './conversation-storage.js';
import { cancelRecoveryWrites, flushRecoveryWrites, queueRecoveryWrite } from './recovery-writes.js';

const key = 'agent-remote:recovery:write-results:drafts';
afterEach(async () => {
  cancelRecoveryWrites(''); vi.restoreAllMocks(); vi.useRealTimers();
  await setClearCacheOnClose(false);
  conversationSessionStorage.removeItem(key); conversationLocalStorage.removeItem(key);
});

it('acknowledges only the latest coalesced value after its 200 ms storage write', async () => {
  vi.useFakeTimers();
  const first = queueRecoveryWrite(key, () => 'first');
  const latest = queueRecoveryWrite(key, () => 'latest');
  await expect(first.completion).resolves.toMatchObject({ status: 'superseded', ticket: first.ticket });
  expect(latest.result).toBeUndefined();
  expect(sessionStorage.getItem(key)).toBeNull();
  await vi.advanceTimersByTimeAsync(199);
  expect(latest.result).toBeUndefined();
  await vi.advanceTimersByTimeAsync(1);
  expect(sessionStorage.getItem(key)).toBe('latest');
  await expect(latest.completion).resolves.toEqual({ status: 'saved', ticket: latest.ticket, retention: 'session' });
  expect(latest.result).toEqual(await latest.completion);
});

it('keeps the boolean durable argument and reports partial storage failure', async () => {
  const denied = new Error('Local storage full');
  vi.spyOn(conversationLocalStorage, 'setItem').mockImplementation(() => { throw denied; });
  const handle = queueRecoveryWrite(key, () => 'recoverable', true);
  flushRecoveryWrites(key);
  expect(sessionStorage.getItem(key)).toBe('recoverable');
  expect(localStorage.getItem(key)).toBeNull();
  await expect(handle.completion).resolves.toEqual({ status: 'failed', ticket: handle.ticket, error: denied, sessionWritten: true, localWritten: false });
});

it('reports serialization failure without replacing prior recovery data', async () => {
  sessionStorage.setItem(key, 'prior');
  const error = new Error('Cannot serialize');
  const handle = queueRecoveryWrite(key, () => { throw error; });
  expect(() => flushRecoveryWrites(key)).not.toThrow();
  expect(sessionStorage.getItem(key)).toBe('prior');
  await expect(handle.completion).resolves.toMatchObject({ status: 'failed', error, sessionWritten: false, localWritten: false });
});

it('settles cancelled handles and never writes them on a later page hide', async () => {
  const handle = queueRecoveryWrite(key, () => 'private');
  cancelRecoveryWrites('agent-remote:recovery:write-results:');
  window.dispatchEvent(new Event('pagehide'));
  await expect(handle.completion).resolves.toEqual({ status: 'cancelled', ticket: handle.ticket });
  expect(sessionStorage.getItem(key)).toBeNull();
});

it('does not let a reentrant serializer overwrite the newer queued value', async () => {
  let next: ReturnType<typeof queueRecoveryWrite>;
  const previous = queueRecoveryWrite(key, () => {
    next = queueRecoveryWrite(key, () => 'new');
    flushRecoveryWrites(key);
    return 'old';
  });
  flushRecoveryWrites(key);
  expect(sessionStorage.getItem(key)).toBe('new');
  await expect(previous.completion).resolves.toMatchObject({ status: 'superseded' });
  await expect(next!.completion).resolves.toMatchObject({ status: 'saved' });
});

it('fences a scope change during serialization before writing', async () => {
  let active = true;
  const handle = queueRecoveryWrite(key, () => { active = false; return 'retired'; }, { isCurrent: () => active });
  flushRecoveryWrites(key);
  expect(sessionStorage.getItem(key)).toBeNull();
  await expect(handle.completion).resolves.toMatchObject({ status: 'cancelled' });
});

it('fences a scope change before publishing a storage result', async () => {
  let active = true;
  const setItem = conversationSessionStorage.setItem.bind(conversationSessionStorage);
  vi.spyOn(conversationSessionStorage, 'setItem').mockImplementation((name, value) => {
    setItem(name, value); active = false;
  });
  const handle = queueRecoveryWrite(key, () => 'retired', { durable: true, isCurrent: () => active });
  flushRecoveryWrites(key);
  expect(localStorage.getItem(key)).toBeNull();
  await expect(handle.completion).resolves.toMatchObject({ status: 'cancelled' });
});

it('reports protected page retention without claiming a disk save', async () => {
  await setClearCacheOnClose(true);
  const handle = queueRecoveryWrite(key, () => 'page only', true);
  flushRecoveryWrites(key);
  expect(conversationSessionStorage.getItem(key)).toBe('page only');
  expect(conversationLocalStorage.getItem(key)).toBe('page only');
  expect(sessionStorage.getItem(key)).toBeNull(); expect(localStorage.getItem(key)).toBeNull();
  await expect(handle.completion).resolves.toMatchObject({ status: 'saved', retention: 'page' });
});

it('completes durable writes only after both required storage calls', async () => {
  const handle = queueRecoveryWrite(key, () => 'durable', true);
  flushRecoveryWrites(key);
  expect(sessionStorage.getItem(key)).toBe('durable'); expect(localStorage.getItem(key)).toBe('durable');
  await expect(handle.completion).resolves.toMatchObject({ status: 'saved', retention: 'local' });
});

it('retains prior contents and reports no completed writes when session storage is denied', async () => {
  sessionStorage.setItem(key, 'prior'); localStorage.setItem(key, 'prior');
  vi.spyOn(conversationSessionStorage, 'setItem').mockImplementation(() => { throw new Error('Denied'); });
  const handle = queueRecoveryWrite(key, () => 'new', true);
  flushRecoveryWrites(key);
  expect(sessionStorage.getItem(key)).toBe('prior'); expect(localStorage.getItem(key)).toBe('prior');
  await expect(handle.completion).resolves.toMatchObject({ status: 'failed', sessionWritten: false, localWritten: false });
});

it('schedules a new batch when a serializer queues a replacement during timer flush', async () => {
  vi.useFakeTimers();
  let replacement: ReturnType<typeof queueRecoveryWrite>;
  const previous = queueRecoveryWrite(key, () => {
    replacement = queueRecoveryWrite(key, () => 'next batch');
    return 'stale batch';
  });
  await vi.advanceTimersByTimeAsync(200);
  expect(sessionStorage.getItem(key)).toBeNull();
  await expect(previous.completion).resolves.toMatchObject({ status: 'superseded' });
  expect(replacement!.result).toBeUndefined();
  await vi.advanceTimersByTimeAsync(200);
  expect(sessionStorage.getItem(key)).toBe('next batch');
  await expect(replacement!.completion).resolves.toMatchObject({ status: 'saved' });
});
