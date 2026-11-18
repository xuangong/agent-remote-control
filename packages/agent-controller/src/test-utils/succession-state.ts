/** Builders that grow a succession state file towards its byte ceiling without serializing the whole state for every entry. */
import { jsonBytes } from '../succession-persistence.js';

/**
 * Appends `makeEntry(n)` to `list` in one step until `state` is about `slack` bytes short of `desired`. The caller finishes with the exact
 * trim: a few more entries, one at a time.
 */
export function padInBulk(state: unknown, list: unknown[], makeEntry: (index: number) => unknown, desired: number, slack: number): void {
  const perEntry = jsonBytes(makeEntry(list.length)) + 1;
  const count = Math.floor((desired - slack - jsonBytes(state)) / perEntry) - 2;
  for (let added = 0; added < count; added++) list.push(makeEntry(list.length));
}
