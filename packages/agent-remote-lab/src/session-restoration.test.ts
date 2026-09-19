import { afterEach, expect, it, vi } from 'vitest';
import { restoreSession } from './session-restoration.js';
import { DirectoryError } from './directory-client.js';

afterEach(() => vi.useRealTimers());

it('retries an offline host and stops after restoring its existing session', async () => {
  vi.useFakeTimers();
  const restored = vi.fn();
  let online = false;
  const open = vi.fn(async () => { if (!online) throw new DirectoryError('Offline', 'host_offline', 503); return 'existing-session'; });
  const stop = restoreSession({ active: () => true, open, restored, failed: vi.fn() });
  try {
    await vi.advanceTimersByTimeAsync(1);
    expect(restored).not.toHaveBeenCalled(); online = true;
    await vi.advanceTimersByTimeAsync(5000);
    expect(restored).toHaveBeenCalledWith('existing-session');
    await vi.advanceTimersByTimeAsync(20000);
    expect(open).toHaveBeenCalledTimes(2);
  } finally { stop(); }
});

it('does not restore an obsolete selection after navigation and does not retry denied access', async () => {
  vi.useFakeTimers();
  let active = true;
  let resolve!: (session: string) => void;
  const restored = vi.fn();
  const stop = restoreSession({ active: () => active, open: () => new Promise<string>(done => { resolve = done; }), restored, failed: vi.fn() });
  active = false; resolve('old-session'); await Promise.resolve();
  expect(restored).not.toHaveBeenCalled(); stop();
  const denied = vi.fn(async () => { throw new DirectoryError('Denied', 'host_forbidden', 403); });
  const failed = vi.fn();
  const cleanup = restoreSession({ active: () => true, open: denied, restored, failed });
  await vi.advanceTimersByTimeAsync(20000);
  expect(denied).toHaveBeenCalledTimes(1);
  expect(failed).toHaveBeenCalledWith(expect.any(DirectoryError), false);
  cleanup();
});


it('reports a browser wait deadline and retries only the existing session', async () => {
  vi.useFakeTimers();
  const failed = vi.fn(), restored = vi.fn();
  const open = vi.fn((signal: AbortSignal) => new Promise<string>((_resolve, reject) => {
    signal.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')));
  }));
  const stop = restoreSession({ active: () => true, open, failed, restored });
  try {
    await vi.advanceTimersByTimeAsync(15000);
    expect(failed).toHaveBeenCalledWith(expect.objectContaining({ code: 'session_attach_wait_timeout', status: 408 }), true);
    expect(restored).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(5000);
    expect(open).toHaveBeenCalledTimes(2);
  } finally { stop(); }
});
