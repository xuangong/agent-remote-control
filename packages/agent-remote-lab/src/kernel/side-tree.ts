import type { OpenedSession } from './directory-client.js';

export type SideSelections = Readonly<Record<string, string | null>>;

/** Selected edges define a path; cached views retain sibling branches independently. */
export function sidePath(root: OpenedSession | undefined, sessions: readonly OpenedSession[], selections: SideSelections, key: (session: OpenedSession) => string): OpenedSession[] {
  if (!root) return [];
  const available = new Map(sessions.map((session) => [key(session), session]));
  const path = [root];
  const visited = new Set([key(root)]);
  for (;;) {
    const selected = selections[key(path[path.length - 1]!)];
    const next = selected ? available.get(selected) : undefined;
    if (!next || visited.has(key(next))) return path;
    visited.add(key(next));
    path.push(next);
  }
}

export function expandedSideRange(path: readonly OpenedSession[], focused: string | undefined, capacity: number, key: (session: OpenedSession) => string): { start: number; end: number } {
  const selected = focused ? path.findIndex((session) => key(session) === focused) : -1;
  const end = selected < 0 ? Math.max(0, path.length - 1) : selected;
  return { start: Math.max(0, end - Math.max(1, capacity) + 1), end };
}
