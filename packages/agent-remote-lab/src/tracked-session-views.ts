import type { SessionEntry } from './session-tree.js';
import { compositionSelection, type CompositionDocument } from './session-composition-model.js';
import type { SideSelections } from './side-tree.js';

export interface TrackedSessionView {
  primary: SessionEntry;
  /** Restored composition ownership; ordinary navigation supplies a new view. */
  primarySlot: string;
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

/** Track owns a reference to a view, not a second native-key layout. */
export class TrackedSessionViews {
  constructor(readonly document: CompositionDocument, private readonly changed: () => void) {}
  private edit() { this.document.editRevision++; this.changed(); }
  entry(entryId: string) { return this.document.tracks.find(entry => entry.entryId === entryId); }
  bind(entryId: string, slotId: string): void {
    if (!this.document.slots.some(slot => slot.id === slotId)) throw new Error('Tracked view is unavailable.');
    const existing = this.entry(entryId);
    if (existing?.slotId === slotId) return;
    if (existing) existing.slotId = slotId; else this.document.tracks.push({ entryId, slotId });
    this.edit();
  }
  select(entryId?: string): void {
    if (entryId && !this.entry(entryId)) throw new Error('Tracked view is unavailable.');
    if (this.document.selectedTrack === entryId) return;
    this.document.selectedTrack = entryId; this.edit();
  }
  get(entryId: string): TrackedSessionView | undefined {
    const saved = this.entry(entryId)?.view;
    if (!saved) return;
    const slot = this.document.slots.find(slot => slot.id === saved.primarySlot);
    return slot ? { ...saved, primary: compositionSelection(slot), selections: { ...saved.selections } } : undefined;
  }
  getForSlot(slotId: string): TrackedSessionView | undefined {
    const entry = this.document.tracks.find(entry => entry.slotId === slotId);
    return entry ? this.get(entry.entryId) : undefined;
  }
  remember(view: Omit<TrackedSessionView, 'primary'>, entryId = this.document.selectedTrack): void {
    const entry = entryId && this.entry(entryId);
    if (!entry) return;
    const ids = new Set(this.document.slots.map(slot => slot.id));
    if (!ids.has(view.primarySlot) || Object.entries(view.selections).some(([source, target]) => !ids.has(source) || target !== null && !ids.has(target))
      || view.focus && !ids.has(view.focus) || view.anchor && !ids.has(view.anchor)) throw new Error('Tracked layout contains an unavailable view.');
    if (JSON.stringify(entry.view) === JSON.stringify(view)) return;
    entry.view = structuredClone(view); this.edit();
  }
  retain(entryIds: readonly string[]): void {
    const ids = new Set(entryIds);
    const removed = this.document.tracks.filter(entry => !ids.has(entry.entryId));
    if (!removed.length) return;
    const selected = this.document.tracks.find(entry => entry.entryId === this.document.selectedTrack);
    const retained = new Set(this.document.retained.map(entry => entry.slot));
    const next = this.document.tracks.filter(entry => ids.has(entry.entryId) || retained.has(entry.slotId));
    const previousSelection = this.document.selectedTrack;
    if (selected && !next.includes(selected)) this.document.selectedTrack = undefined;
    if (next.length === this.document.tracks.length && previousSelection === this.document.selectedTrack) return;
    this.document.tracks = next; this.edit();
  }
  unlink(source: string, target: string): void {
    let changed = false;
    for (const entry of this.document.tracks) {
      if (!entry.view) continue;
      const next = unlinkSideView({ ...entry.view, primary: {} as SessionEntry }, source, target);
      if (next.selections === entry.view.selections) continue;
      const { primary: _primary, ...view } = next;
      entry.view = view; changed = true;
    }
    if (changed) this.edit();
  }
}
