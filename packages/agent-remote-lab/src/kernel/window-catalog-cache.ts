/**
 * The Window catalog this device last read from the Relay (`GET /v1/windows`), kept so the roster draws from the device at once on the next launch,
 * and offline. It is page-local content like the rest of the recovery state: it follows the clear-cache-on-close preference and goes with the
 * workspace's other records when the person signs out or the Relay refuses the lease.
 */
import { decodeWindowGroup, type WindowGroup } from '@orchardworks/agent-remote-protocol';
import { conversationLocalStorage } from './conversation-storage.js';

const keyFor = (scope: string) => `agent-remote:recovery:${scope}:catalog`;

/** The stored groups, each decoded again; one that no longer decodes is left out. Empty when nothing usable is stored. */
export function readCatalogCache(scope: string): WindowGroup[] {
  try {
    const stored = JSON.parse(conversationLocalStorage.getItem(keyFor(scope)) ?? 'null');
    if (!Array.isArray(stored)) return [];
    return stored.flatMap(value => { const group = decodeWindowGroup(value); return group ? [group] : []; });
  } catch { return []; }
}

export function writeCatalogCache(scope: string, groups: readonly WindowGroup[]): void {
  try { conversationLocalStorage.setItem(keyFor(scope), JSON.stringify(groups)); } catch { /* A full or private store keeps the page working without the copy. */ }
}
