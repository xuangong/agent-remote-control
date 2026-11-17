import { afterEach, expect, it, vi } from 'vitest';
import { createPreviewActivity } from './preview-activity.js';

afterEach(() => vi.useRealTimers());

it('coalesces continuous traffic and one trailing renewal without keeping idle previews alive', async () => {
  vi.useFakeTimers();
  const renew = vi.fn(async () => ({ expiresAt: Date.now() + 3600000 }));
  const activity = createPreviewActivity({ available: () => true, renew });
  try {
    for (let i = 0; i < 100; i++) activity.record('host', 'preview');
    await vi.advanceTimersByTimeAsync(0);
    expect(renew).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(60000);
    expect(renew).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(3600000);
    expect(renew).toHaveBeenCalledTimes(2);
  } finally { activity.close(); }
});

it('stops queued renewals on removal, disconnect, and access loss', async () => {
  vi.useFakeTimers();
  let available = true;
  const renew = vi.fn(async () => ({ expiresAt: Date.now() + 3000 }));
  const activity = createPreviewActivity({ available: () => available, renew });
  try {
    activity.record('host', 'preview'); await vi.advanceTimersByTimeAsync(0);
    activity.record('host', 'preview'); activity.forget('host', 'preview');
    await vi.advanceTimersByTimeAsync(2000); expect(renew).toHaveBeenCalledTimes(1);
    activity.record('host', 'other'); await vi.advanceTimersByTimeAsync(0);
    activity.record('host', 'other'); activity.forget('host');
    await vi.advanceTimersByTimeAsync(2000); expect(renew).toHaveBeenCalledTimes(2);
    activity.record('host', 'last'); await vi.advanceTimersByTimeAsync(0);
    activity.record('host', 'last'); available = false;
    await vi.advanceTimersByTimeAsync(2000); activity.record('host', 'last');
    expect(renew).toHaveBeenCalledTimes(3);
  } finally { activity.close(); }
});

it('does not retry failures without new traffic or resume a forgotten in-flight renewal', async () => {
  vi.useFakeTimers();
  const renew = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue({ expiresAt: Date.now() + 3600000 });
  const activity = createPreviewActivity({ available: () => true, renew });
  try {
    activity.record('host', 'preview'); await vi.advanceTimersByTimeAsync(3600000);
    expect(renew).toHaveBeenCalledTimes(1);
    activity.record('host', 'preview'); activity.record('host', 'preview'); activity.forget('host');
    await vi.advanceTimersByTimeAsync(3600000); expect(renew).toHaveBeenCalledTimes(2);
  } finally { activity.close(); }
});
