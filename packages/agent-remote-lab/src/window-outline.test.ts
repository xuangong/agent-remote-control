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

const ids = (views: WindowView[]) => windowOutline(views).map(entry => [entry.view.id, entry.depth]);

it('keeps an Ask that closes with a Side under the Side\'s source', () => {
  expect(ids([
    view('main', { placement: 'primary' }),
    view('side', { placement: 'attached', attachedTo: 'main' }),
    view('ask', { placement: 'dock', closeWith: 'side', feature: { kind: 'ask', id: 'a1' } }),
  ])).toEqual([['main', 0], ['side', 1], ['ask', 1]]);
});

it('lists nested Sides one level in', () => {
  expect(ids([
    view('main', { placement: 'primary' }),
    view('s1', { placement: 'attached', attachedTo: 'main' }),
    view('s2', { placement: 'attached', attachedTo: 's1' }),
  ])).toEqual([['main', 0], ['s1', 1], ['s2', 1]]);
});

it('lists the members of an ownership cycle', () => {
  expect(ids([
    view('main', { placement: 'primary' }),
    view('a', { placement: 'dock', closeWith: 'b' }),
    view('b', { placement: 'dock', closeWith: 'a' }),
  ])).toEqual([['main', 0], ['a', 0], ['b', 1]]);
});

it('lists several children of one source in array order', () => {
  expect(ids([
    view('main', { placement: 'primary' }),
    view('c2', { placement: 'dock', closeWith: 'main' }),
    view('c1', { placement: 'attached', attachedTo: 'main' }),
    view('c3', { placement: 'float', closeWith: 'main' }),
  ])).toEqual([['main', 0], ['c2', 1], ['c1', 1], ['c3', 1]]);
});
