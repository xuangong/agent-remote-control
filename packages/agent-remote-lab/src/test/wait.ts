import { vi } from 'vitest';

/** `vi.waitFor` that checks every 2 ms instead of every 50: a test over an in-memory network does not wait for its own polling. The timeout stays the default unless the test names one. */
export const waitFor = <T>(check: () => T | Promise<T>, options: { timeout?: number } = {}): Promise<T> => vi.waitFor(check, { interval: 2, ...options });

/**
 * The next popstate event. A browser, and jsdom, moves through history in a later task than `history.back()` or a Back button
 * that calls it, so a test waits for the event the page listens to rather than for a fixed time. Call it before the traversal.
 */
export const nextPopstate = (): Promise<void> => new Promise(resolve => addEventListener('popstate', () => resolve(), { once: true }));
