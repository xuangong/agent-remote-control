import { expect, it } from 'vitest';
import { displayLeaseValid, type DisplayLeaseGate } from './display-lease.js';

const now = 1_000_000;
const rows: ReadonlyArray<[string, DisplayLeaseGate | undefined, boolean]> = [
  ['a Relay without accounts has no gate and one person', undefined, true],
  ['the Relay confirmed the lease', { ready: true }, true],
  ['a cached lease that has not ended shows rows before the Relay answers', { ready: false, optimisticUntil: now + 1 }, true],
  ['a cached lease ends at its own expiry, not a moment later', { ready: false, optimisticUntil: now }, false],
  ['an expired cached lease shows nothing', { ready: false, optimisticUntil: now - 1 }, false],
  ['no cached lease shows nothing', { ready: false }, false],
  ['a lease the Relay refused shows nothing, whatever the cached expiry was', { ready: false, optimisticUntil: undefined }, false],
  ['an expired lease being confirmed again shows nothing', { ready: true, confirming: true }, false],
  ['a retired workspace shows nothing, even while it looks confirmed', { ready: true, retired: true, optimisticUntil: now + 1 }, false],
];
it.each(rows)('%s', (_name, gate, shown) => { expect(displayLeaseValid(gate, now)).toBe(shown); });
