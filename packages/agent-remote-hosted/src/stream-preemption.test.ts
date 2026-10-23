import { expect, it } from 'vitest';
import { createStreamPreemption } from './stream-preemption.js';

it('closes the least recently used subscriptions of the account until it is below its limit', () => {
  const open = new Map<string, number>([['alice', 4], ['bob', 4]]);
  const preemption = createStreamPreemption(subject => open.get(subject) ?? 0, 4);
  const closed: string[] = [];
  const subscription = (subject: string, name: string, lastUsed: number) => {
    const unregister = preemption.channel(subject).register({ lastUsed: () => lastUsed, preempt: () => { closed.push(name); open.set(subject, open.get(subject)! - 1); unregister(); } });
  };
  subscription('alice', 'shown', Number.POSITIVE_INFINITY);
  subscription('alice', 'older', 10);
  subscription('alice', 'oldest', 5);
  subscription('bob', 'other account', 1);
  preemption.makeRoom('alice', 7);
  expect(closed).toEqual(['oldest']);
  open.set('alice', 4);
  preemption.makeRoom('alice', 7);
  // Nothing open was used before the requester, so it waits; another account's streams are never taken.
  expect(closed).toEqual(['oldest']);
  preemption.makeRoom('alice', Number.POSITIVE_INFINITY);
  expect(closed).toEqual(['oldest', 'older']);
});

it('stops when closing a subscription does not free a stream', () => {
  const preemption = createStreamPreemption(() => 9, 4);
  let preempted = 0;
  preemption.channel('alice').register({ lastUsed: () => 1, preempt: () => { preempted++; } });
  preemption.makeRoom('alice', Number.POSITIVE_INFINITY);
  expect(preempted).toBe(1);
});
