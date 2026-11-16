import { afterEach, expect, it, vi } from 'vitest';
import { notifyFeedReopened, watchFeedReopen, watchList } from './feed-reopen.js';

afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

it('refreshes a list at mount, on its interval while visible and when the feed reopens, and not when the page becomes visible', async () => {
  vi.useFakeTimers();
  let visibility: DocumentVisibilityState = 'visible';
  vi.spyOn(document, 'visibilityState', 'get').mockImplementation(() => visibility);
  const refresh = vi.fn(async () => undefined);
  const stop = watchList(refresh, 10_000);
  try {
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(1);
    visibility = 'hidden'; document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    visibility = 'visible'; document.dispatchEvent(new Event('visibilitychange'));
    await vi.advanceTimersByTimeAsync(9_000);
    expect(refresh).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(refresh).toHaveBeenCalledTimes(2);
    notifyFeedReopened();
    await vi.advanceTimersByTimeAsync(0);
    expect(refresh).toHaveBeenCalledTimes(3);
    visibility = 'hidden';
    notifyFeedReopened();
    expect(refresh).toHaveBeenCalledTimes(3);
  } finally { stop(); }
  notifyFeedReopened();
  expect(refresh).toHaveBeenCalledTimes(3);
});

it('stops delivering to a listener that unwatched', () => {
  const listener = vi.fn();
  const stop = watchFeedReopen(listener);
  notifyFeedReopened();
  stop(); notifyFeedReopened();
  expect(listener).toHaveBeenCalledTimes(1);
});
