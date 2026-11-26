/**
 * The latest reply of each assistant, as this device last saw it, so a roster opens in the order and with the sentences it had when the page last ran,
 * and the live session states, once they arrive, change it in place instead of reordering it. Page-local content like the catalog: it follows the
 * clear-cache-on-close preference and goes with the workspace's other records.
 */
import type { SessionReply } from '@orchardworks/agent-client';
import { conversationLocalStorage } from './conversation-storage.js';

const keyFor = (scope: string) => `agent-remote:recovery:${scope}:replies`;
const isReply = (value: unknown): value is SessionReply => !!value && typeof value === 'object'
  && typeof (value as SessionReply).replyAt === 'number' && Number.isFinite((value as SessionReply).replyAt) && typeof (value as SessionReply).preview === 'string';

/** The stored replies by session key; entries that are not replies are left out. */
export function readStoredReplies(scope: string): Map<string, SessionReply> {
  try {
    const stored = JSON.parse(conversationLocalStorage.getItem(keyFor(scope)) ?? 'null');
    if (!Array.isArray(stored)) return new Map();
    return new Map(stored.flatMap((entry): Array<[string, SessionReply]> => Array.isArray(entry) && typeof entry[0] === 'string' && isReply(entry[1]) ? [[entry[0], entry[1]]] : []));
  } catch { return new Map(); }
}

export function writeStoredReplies(scope: string, replies: ReadonlyMap<string, SessionReply>): void {
  try { conversationLocalStorage.setItem(keyFor(scope), JSON.stringify([...replies])); } catch { /* A full or private store keeps the page working without the copy. */ }
}
