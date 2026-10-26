import { expect, it } from 'vitest';
import { adjacentSessionView } from './useSessionViewMouseNavigation.js';

function rail(views: Array<{ id: string; left: number; hidden?: boolean; inner?: boolean }>) {
  const root = document.createElement('div');
  for (const view of views) {
    const element = document.createElement('section');
    element.dataset.viewId = view.id;
    element.hidden = !!view.hidden;
    element.getClientRects = () => (view.hidden ? [] : [{}]) as unknown as DOMRectList;
    element.getBoundingClientRect = () => ({ left: view.left }) as DOMRect;
    // A window and its root pane name the same view.
    if (view.inner) {
      const inner = element.cloneNode() as HTMLElement;
      inner.getClientRects = element.getClientRects; inner.getBoundingClientRect = () => ({ left: view.left + 1 }) as DOMRect;
      inner.dataset.inner = 'true'; element.append(inner);
    }
    root.append(element);
  }
  return root;
}

it('steps through visible session views in on-screen order, using the innermost element of a view', () => {
  const root = rail([{ id: 'dock', left: 900, inner: true }, { id: 'main', left: 0 }, { id: 'gone', left: 500, hidden: true }, { id: 'child', left: 400 }]);
  expect(adjacentSessionView(root, 'main', 1)?.dataset.viewId).toBe('child');
  const dock = adjacentSessionView(root, 'child', 1)!;
  expect([dock.dataset.viewId, dock.dataset.inner]).toEqual(['dock', 'true']);
  expect(adjacentSessionView(root, 'dock', 1)).toBeUndefined();
  expect(adjacentSessionView(root, 'main', -1)).toBeUndefined();
  // Without the selected view, forward starts at the first view and back at the last.
  expect(adjacentSessionView(root, 'gone', 1)?.dataset.viewId).toBe('main');
  expect(adjacentSessionView(root, undefined, -1)?.dataset.viewId).toBe('dock');
});
