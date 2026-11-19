import { expect } from 'vitest';

/** `expect.poll` at a 2 ms interval: a background settlement is seen as soon as it happens, not on the next 50 ms tick of the default. */
export const poll = ((read: () => unknown, options?: object) => expect.poll(read, { interval: 2, ...options })) as typeof expect.poll;
