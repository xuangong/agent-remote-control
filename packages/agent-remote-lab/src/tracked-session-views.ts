import { sessionKey, sessionRootKey, type SessionEntry } from './session-tree.js';
import type { SideSelections } from './side-tree.js';

export interface TrackedSessionView {
  primary: SessionEntry;
  selections: SideSelections;
  focus?: string;
  anchor?: string;
}

/** Detach one navigation edge while keeping the independent branch's own path. */
export function unlinkSideView(view: TrackedSessionView, source: string, target: string): TrackedSessionView {
  if (view.selections[source] !== target) return view;
  const detached = new Set<string>();
  for (let key: string | null | undefined = target; key && !detached.has(key); key = view.selections[key]) detached.add(key);
  return { ...view, selections: { ...view.selections, [source]: null },
    focus: view.focus && detached.has(view.focus) ? source : view.focus,
    anchor: view.anchor && detached.has(view.anchor) ? source : view.anchor };
}

/** Page-local navigation memory. Connection ownership stays with ConversationConnections. */
export class TrackedSessionViews {
  private readonly views = new Map<string, TrackedSessionView>();
  private selected?: string;

  select(session: SessionEntry): void { this.selected = sessionKey(session); }
  get(session: SessionEntry): TrackedSessionView | undefined { return this.views.get(sessionKey(session)); }

  unlink(source: SessionEntry, target: SessionEntry): void {
    for (const [key, view] of this.views) this.views.set(key, unlinkSideView(view, sessionKey(source), sessionKey(target)));
  }

  retain(sessions: readonly SessionEntry[]): void {
    const keys = new Set(sessions.map(sessionKey));
    for (const key of this.views.keys()) if (!keys.has(key)) this.views.delete(key);
    if (this.selected && !keys.has(this.selected)) this.selected = undefined;
  }

  remember(view: TrackedSessionView, tracked: readonly SessionEntry[], known: readonly SessionEntry[]): void {
    this.retain(tracked);
    // A mobile child becomes the primary view while still belonging to the selected track.
    const family = sessionRootKey(view.primary, known);
    let owner = tracked.find(session => sessionKey(session) === this.selected && sessionRootKey(session, known) === family);
    if (!owner) {
      let current: SessionEntry | undefined = view.primary;
      const visited = new Set<string>();
      while (current && !visited.has(sessionKey(current))) {
        const key = sessionKey(current);
        visited.add(key);
        owner = tracked.find(session => sessionKey(session) === key);
        if (owner || !current.parentNativeSessionId) break;
        const parent: SessionEntry = { ...current, nativeSessionId: current.parentNativeSessionId, parentNativeSessionId: undefined };
        current = known.find(session => sessionKey(session) === sessionKey(parent)) ?? parent;
      }
    }
    if (owner) this.views.set(sessionKey(owner), view);
  }
}
