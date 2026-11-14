import { expect, it, vi } from 'vitest';
import { LiveBudget } from './live-budget.js';

function clock() {
  let now = 0;
  const timers: Array<{ at: number; callback(): void }> = [];
  return {
    now: () => now,
    setTimeout(callback: () => void, ms: number) { const timer = { at: now + ms, callback }; timers.push(timer); return timer; },
    clearTimeout(handle: unknown) { const index = timers.indexOf(handle as never); if (index >= 0) timers.splice(index, 1); },
    advance(ms: number) {
      now += ms;
      for (const timer of timers.filter(timer => timer.at <= now)) { timers.splice(timers.indexOf(timer), 1); timer.callback(); }
    },
  };
}

it('keeps a conversation live on screen, for the grace period after, and then only among the most recently seen', () => {
  const time = clock(), budget = new LiveBudget({ recent: 2, graceMs: 1000, clock: time });
  const views = ['a', 'b', 'c', 'd'].map(id => budget.register(id, { visible: true }));
  expect(['a', 'b', 'c', 'd'].map(id => budget.live(id))).toEqual([true, true, true, true]);
  // Leaving the screen in order a, b, c: d stays on screen.
  views[0]!.update({ visible: false }); time.advance(10);
  views[1]!.update({ visible: false }); time.advance(10);
  views[2]!.update({ visible: false });
  expect(['a', 'b', 'c'].map(id => budget.live(id))).toEqual([true, true, true]);
  time.advance(1000);
  // The two most recently seen stay live; the oldest is released once its grace period is over.
  expect(['a', 'b', 'c', 'd'].map(id => budget.live(id))).toEqual([false, true, true, true]);
  views[0]!.update({ visible: true });
  expect(budget.live('a')).toBe(true);
});

it('never releases a conversation with pending input, and releases a folded one at once', () => {
  const time = clock(), budget = new LiveBudget({ recent: 0, graceMs: 1000, clock: time });
  const pinned = budget.register('pinned', { visible: false, pinned: true });
  budget.register('folded', { visible: false, folded: true });
  time.advance(5000);
  expect(budget.live('pinned')).toBe(true);
  expect(budget.live('folded')).toBe(false);
  pinned.update({ visible: false, pinned: false });
  expect(budget.live('pinned')).toBe(true);
  time.advance(1000);
  expect(budget.live('pinned')).toBe(false);
});

it('counts a conversation shown by two surfaces as visible if either shows it, and leaves unregistered ones alone', () => {
  const time = clock(), budget = new LiveBudget({ recent: 0, graceMs: 0, clock: time });
  const window = budget.register('slot', { visible: false, folded: true });
  const bot = budget.register('slot', { visible: true });
  expect(budget.live('slot')).toBe(true);
  bot.release();
  expect(budget.live('slot')).toBe(false);
  window.release();
  expect(budget.live('slot')).toBe(true);
  expect(budget.live('unknown')).toBe(true);
});

it('tells listeners about each change, including the end of a grace period', () => {
  const time = clock(), budget = new LiveBudget({ recent: 0, graceMs: 1000, clock: time });
  const listener = vi.fn();
  budget.subscribe(listener);
  const view = budget.register('a', { visible: true });
  expect(listener).toHaveBeenCalledTimes(1);
  view.update({ visible: false });
  const calls = listener.mock.calls.length;
  time.advance(999);
  expect(listener).toHaveBeenCalledTimes(calls);
  time.advance(1);
  expect(listener).toHaveBeenCalledTimes(calls + 1);
  expect(budget.live('a')).toBe(false);
  const version = budget.version;
  view.update({ visible: false });
  expect(budget.version).toBe(version);
});
