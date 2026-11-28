import { conversationLocalStorage } from '../../kernel/conversation-storage.js';

/** The derived tiles a person expanded in one workbench, kept on this device: a glance is not an edit of the shared Window. */
const key = (scope: string, windowId: string) => `agent-remote:recovery:${scope}:workbench-expanded:${windowId}`;
const LIMIT = 64;

export function readExpanded(scope: string, windowId: string | undefined): Set<string> {
  if (!windowId) return new Set();
  try {
    const value: unknown = JSON.parse(conversationLocalStorage.getItem(key(scope, windowId)) ?? '[]');
    return new Set(Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string').slice(0, LIMIT) : []);
  } catch { return new Set(); }
}

export function writeExpanded(scope: string, windowId: string, expanded: ReadonlySet<string>): void {
  try { conversationLocalStorage.setItem(key(scope, windowId), JSON.stringify([...expanded].slice(-LIMIT))); }
  catch { /* The tiles fold again after a reload. */ }
}
