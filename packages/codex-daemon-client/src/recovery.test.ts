import { expect, it } from 'vitest';
import { CodexRestorationSemaphore } from './recovery.js';

it('limits a shared restoration scope and cancels waiting consumers without acquiring a slot', async () => {
  const scheduler = new CodexRestorationSemaphore(1);
  let release!: () => void;
  let started = 0;
  const first = scheduler.run(() => { started++; return new Promise<void>(resolve => { release = resolve; }); }, new AbortController().signal);
  await expect.poll(() => started).toBe(1);
  const controller = new AbortController();
  const second = scheduler.run(async () => { started++; }, controller.signal);
  const rejected = expect(second).rejects.toThrow('canceled');
  controller.abort(new Error('canceled'));
  await rejected;
  await expect(scheduler.run(async () => { started++; }, controller.signal)).rejects.toThrow('canceled');
  expect(started).toBe(1);
  release();
  await first;
  await scheduler.run(async () => { started++; }, new AbortController().signal);
  expect(started).toBe(2);
});
