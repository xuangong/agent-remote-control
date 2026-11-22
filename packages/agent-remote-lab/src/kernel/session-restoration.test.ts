import { afterEach, expect, it, vi } from 'vitest';
import { announceHostReturned, restoreSession } from './session-restoration.js';
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

it('stops automatic restoration after native session unavailability even when the browser reconnects', async () => {
  vi.useFakeTimers();
  const error = new DirectoryError('The native runtime could not find this session.', 'native_session_unavailable', 404);
  const open = vi.fn(async () => { throw error; });
  const failed = vi.fn(), restored = vi.fn();
  const stop = restoreSession({ active: () => true, open, failed, restored });
  try {
    await vi.advanceTimersByTimeAsync(20_000);
    window.dispatchEvent(new Event('online'));
    window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(open).toHaveBeenCalledOnce();
    expect(failed).toHaveBeenCalledExactlyOnceWith(error, false);
    expect(restored).not.toHaveBeenCalled();
  } finally { stop(); }
});

it('backs off a Host that keeps failing, doubling the wait up to a minute', async () => {
  vi.useFakeTimers();
  const failing = (random: number) => {
    vi.spyOn(Math, 'random').mockReturnValue(random);
    const open = vi.fn(async () => { throw new DirectoryError('The Host could not open the session.', 'session_attach_failed', 503); });
    return { open, stop: restoreSession({ active: () => true, open, restored: vi.fn(), failed: vi.fn() }) };
  };
  // Without jitter: attempts at 0, 5, 15, 35, then every minute from 75 seconds on (361 before backing off).
  const steady = failing(1);
  try {
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(steady.open).toHaveBeenCalledTimes(33);
  } finally { steady.stop(); vi.restoreAllMocks(); }
  // Jitter only shortens a wait, by up to a fifth, so pages that failed together spread out.
  const hurried = failing(0);
  try {
    await vi.advanceTimersByTimeAsync(30 * 60_000);
    expect(hurried.open).toHaveBeenCalledTimes(41);
  } finally { hurried.stop(); }
});

it('retries at once when the page resumes, and waits from the first delay again', async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(1);
  const open = vi.fn(async () => { throw new DirectoryError('The Host could not open the session.', 'session_attach_failed', 503); });
  const stop = restoreSession({ active: () => true, open, restored: vi.fn(), failed: vi.fn() });
  try {
    await vi.advanceTimersByTimeAsync(135_001);
    expect(open).toHaveBeenCalledTimes(6);
    window.dispatchEvent(new Event('online'));
    await vi.advanceTimersByTimeAsync(1);
    expect(open).toHaveBeenCalledTimes(7);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(open).toHaveBeenCalledTimes(8);
  } finally { stop(); vi.restoreAllMocks(); }
});

it('retries at once when its Host comes back, and waits from the first delay again', async () => {
  vi.useFakeTimers();
  vi.spyOn(Math, 'random').mockReturnValue(1);
  const open = vi.fn(async () => { throw new DirectoryError('The Remote Host is offline.', 'host_offline', 503); });
  const stop = restoreSession({ hostId: 'laptop', active: () => true, open, restored: vi.fn(), failed: vi.fn() });
  try {
    await vi.advanceTimersByTimeAsync(135_001);
    expect(open).toHaveBeenCalledTimes(6);
    // Another Host coming back changes nothing here.
    announceHostReturned('studio');
    await vi.advanceTimersByTimeAsync(1);
    expect(open).toHaveBeenCalledTimes(6);
    announceHostReturned('laptop');
    await vi.advanceTimersByTimeAsync(1);
    expect(open).toHaveBeenCalledTimes(7);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(open).toHaveBeenCalledTimes(8);
  } finally { stop(); vi.restoreAllMocks(); }
});
