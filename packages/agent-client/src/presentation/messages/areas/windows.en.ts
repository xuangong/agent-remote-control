/** Window mode: windows, docks, tiles, groups and their menus. */
import type { Message } from '../types.js';

export const windows = {
} as const satisfies Readonly<Record<string, Message>>;
