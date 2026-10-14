import type { CompositionDocument } from './session-composition-model.js';

/** A presentation identity references a session binding only after selection. */
export interface CompositionWindow {
  id: string;
  slotId?: string;
  managed?: boolean;
  closeWith?: string;
  groupId?: string;
}
export const SESSION_VIEW_LIMIT = 20;

export function parseCompositionWindows(value: unknown, slots: ReadonlySet<string>): CompositionWindow[] {
  if (!Array.isArray(value) || value.length > SESSION_VIEW_LIMIT) throw new Error('Invalid session views.');
  const ids = new Set<string>();
  const windows = value.map((view: CompositionWindow) => {
    if (!view || typeof view.id !== 'string' || !view.id || view.id === 'main' || ids.has(view.id)
      || view.slotId !== undefined && !slots.has(view.slotId)
      || view.managed !== undefined && typeof view.managed !== 'boolean'
      || [view.closeWith, view.groupId].some(value => value !== undefined && (typeof value !== 'string' || !value))) throw new Error('Invalid session view.');
    ids.add(view.id);
    return { id: view.id, ...(view.slotId ? { slotId: view.slotId } : {}), ...(view.managed ? { managed: true } : {}),
      ...(view.closeWith ? { closeWith: view.closeWith } : {}), ...(view.groupId ? { groupId: view.groupId } : {}) };
  });
  if (windows.some(view => view.closeWith && (view.closeWith === view.id || !ids.has(view.closeWith)))) throw new Error('Invalid session view group.');
  return windows;
}

export function createCompositionView(document: CompositionDocument): CompositionWindow {
  if ((document.windows?.length ?? 0) >= SESSION_VIEW_LIMIT) throw new Error(`Close a session view before opening more than ${SESSION_VIEW_LIMIT}.`);
  const view = { id: `view:${crypto.randomUUID()}` };
  (document.windows ??= []).push(view);
  document.editRevision++;
  return view;
}

/** The destination is required; only the previous binding may be empty. */
export function bindCompositionView(document: CompositionDocument, id: string, slotId: string): void {
  if (!document.slots.some(slot => slot.id === slotId)) throw new Error('The selected session binding no longer exists.');
  if (id === 'main') {
    if (document.primary === slotId && document.address === slotId) return;
    document.primary = slotId; document.address = slotId;
  } else {
    const view = document.windows?.find(view => view.id === id);
    if (!view) throw new Error('This session view has been closed.');
    if (view.managed) throw new Error('This session view is managed by its feature.');
    if (view.slotId === slotId) return;
    view.slotId = slotId;
  }
  document.editRevision++;
}
