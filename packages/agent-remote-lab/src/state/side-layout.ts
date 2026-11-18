/**
 * Side layout: which Side sessions a source shows, which one is selected, and what a change of selection means.
 *
 * Contract
 * - Pure. The shell reads the composition document and the shared Window, passes plain facts in, and applies the
 *   steps or edges that come back.
 * - `selectedEdges` is the selection of the document: a source maps to the target of its selected edge, and an edge
 *   that is not selected is not a selection.
 * - `mergeSides` keeps the stored Sides that the projected layout does not name, in their order, and then the projected
 *   Sides. A Side the layout names is never listed twice.
 * - `sharedFamilySides` lists the Sides of the selected family of a shared Window, in Window order. A view counts only
 *   when it is attached, belongs to the family, has a known session, and that session is the one the view is bound to.
 * - `openSideKeys` names the sessions shown beside a source: in a shared Window every view attached to the source, in
 *   Window order; otherwise only the selected Side.
 * - `selectionSteps` turns a change of selection into Window steps. A source that is unknown or whose target did not
 *   change yields nothing. A target already attached to the source is selected. A target slot that exists is attached
 *   to the source (the source keeps its other views), and `owned` says whether the Window already owns that slot. A
 *   cleared or unknown target selects the source itself.
 * - `localEdges` is the document's edge list after a selection: one selected edge per source with a target.
 *   `sameEdges` tells the shell to skip the save when nothing changed.
 * - `swapKey` and `rekeySelections` follow a Side whose session was replaced (an edited prompt): a record that named the
 *   old key names the new one, and nothing else changes.
 */
export interface SideEdge { readonly source: string; readonly target: string; readonly selected: boolean }
export type SideSelections = Readonly<Record<string, string | null>>;

export function selectedEdges(edges: readonly SideEdge[]): Record<string, string> {
  return Object.fromEntries(edges.filter(edge => edge.selected).map(edge => [edge.source, edge.target]));
}

export function mergeSides<Side>(stored: readonly Side[], projected: readonly Side[] | undefined, keyOf: (side: Side) => string): readonly Side[] {
  if (!projected) return stored;
  const named = new Set(projected.map(keyOf));
  return [...stored.filter(side => !named.has(keyOf(side))), ...projected];
}

export function sharedFamilySides<Session, Slot extends { readonly id: string }, Binding>(
  views: readonly { readonly id: string; readonly attachedTo?: string; readonly binding?: Binding }[], facts: {
    readonly inFamily: (viewId: string) => boolean;
    readonly slotOf: (viewId: string) => Slot | undefined;
    /** The session a slot is already known by. */ readonly known: (slotId: string) => Session | undefined;
    /** The session the view mounted. It stands for the slot only while it still names the slot. */ readonly mounted: (viewId: string) => (Session & { readonly viewId?: string }) | undefined;
    readonly sessionOfSlot: (slot: Slot) => Session | undefined;
    readonly sessionKey: (session: Session) => string;
    readonly bindingKey: (binding: Binding) => string;
  }): Session[] {
  return views.flatMap(view => {
    const slot = view.attachedTo && facts.inFamily(view.id) ? facts.slotOf(view.id) : undefined;
    const mounted = facts.mounted(view.id);
    const session = slot && (facts.known(slot.id) ?? (mounted?.viewId === slot.id ? mounted : facts.sessionOfSlot(slot)));
    return session && view.binding && facts.sessionKey(session) === facts.bindingKey(view.binding) ? [session] : [];
  });
}

export function openSideKeys(sourceId: string, facts: {
  readonly shared: boolean;
  /** Shared: the keys of the sessions of the views attached to the view that holds the source. */ readonly attachedKeys: (sourceId: string) => readonly string[];
  /** Not shared: the key of the session in the source's selected slot. */ readonly selectedKey: (sourceId: string) => string | undefined;
}): string[] {
  if (facts.shared) return [...facts.attachedKeys(sourceId)];
  const key = facts.selectedKey(sourceId);
  return key === undefined ? [] : [key];
}

export type SelectionStep =
  | { readonly type: 'select'; readonly viewId: string }
  | { readonly type: 'attach'; readonly sourceViewId: string; readonly slotId: string; readonly owned: boolean };

export function selectionSteps(current: SideSelections, next: SideSelections, facts: {
  readonly sourceView: (sourceId: string) => { readonly id: string } | undefined;
  readonly viewOfSlot: (slotId: string) => { readonly id: string; readonly attachedTo?: string } | undefined;
  readonly slotExists: (slotId: string) => boolean;
  readonly slotOwned: (slotId: string) => boolean;
}): SelectionStep[] {
  const steps: SelectionStep[] = [];
  for (const [sourceId, targetId] of Object.entries(next)) {
    if (current[sourceId] === targetId) continue;
    const source = facts.sourceView(sourceId);
    if (!source) continue;
    const existing = targetId ? facts.viewOfSlot(targetId) : undefined;
    if (existing?.attachedTo === source.id) { steps.push({ type: 'select', viewId: existing.id }); continue; }
    if (targetId && facts.slotExists(targetId)) steps.push({ type: 'attach', sourceViewId: source.id, slotId: targetId, owned: facts.slotOwned(targetId) });
    else steps.push({ type: 'select', viewId: source.id });
  }
  return steps;
}

export function localEdges(next: SideSelections): SideEdge[] {
  return Object.entries(next).flatMap(([source, target]) => target ? [{ source, target, selected: true }] : []);
}

export function sameEdges(left: readonly SideEdge[], right: readonly SideEdge[]): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

/** The key a record holds after a Side's session was replaced: the new key where it held the old one. */
export function swapKey<Value extends string | null | undefined>(value: Value, fromId: string, toId: string): Value | string { return value === fromId ? toId : value; }

export function rekeySelections(selections: SideSelections, fromId: string, toId: string): Record<string, string | null> {
  return Object.fromEntries(Object.entries(selections).map(([key, value]) => [key, swapKey(value, fromId, toId)]));
}
