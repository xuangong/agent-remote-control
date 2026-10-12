import { compositionSelection, type CompositionDocument } from './session-composition.js';
import type { TrackedSessionView } from './tracked-session-views.js';

/** Presentation references only. Native identity always comes from the current composition. */
export interface ConversationLayout {
  primarySlot: string;
  selections: Record<string, string | null>;
  focus?: string;
  anchor?: string;
  address?: string;
}
export function isConversationLayout(value: unknown): value is ConversationLayout {
  if (!value || typeof value !== 'object') return false;
  const layout = value as ConversationLayout;
  return typeof layout.primarySlot === 'string' && !!layout.primarySlot && !!layout.selections && typeof layout.selections === 'object' && !Array.isArray(layout.selections)
    && Object.entries(layout.selections).length <= 64 && Object.values(layout.selections).every(value => value === null || typeof value === 'string')
    && [layout.focus, layout.anchor, layout.address].every(value => value === undefined || typeof value === 'string');
}
export function resolveConversationLayout(document: CompositionDocument, layout?: ConversationLayout): TrackedSessionView | undefined {
  if (!isConversationLayout(layout)) return;
  const slot = document.slots.find(slot => slot.id === layout.primarySlot);
  if (!slot || slot.intent.kind === 'history') return;
  const ids = new Set(document.slots.map(slot => slot.id));
  const selections: Record<string, string | null> = {};
  const path = new Set<string>();
  let source: string | null = slot.id;
  while (source && ids.has(source) && !path.has(source)) {
    path.add(source);
    const target: string | null = layout.selections[source] ?? null;
    selections[source] = target && ids.has(target) && !path.has(target) ? target : null;
    source = selections[source]!;
  }
  return { primary: compositionSelection(slot), primarySlot: slot.id, selections,
    focus: layout.focus && path.has(layout.focus) ? layout.focus : slot.id,
    anchor: layout.anchor && path.has(layout.anchor) ? layout.anchor : slot.id };
}
export function applyConversationLayout(document: CompositionDocument, layout: ConversationLayout): boolean {
  const resolved = resolveConversationLayout(document, layout);
  if (!resolved) return false;
  document.edges = [...document.edges.filter(edge => !(edge.source in resolved.selections)),
    ...Object.entries(resolved.selections).flatMap(([source, target]) => target ? [{ source, target, selected: true }] : [])];
  document.primary = resolved.primarySlot; document.focus = resolved.focus; document.anchor = resolved.anchor;
  document.address = layout.address && (layout.address in resolved.selections) ? layout.address : resolved.primarySlot;
  document.editRevision++;
  return true;
}
