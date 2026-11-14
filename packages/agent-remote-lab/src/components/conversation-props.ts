import { isValidElement } from 'react';

/**
 * Whether two prop values decide the same thing for a conversation that is not shown: plain data compared by value
 * (to a bounded depth, as targets and bindings are rebuilt on every render), other objects (replicas, transports, stores)
 * by identity. Functions and React elements only shape what a shown conversation draws, so they do not count.
 */
function sameValue(a: unknown, b: unknown, depth: number): boolean {
  if (Object.is(a, b)) return true;
  if (typeof a === 'function' && typeof b === 'function') return true;
  if (isValidElement(a) && isValidElement(b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object' || depth === 0) return false;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((item, index) => sameValue(item, b[index], depth - 1));
  if (Object.getPrototypeOf(a) !== Object.prototype || Object.getPrototypeOf(b) !== Object.prototype) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key => Object.hasOwn(b, key) && sameValue((a as Record<string, unknown>)[key], (b as Record<string, unknown>)[key], depth - 1));
}

/**
 * A conversation that is not shown keeps its last render while what decides its lifecycle (its target, attachment,
 * folding, liveness and blocking) stays the same; it still renders for its own session's events and contexts, and
 * renders with the latest props as soon as it is shown. A shown conversation renders with its parent, as before.
 */
export function hiddenConversationUnchanged(previous: { visible?: boolean }, next: { visible?: boolean }): boolean {
  if (previous.visible !== false || next.visible !== false) return false;
  const before = previous as Record<string, unknown>, after = next as Record<string, unknown>;
  const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const key of keys) if (!sameValue(before[key], after[key], 4)) return false;
  return true;
}
