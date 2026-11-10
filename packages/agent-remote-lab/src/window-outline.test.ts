import { expect, it } from 'vitest';
import { createWindowView, type WindowView } from '@orchardworks/agent-remote-protocol';
import { windowOutline } from './window-outline.js';

const view = (id: string, extra: Partial<WindowView> = {}): WindowView => ({ ...createWindowView(id), ...extra });

it('lists top-level views, then docks, then floats, each followed by its Sides and Asks', () => {
  const views = [
    view('float', { placement: 'float' }),
    view('dock', { placement: 'dock', collapsed: true }),
    view('side', { placement: 'attached', attachedTo: 'main' }),
    view('main', { placement: 'primary' }),
    view('ask', { placement: 'dock', closeWith: 'dock', feature: { kind: 'ask', id: 'a1' } }),
    view('orphan', { placement: 'attached', attachedTo: 'gone' }),
  ];
  expect(windowOutline(views).map(entry => [entry.view.id, entry.depth])).toEqual([
    ['main', 0], ['side', 1], ['dock', 0], ['ask', 1], ['float', 0], ['orphan', 0],
  ]);
});
