import type { WindowView } from '@orchardworks/agent-remote-protocol';

export type OutlineEntry = { view: WindowView; depth: 0 | 1 };

/** The views a Window shows, in the order of its layout: top-level views, docks, floats; each followed by the Sides
 *  attached to it and the Asks that close with it. A view whose owner is gone is listed last, at the top level. */
export function windowOutline(views: readonly WindowView[]): OutlineEntry[] {
  const ids = new Set(views.map(view => view.id));
  const owner = (view: WindowView) => view.attachedTo ?? view.closeWith;
  const owned = (view: WindowView) => { const id = owner(view); return !!id && id !== view.id && ids.has(id); };
  const children = (id: string) => views.filter(view => owned(view) && owner(view) === id);
  const rank = (view: WindowView) => view.placement === 'primary' ? 0 : view.placement === 'dock' ? 1 : view.placement === 'float' ? 2 : 3;
  const roots = views.filter(view => !owned(view)).map((view, index) => ({ view, index }))
    .sort((a, b) => rank(a.view) - rank(b.view) || a.index - b.index).map(entry => entry.view);
  return roots.flatMap(view => [{ view, depth: 0 as const }, ...children(view.id).map(child => ({ view: child, depth: 1 as const }))]);
}
