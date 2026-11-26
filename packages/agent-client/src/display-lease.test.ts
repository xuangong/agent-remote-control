import { expect, it } from 'vitest';
import { displayLeaseValid, type DisplayLeaseGate } from './display-lease.js';

const rows: ReadonlyArray<[string, DisplayLeaseGate | undefined, boolean]> = [
  ['a Relay without accounts has no gate and one person', undefined, true],
  ['a lease the Relay granted shows the stored rows', { granted: true }, true],
  ['a cached lease shows the stored rows before, and without, the Relay answering', { granted: true, retired: false }, true],
  ['no lease was ever granted on this device: nothing shows', { granted: false }, false],
  ['a lease the Relay refused shows nothing', { granted: false, retired: false }, false],
  ['a retired workspace shows nothing, even with a granted lease', { granted: true, retired: true }, false],
];
it.each(rows)('%s', (_name, gate, shown) => { expect(displayLeaseValid(gate)).toBe(shown); });
