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

it('releases an unheld session after 5 minutes by default', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
  const release = vi.fn(async () => {});
  const idle = createIdleSessions();
  idle.watch('a', () => true, release);
  await vi.advanceTimersByTimeAsync(299_999);
  expect(release).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(release).toHaveBeenCalledTimes(1);
  await idle.close();
});

it.each([
  ['graceMs', 0], ['graceMs', -1], ['graceMs', 1.5], ['graceMs', Number.NaN], ['graceMs', Number.POSITIVE_INFINITY], ['graceMs', 2 ** 53],
  ['reconcileMs', 0], ['reconcileMs', -1], ['reconcileMs', 1.5], ['reconcileMs', Number.NaN], ['reconcileMs', Number.POSITIVE_INFINITY], ['reconcileMs', 2 ** 53],
])('refuses %s of %s with a RangeError', (name, value) => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
  expect(() => createIdleSessions({ [name]: value })).toThrow(RangeError);
});

it('accepts the smallest positive grace and reconcile interval', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
  await createIdleSessions({ graceMs: 1, reconcileMs: 1 }).close();
});

/** Times at which a check that always fails runs, with the session unsafe and unheld. */
async function failingCheckTimes(options: { graceMs: number; reconcileMs: number }, untilMs: number): Promise<number[]> {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'performance'] });
  const idle = createIdleSessions(options);
  const times: number[] = [];
  idle.watch('a', () => false, async () => {}, async () => { times.push(performance.now()); throw new Error('Unavailable'); });
  await vi.advanceTimersByTimeAsync(untilMs);
  await idle.close();
  return times;
}
const gaps = (times: number[]) => times.slice(1).map((time, index) => time - times[index]!);

it('doubles the wait after each failed check and stops doubling after 10 failures', async () => {
  const times = await failingCheckTimes({ graceMs: 1000, reconcileMs: 100 }, 450_000);
  expect(times[0]).toBe(100);
  expect(gaps(times).slice(0, 9)).toEqual([200, 400, 800, 1600, 3200, 6400, 12_800, 25_600, 51_200]);
  // The 11th and later waits stay at the 10-failure wait.
  expect(gaps(times).slice(9, 12)).toEqual([102_400, 102_400, 102_400]);
});

it('never waits more than 15 minutes between failed checks', async () => {
  const times = await failingCheckTimes({ graceMs: 10_000, reconcileMs: 1000 }, 3_000_000);
  expect(gaps(times).at(-1)).toBe(900_000);
  expect(Math.max(...gaps(times))).toBe(900_000);
  expect(gaps(times).slice(8, 11)).toEqual([512_000, 900_000, 900_000]);
});
