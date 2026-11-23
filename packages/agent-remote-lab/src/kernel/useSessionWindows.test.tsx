import { applyWindowOperation, createWindowView, type Team, type WindowOperation, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { ensureWindowCompositionSlot } from './window-composition.js';
import { act, useReducer } from 'react';
import { render } from '../test/setup.js';
import { afterEach, expect, it } from 'vitest';
import { createCompositionDocument, createCompositionSlot, parseComposition, compositionSelection, type CompositionDocument } from './session-composition.js';
import { sessionKey } from './session-tree.js';
import { useSessionWindows, type SessionWindowTarget } from './useSessionWindows.js';

const target = (id: string): SessionWindowTarget => ({ hostId: 'host', providerId: 'recorded', nativeSessionId: id, title: id });
afterEach(() => { sessionStorage.clear(); localStorage.clear(); });
async function harness(document: CompositionDocument = createCompositionDocument('windows')) {
  const result = { current: undefined as unknown as ReturnType<typeof useSessionWindows> };
  function Harness() {
    const [, save] = useReducer(n => n + 1, 0);
    result.current = useSessionWindows('windows', { document, save, ensureView(selection) {
      let slot = document.slots.find(slot => sessionKey(compositionSelection(slot)) === sessionKey(selection));
      if (!slot) { slot = createCompositionSlot(sessionKey(selection), selection, document.scope); document.slots.push(slot); }
      return slot;
    } });
    return null;
  }
  const element = await render(<Harness />);
  return { document, result, element };
}
it('keeps focus and independent view identity across empty binding, rebinding and close', async () => {
  const { result, document } = await harness();
  let id = '';
  await act(async () => { id = result.current.create(); });
  expect(result.current.entries[0]).toMatchObject({ id });
  expect(result.current.entries[0]!.target).toBeUndefined();
  expect(document.slots).toHaveLength(0);
  await act(async () => { result.current.bind(id, target('a')); });
  await act(async () => { result.current.bind(id, target('b')); });
  expect(result.current.entries[0]).toMatchObject({ id, target: target('b') });
  expect(result.current.activeId).toBe(id);
  expect(document.windows![0]).not.toHaveProperty('target');
  await act(async () => { result.current.close(id); });
  expect(result.current.activeId).toBeUndefined();
  expect(() => result.current.bind(id, target('a'))).toThrow();
  expect(result.current.entries).toEqual([]);
});

it('imports old targets once with stable dock IDs and close references, and leaves their Team tags out', async () => {
  const id = (name: string) => `session:${JSON.stringify(['host', 'recorded', name])}`;
  sessionStorage.setItem('agent-remote:recovery:windows:session-windows', JSON.stringify([
    { target: target('leader'), groupId: 'team' }, { target: target('member'), closeWith: id('leader') },
  ]));
  const { result, document } = await harness();
  expect(result.current.entries.map(entry => entry.id)).toEqual([id('leader'), id('member')]);
  expect(document.windows![1]).toMatchObject({ closeWith: id('leader'), managed: true });
  expect(document.windows![0]).not.toHaveProperty('target');
  expect(document.windows![0]).not.toHaveProperty('groupId');
});

it('closes the views of a close group with their root, and reads saved views that carry Team tags', async () => {
  const initial = await harness();
  for (const name of ['leader', 'member', 'other']) initial.document.slots.push(createCompositionSlot(name, { ...target(name) }, 'windows'));
  initial.document.windows = [{ id: 'view:leader', slotId: 'leader', managed: true }, { id: 'view:member', slotId: 'member', managed: true, closeWith: 'view:leader' }, { id: 'view:other', slotId: 'other' }];
  const saved = JSON.parse(JSON.stringify(initial.document));
  Object.assign(saved.windows[0], { groupId: 'team', teamMemberId: 'lead' });
  const { result, document } = await harness(parseComposition(saved, 'windows'));
  expect(document.windows![0]).toEqual({ id: 'view:leader', slotId: 'leader', managed: true });
  await act(async () => { result.current.close('view:member'); });
  expect(result.current.entries.map(view => view.id)).toEqual(['view:leader', 'view:other']);
  await act(async () => { result.current.close('view:leader'); });
  expect(result.current.entries.map(view => view.id)).toEqual(['view:other']);
});

it('keeps a focused view while selecting an identical native ID on another Host and Provider', async () => {
  const { result, document } = await harness();
  let id = '';
  await act(async () => { id = result.current.create(); result.current.bind(id, target('same')); });
  const other = { ...target('same'), hostId: 'other-host', providerId: 'other-provider' };
  await act(async () => { result.current.bind(id, other); });
  expect(result.current.activeId).toBe(id);
  expect(result.current.entries[0]?.target).toEqual(other);
  expect(document.slots).toHaveLength(2);
});

it('uses the latest local selection before React renders a newly created view', async () => {
  const document = createCompositionDocument('local-selection');
  let window: WorkspaceWindow = { schemaVersion: 3, id: 'local-selection', title: 'Window', revision: 0, selectedPrimaryViewId: 'main', selectedViewId: 'main', views: [createWindowView('main', undefined, 'primary')] };
  let current!: ReturnType<typeof useSessionWindows>;
  function Harness() {
    const [, save] = useReducer(n => n + 1, 0);
    current = useSessionWindows(document.scope, { document, save,
      ensureView: selection => ensureWindowCompositionSlot(document, window.id, 'fallback', selection),
      shared: { window, readWindow: () => window, operate(operation) { window = applyWindowOperation(window, operation); save(); } },
    });
    return <output>{current.activeId}</output>;
  }
  const element = await render(<Harness />);
  let id = '';
  await act(async () => { id = current.create(); current.focus(id); current.focus(id); });
  expect(window.views).toHaveLength(2);
  expect(window.selectedViewId).toBe(id);
  expect(window.revision).toBe(1);
  expect(element.querySelector('output')?.textContent).toBe(id);
});

it('keeps an empty shared Window empty until a view is explicitly created and allows closing it again', async () => {
  const document = createCompositionDocument('empty-shared'); document.activeWindow = 'stale-local-view';
  let window: WorkspaceWindow = { schemaVersion: 3, id: 'empty-shared', title: 'Window', revision: 0,
    selectedPrimaryViewId: null, selectedViewId: null, views: [] };
  let current!: ReturnType<typeof useSessionWindows>;
  const operations: WindowOperation[] = [];
  function Harness() {
    const [, save] = useReducer(n => n + 1, 0);
    current = useSessionWindows(document.scope, { document, save,
      ensureView: selection => ensureWindowCompositionSlot(document, window.id, 'fallback', selection),
      shared: { window, readWindow: () => window, operate(operation) { operations.push(operation); window = applyWindowOperation(window, operation); save(); } },
    });
    return null;
  }
  await render(<Harness />);
  expect(current.selectedId).toBeUndefined();
  await act(async () => { current.focus(); current.focus('closed'); });
  expect(operations).toEqual([]);
  let id = '';
  await act(async () => { id = current.create(); });
  expect(window.views).toHaveLength(1);
  expect(window.views[0]).toMatchObject({ id, placement: 'dock' });
  expect(current.selectedId).toBe(id);
  await act(async () => { current.close(id); });
  expect(window).toMatchObject({ views: [], selectedViewId: null, selectedPrimaryViewId: null });
  expect(current.selectedId).toBeUndefined();
  expect(operations).toHaveLength(2);
});

it('renders unknown, malformed and removed feature associations as ordinary session views', async () => {
  const document = createCompositionDocument('opaque-features');
  let window: WorkspaceWindow = { schemaVersion: 3, id: 'opaque', title: 'Window', revision: 0, selectedPrimaryViewId: 'main', selectedViewId: 'unknown', views: [
    createWindowView('main', undefined, 'primary'),
    { ...createWindowView('unknown', target('ordinary')), feature: { kind: 'external', id: 'tool', metadata: { role: 'member' } } },
    { ...createWindowView('invalid-team', target('other')), feature: { kind: 'team', id: 'team', metadata: { role: 'unsupported', memberId: 'member' } } },
    // A Team's view saved by an older build loads as an ordinary view too.
    { ...createWindowView('saved-team', target('member')), feature: { kind: 'team', id: 'team', metadata: { role: 'member', memberId: 'member' } }, bindingPolicy: 'managed' as const },
  ] };
  let current!: ReturnType<typeof useSessionWindows>;
  function Harness() {
    const [, save] = useReducer(n => n + 1, 0);
    current = useSessionWindows(document.scope, { document, save,
      ensureView: selection => ensureWindowCompositionSlot(document, window.id, 'fallback', selection),
      ensureWindowView: (windowId, viewId, selection) => ensureWindowCompositionSlot(document, windowId, viewId, selection),
      shared: { window, operate(operation) { window = applyWindowOperation(window, operation); save(); } },
    });
    return null;
  }
  await render(<Harness />);
  expect(current.entries.map(entry => [entry.id, entry.managed])).toEqual([['unknown', false], ['invalid-team', false], ['saved-team', true]]);
  expect(current.activeId).toBe('unknown');
  await act(async () => current.bind('unknown', target('replacement')));
  expect(current.entries[0]?.target?.nativeSessionId).toBe('replacement');
});
