import { afterEach, expect, it, vi } from 'vitest';
import { watchPagePolling } from './page-polling.js';
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
it('suspends timers while hidden and serializes wakeups with a pending request', async () => {
  vi.useFakeTimers();
  let visibility: DocumentVisibilityState = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  let finish!: () => void;
  const poll = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const stop = watchPagePolling(poll, 5000);
  try {
    await vi.advanceTimersByTimeAsync(20000);
    expect(poll).toHaveBeenCalledTimes(1);
    visibility = 'hidden'; document.dispatchEvent(new Event('visibilitychange'));
    finish(); await Promise.resolve();
    expect(vi.getTimerCount()).toBe(0);
    visibility = 'visible'; document.dispatchEvent(new Event('visibilitychange'));
    expect(poll).toHaveBeenCalledTimes(2);
    visibility = 'hidden'; document.dispatchEvent(new Event('visibilitychange'));
    visibility = 'visible'; document.dispatchEvent(new Event('visibilitychange'));
    expect(poll).toHaveBeenCalledTimes(2);
    finish(); await vi.advanceTimersByTimeAsync(1);
    expect(poll).toHaveBeenCalledTimes(3);
  } finally { stop(); finish(); }
});
