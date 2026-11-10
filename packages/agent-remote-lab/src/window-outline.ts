import type { WindowView } from '@orchardworks/agent-remote-protocol';

export type OutlineEntry = { view: WindowView; depth: 0 | 1 };

/** The views a Window shows, in the order of its layout: top-level views, docks, floats; each followed, in array order,
 *  by the Sides attached to it and the Asks that close with it, and theirs in turn, all one level in. A view whose
 *  owner is gone is listed last, at the top level; so is any view only reachable through a cycle. */
export function windowOutline(views: readonly WindowView[]): OutlineEntry[] {
  const ids = new Set(views.map(view => view.id));
  const owner = (view: WindowView) => view.attachedTo ?? view.closeWith;
  const owned = (view: WindowView) => { const id = owner(view); return !!id && id !== view.id && ids.has(id); };
  const rank = (view: WindowView) => view.placement === 'primary' ? 0 : view.placement === 'dock' ? 1 : view.placement === 'float' ? 2 : 3;
  const roots = views.filter(view => !owned(view)).map((view, index) => ({ view, index }))
    .sort((a, b) => rank(a.view) - rank(b.view) || a.index - b.index).map(entry => entry.view);
  const seen = new Set<string>(), outline: OutlineEntry[] = [];
  const walk = (view: WindowView, level: number) => {
    if (seen.has(view.id)) return;
    seen.add(view.id); outline.push({ view, depth: Math.min(level, 1) as 0 | 1 });
    for (const child of views) if (owned(child) && owner(child) === view.id) walk(child, level + 1);
  };
  for (const view of roots) walk(view, 0);
  for (const view of views) walk(view, 0);
  return outline;
}
