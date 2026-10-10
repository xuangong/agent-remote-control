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

/** Rewrite navigation after retention without folding the independent target view. */
export function projectTrackedSessionView(view: TrackedSessionView, from: Pick<SessionEntry, 'hostId' | 'providerId' | 'nativeSessionId'>, to: Pick<SessionEntry, 'hostId' | 'providerId' | 'nativeSessionId'>): TrackedSessionView {
  const oldKey = sessionKey(from), newKey = sessionKey(to);
  if (oldKey === newKey) return copyView(view);
  const retained = view.selections[oldKey] === newKey ? unlinkSideView(view, oldKey, newKey) : view;
  const selections = { ...retained.selections };
  if (Object.hasOwn(selections, oldKey)) { selections[newKey] = selections[oldKey]!; delete selections[oldKey]; }
  return { ...retained, selections, primary: sessionKey(retained.primary) === oldKey ? { ...retained.primary, ...to } : retained.primary,
    focus: retained.focus === oldKey ? newKey : retained.focus, anchor: retained.anchor === oldKey ? newKey : retained.anchor };
}

/** Page-local navigation memory. Connection ownership stays with ConversationConnections. */
export interface TrackedViewsSnapshot { editRevision: number; selected?: string; bindings?: Array<{ nativeKey: string; entryId: string }>; views: Array<{ entryId: string; view: TrackedSessionView }> }
const copyView = (view: TrackedSessionView): TrackedSessionView => ({ ...view, primary: { ...view.primary }, selections: { ...view.selections } });
export class TrackedSessionViews {
  private editRevision = 0;
  private readonly ownerByNative = new Map<string, string>();
  private ownerKey(session: Pick<SessionEntry, 'hostId' | 'providerId' | 'nativeSessionId'>): string { const key = sessionKey(session); return this.ownerByNative.get(key) ?? key; }
  snapshot(): TrackedViewsSnapshot { return { editRevision: this.editRevision, selected: this.selected, bindings: [...this.ownerByNative].map(([nativeKey, entryId]) => ({ nativeKey, entryId })), views: [...this.views].map(([entryId, view]) => ({ entryId, view: copyView(view) })) }; }
  restore(snapshot: TrackedViewsSnapshot, expectedRevision: number, isCurrent: () => boolean = () => true): boolean {
    if (!isCurrent() || this.editRevision !== expectedRevision || snapshot.views.length > 1024 || new Set(snapshot.views.map(item => item.entryId)).size !== snapshot.views.length) return false;
    this.views.clear(); this.ownerByNative.clear();
    for (const item of snapshot.views) { this.views.set(item.entryId, copyView(item.view)); this.ownerByNative.set(sessionKey(item.view.primary), item.entryId); }
    if (snapshot.bindings) { this.ownerByNative.clear(); for (const binding of snapshot.bindings) this.ownerByNative.set(binding.nativeKey, binding.entryId); }
    this.selected = snapshot.selected; this.editRevision++;
    return true;
  }
  bindOwner(session: Pick<SessionEntry, 'hostId' | 'providerId' | 'nativeSessionId'>, entryId: string): void {
    const key = sessionKey(session), previous = this.ownerKey(session), view = this.views.get(previous);
    for (const [native, owner] of this.ownerByNative) if (owner === entryId) this.ownerByNative.delete(native);
    this.ownerByNative.set(key, entryId);
    if (view && previous !== entryId && !this.views.has(entryId)) { this.views.delete(previous); this.views.set(entryId, view); }
    if (this.selected === key) this.selected = entryId;
    this.editRevision++;
  }
  getByOwner(entryId: string): TrackedSessionView | undefined { return this.views.get(entryId); }
  projectOwner(from: Pick<SessionEntry, 'hostId' | 'providerId' | 'nativeSessionId'>, to: Pick<SessionEntry, 'hostId' | 'providerId' | 'nativeSessionId'>, entryId: string): void {
    this.bindOwner(from, entryId);
    const view = this.views.get(entryId);
    if (view) this.views.set(entryId, projectTrackedSessionView(view, from, to));
    this.bindOwner(to, entryId);
  }

  private readonly views = new Map<string, TrackedSessionView>();
  private selected?: string;

  select(session: SessionEntry, entryId?: string): void { this.selected = entryId ?? this.ownerKey(session); this.editRevision++; }
  get(session: SessionEntry): TrackedSessionView | undefined { return this.views.get(this.ownerKey(session)); }

  unlink(source: SessionEntry, target: SessionEntry): void {
    this.editRevision++;
    for (const [key, view] of this.views) this.views.set(key, unlinkSideView(view, sessionKey(source), sessionKey(target)));
  }

  retain(sessions: readonly SessionEntry[]): void {
    this.editRevision++;
    const keys = new Set(sessions.map(session => this.ownerKey(session)));
    for (const key of this.views.keys()) if (!keys.has(key)) this.views.delete(key);
    if (this.selected && !keys.has(this.selected)) this.selected = undefined;
  }

  remember(view: TrackedSessionView, tracked: readonly SessionEntry[], known: readonly SessionEntry[]): void {
    this.retain(tracked);
    // A mobile child becomes the primary view while still belonging to the selected track.
    const family = sessionRootKey(view.primary, known);
    let owner = tracked.find(session => this.ownerKey(session) === this.selected && sessionRootKey(session, known) === family);
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
    if (owner) { this.ownerByNative.set(sessionKey(owner), this.ownerKey(owner)); this.views.set(this.ownerKey(owner), copyView(view)); this.editRevision++; }
  }
}
