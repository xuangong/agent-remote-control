/** Sessions behind an assistant: succession, links, references, quotes, forks, tracking and native commands. */
import type { Message } from '../types.js';

export const sessions = {
} as const satisfies Readonly<Record<string, Message>>;
