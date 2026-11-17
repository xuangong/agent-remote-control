import { Immer, current, enableArrayMethods, isDraft, type Draft } from 'immer';

// Searching a draft array reads its plain elements, instead of drafting every element it reads.
enableArrayMethods();

/**
 * Copy-on-write changes of committed state. A change copies only the objects it touches and their parents; the rest of the
 * result is the committed objects themselves. Results are deeply frozen, so a committed object never changes in place and
 * equal identity is equal content, which the record cache and validation rely on.
 */
export const committed = new Immer({ autoFreeze: true });

/** The value of a draft now, as plain objects; parts it did not change are the committed objects themselves. */
export function plain<T>(value: T): T {
  return isDraft(value) ? current(value as Draft<T>) as T : value;
}

/** A value computed from drafts, with every draft in it replaced by its value: drafts are revoked once their change ends. */
export function detached<T>(value: T): T {
  if (isDraft(value)) return current(value as Draft<T>) as T;
  if (Array.isArray(value)) {
    let copy: unknown[] | undefined;
    value.forEach((item, index) => { const resolved = detached(item); if (resolved !== item) (copy ??= [...value])[index] = resolved; });
    return (copy ?? value) as T;
  }
  if (value !== null && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype) {
    let copy: Record<string, unknown> | undefined;
    for (const [key, item] of Object.entries(value)) { const resolved = detached(item); if (resolved !== item) (copy ??= { ...value as Record<string, unknown> })[key] = resolved; }
    return (copy ?? value) as T;
  }
  return value;
}
