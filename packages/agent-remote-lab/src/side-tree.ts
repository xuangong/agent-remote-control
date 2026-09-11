import type { OpenedSession } from './directory-client.js';
import { sessionKey } from './session-tree.js';

export type SideSelections = Readonly<Record<string, string | null>>;

/** Selected edges define a path; cached views retain sibling branches independently. */
export function sidePath(root: OpenedSession | undefined, sessions: readonly OpenedSession[], selections: SideSelections): OpenedSession[] {
  if (!root) return [];
  const available = new Map(sessions.map((session) => [sessionKey(session), session]));
  const path = [root];
  const visited = new Set([sessionKey(root)]);
  for (;;) {
    const selected = selections[sessionKey(path[path.length - 1]!)];
    const next = selected ? available.get(selected) : undefined;
    if (!next || visited.has(sessionKey(next))) return path;
    visited.add(sessionKey(next));
    path.push(next);
  }
}

export function expandedSideRange(path: readonly OpenedSession[], focused: string | undefined, capacity: number): { start: number; end: number } {
  const selected = focused ? path.findIndex((session) => sessionKey(session) === focused) : -1;
  const end = selected < 0 ? Math.max(0, path.length - 1) : selected;
  return { start: Math.max(0, end - Math.max(1, capacity) + 1), end };
}
