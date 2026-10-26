import { conversationLocalStorage } from './conversation-storage.js';

/** Windows remembered per page scope; older entries are dropped. */
const RECENT_WINDOW_LIMIT = 200;
const recencyKey = (scope: string) => `agent-remote:recovery:${scope}:window-recency`;

function readRecency(scope: string): Record<string, number> {
  try {
    const value: unknown = JSON.parse(conversationLocalStorage.getItem(recencyKey(scope)) ?? '{}');
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter((entry): entry is [string, number] => typeof entry[1] === 'number' && Number.isFinite(entry[1])));
  } catch { return {}; }
}

/** Records that this device used a Window now. */
export function touchWindow(scope: string, id: string, now = Date.now()): void {
  const entries = Object.entries({ ...readRecency(scope), [id]: now }).sort((a, b) => b[1] - a[1]).slice(0, RECENT_WINDOW_LIMIT);
  try { conversationLocalStorage.setItem(recencyKey(scope), JSON.stringify(Object.fromEntries(entries))); }
  catch { /* Ordering falls back to the catalog when storage is unavailable. */ }
}

/** Windows by most recent use on this device; Windows it never used follow in their catalog order. */
export function byRecentUse<T extends { id: string }>(scope: string, windows: readonly T[]): T[] {
  const recency = readRecency(scope);
  return windows.map((window, index) => ({ window, index, used: recency[window.id] }))
    .sort((a, b) => (b.used ?? -Infinity) - (a.used ?? -Infinity) || a.index - b.index)
    .map(entry => entry.window);
}
