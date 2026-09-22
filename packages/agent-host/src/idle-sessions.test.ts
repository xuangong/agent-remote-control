import { afterEach, expect, it, vi } from 'vitest';
import { createIdleSessions } from './idle-sessions.js';
afterEach(() => vi.useRealTimers());

it('requires a full grace after the last lease, including reconnect churn', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
  const release = vi.fn(async () => {});
  const idle = createIdleSessions({ graceMs: 1000 });
  idle.watch('a', () => true, release);
  const first = idle.retain('a'), second = idle.retain('a');
  first(); first();
  await vi.advanceTimersByTimeAsync(2000);
  expect(release).not.toHaveBeenCalled();
  second();
  await vi.advanceTimersByTimeAsync(900);
  const returning = idle.retain('a'); returning();
  await vi.advanceTimersByTimeAsync(900);
  expect(release).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(200);
  expect(release).toHaveBeenCalledTimes(1);
  idle.close();
});

it('suspends while disconnected and gives a new grace after registration or unsafe activity', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
  let safe = true;
  const release = vi.fn(async () => {});
  const idle = createIdleSessions({ graceMs: 1000 });
  idle.watch('a', () => safe, release);
  await vi.advanceTimersByTimeAsync(900);
  idle.setConnected(false);
  await vi.advanceTimersByTimeAsync(5000);
  idle.setConnected(true);
  await vi.advanceTimersByTimeAsync(900);
  expect(release).not.toHaveBeenCalled();
  safe = false;
  await vi.advanceTimersByTimeAsync(5000);
  safe = true;
  await vi.advanceTimersByTimeAsync(900);
  expect(release).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(200);
  expect(release).toHaveBeenCalledTimes(1);
  idle.close();
});

it('lets returning demand wait for an already-started release without releasing twice', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
  let finish!: () => void;
  const idle = createIdleSessions({ graceMs: 1000 });
  const release = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  idle.watch('a', () => true, release);
  await vi.advanceTimersByTimeAsync(1100);
  const unpin = idle.retain('a');
  let completed = false;
  const waiting = idle.wait('a').then(() => { completed = true; });
  await vi.advanceTimersByTimeAsync(2000);
  expect(completed).toBe(false);
  expect(release).toHaveBeenCalledTimes(1);
  finish(); await waiting;
  unpin(); idle.close();
});


it('serializes low-frequency checks and starts a full grace only after a check finishes', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
  const idle = createIdleSessions({ graceMs: 1000, reconcileMs: 2000 });
  let safe = false, released = false, checks = 0;
  let finish!: (value: boolean) => void;
  idle.watch('a', () => safe, async () => { released = true; }, () => {
    checks++; return new Promise(resolve => { finish = resolve; });
  });
  await vi.advanceTimersByTimeAsync(2500);
  safe = true;
  await vi.advanceTimersByTimeAsync(5000);
  expect(released).toBe(false);
  expect(checks).toBe(1);
  finish(true);
  await vi.advanceTimersByTimeAsync(900);
  expect(released).toBe(false);
  await vi.advanceTimersByTimeAsync(200);
  expect(released).toBe(true);
  await idle.close();
});


it('backs off failed checks and pauses them while disconnected or observed', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
  const idle = createIdleSessions({ graceMs: 1000, reconcileMs: 2000 });
  const times: number[] = [];
  idle.watch('a', () => false, async () => { throw new Error('Unsafe release'); }, async () => {
    times.push(performance.now()); throw new Error('Unavailable');
  });
  const lease = idle.retain('a');
  await vi.advanceTimersByTimeAsync(10_000);
  expect(times).toEqual([]);
  lease();
  await vi.advanceTimersByTimeAsync(15_000);
  expect(times).toEqual([12_000, 16_000, 24_000]);
  idle.setConnected(false);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(times).toHaveLength(3);
  idle.setConnected(true);
  await vi.advanceTimersByTimeAsync(1900);
  expect(times).toHaveLength(3);
  await vi.advanceTimersByTimeAsync(200);
  expect(times.at(-1)).toBe(87_000);
  await idle.close();
});
