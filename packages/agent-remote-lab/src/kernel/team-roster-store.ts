import { isTeam, type Team } from '@orchardworks/agent-remote-protocol';
import { conversationLocalStorage } from './conversation-storage.js';

/**
 * The sub-sessions, inboxes and answer sessions the page last read, kept on this device so a bot workbench draws from them at launch,
 * before the Relay answers (the native-experience audit, finding 1). They are shown as last known and replaced by the next read.
 * Like the other recovery records they go with the device's cache when the person chose to clear it on close.
 */
const key = (scope: string) => `agent-remote:recovery:${scope}:team-tasks`;
const LIMIT = 300;
const written = new Map<string, string>();

export function readStoredTasks(scope: string): Team[] | undefined {
  try {
    const value: unknown = JSON.parse(conversationLocalStorage.getItem(key(scope)) ?? 'null');
    return Array.isArray(value) ? value.filter(isTeam).slice(0, LIMIT) : undefined;
  } catch { return undefined; }
}

export function writeStoredTasks(scope: string, tasks: readonly Team[]): void {
  const text = JSON.stringify(tasks.slice(0, LIMIT));
  if (written.get(scope) === text) return;
  try { conversationLocalStorage.setItem(key(scope), text); written.set(scope, text); }
  catch { /* A full store only costs the offline first frame. */ }
}
