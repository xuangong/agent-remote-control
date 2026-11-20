/** The client's own words: session states and notices, sending, uploads, succession, and the errors the client makes for a person. */
import type { Message } from '../types.js';

export const client = {
} as const satisfies Readonly<Record<string, Message>>;
