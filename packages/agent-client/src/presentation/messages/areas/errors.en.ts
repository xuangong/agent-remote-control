/** What went wrong, said for a person: errors the client makes and the toasts that carry them. */
import type { Message } from '../types.js';

export const errors = {
} as const satisfies Readonly<Record<string, Message>>;
