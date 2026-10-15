import { applyWindowOperation, createWindowView, type Team, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { ensureWindowCompositionSlot } from '../window-composition.js';
import { teamViewTarget } from '../team-view-binding.js';
import { act, useReducer } from 'react';
import { render } from '../test/setup.js';
import { afterEach, expect, it } from 'vitest';
import { createCompositionDocument, createCompositionSlot, parseComposition, compositionSelection, type CompositionDocument } from '../session-composition.js';
import { sessionKey } from '../session-tree.js';
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

it('retains Team ownership without consuming a user view displaying the same session', async () => {
  const { result } = await harness();
  let id = '';
  await act(async () => { id = result.current.create(); result.current.bind(id, target('leader')); });
  await act(async () => { result.current.open([target('leader'), target('member')], target('leader'), 'team'); });
  const leader = result.current.entries.find(entry => entry.groupId === 'team')!;
  expect(result.current.entries).toHaveLength(3);
  expect(() => result.current.bind(leader.id, target('other'))).toThrow();
  await act(async () => { result.current.close(leader.id); });
  expect(result.current.entries.map(entry => entry.id)).toEqual([id]);
  await act(async () => { result.current.gather(leader, [target('member')]); });
  expect(result.current.entries).toHaveLength(1);
});

it('imports old targets once with stable dock IDs and group references', async () => {
  const id = (name: string) => `session:${JSON.stringify(['host', 'recorded', name])}`;
  sessionStorage.setItem('agent-remote:recovery:windows:session-windows', JSON.stringify([
    { target: target('leader'), groupId: 'team' }, { target: target('member'), closeWith: id('leader') },
  ]));
  const { result, document } = await harness();
  expect(result.current.entries.map(entry => entry.id)).toEqual([id('leader'), id('member')]);
  expect(document.windows![1]).toMatchObject({ closeWith: id('leader'), managed: true });
  expect(document.windows![0]).not.toHaveProperty('target');
});

it('restores close groups, gathers once, and does not resurrect a closed leader', async () => {
  const initial = await harness();
  await act(async () => {
    initial.result.current.open([target('leader'), target('member')], target('leader'), 'team');
    initial.result.current.open([target('other')]);
  });
  const { result } = await harness(parseComposition(JSON.parse(JSON.stringify(initial.document)), 'windows'));
  const root = result.current.entries.find(view => view.groupId === 'team')!;
  const member = result.current.entries.find(view => view.target?.nativeSessionId === 'member')!;
  await act(async () => { result.current.close(member.id); });
  expect(result.current.entries.map(view => view.target?.nativeSessionId)).toEqual(['leader', 'other']);
  await act(async () => { result.current.gather(root, [target('leader'), target('member')]); });
  const opened = result.current.entries.find(view => view.target?.nativeSessionId === 'member')!;
  await act(async () => { result.current.gather(root, [target('leader'), target('member')]); });
  expect(result.current.entries.find(view => view.id === opened.id)?.dockRequest).toBe(opened.dockRequest);
  await act(async () => { result.current.close(root.id); result.current.gather(root, [target('member')]); });
  expect(result.current.entries.map(view => view.target?.nativeSessionId)).toEqual(['other']);
});

it('deduplicates ordinary opens and checks the full group capacity before adding bindings', async () => {
  const { result, document } = await harness();
  await act(async () => { result.current.open([target('same'), target('same')]); });
  await act(async () => { result.current.open([target('same')]); });
  expect(result.current.entries).toHaveLength(1);
  await act(async () => { for (let i = 0; i < 18; i++) result.current.create(); });
  const before = JSON.stringify(document);
  expect(() => result.current.open([target('member')], target('leader'), 'team')).toThrow('Close a session view');
  expect(JSON.stringify(document)).toBe(before);
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

it('retains shared Team member identity and validates its current roster locator after gather', async () => {
  const document = createCompositionDocument('shared-team');
  let window: WorkspaceWindow = { schemaVersion: 1, id: 'shared-team', title: 'Team', revision: 0, primaryViewId: 'main', selectedViewId: 'main', mainMinimized: false, views: [createWindowView('main', undefined, 'primary')] };
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
  const leader = { ...target('old-leader'), teamId: 'team', teamMemberId: 'leader' };
  const member = { ...target('old-member'), teamId: 'team', teamMemberId: 'member' };
  await act(async () => current.open([leader, member], leader, 'team'));
  const root = current.entries.find(entry => entry.teamMemberId === 'leader')!;
  const entry = current.entries.find(entry => entry.teamMemberId === 'member')!;
  expect(entry.target).toMatchObject({ teamId: 'team', teamMemberId: 'member' });
  expect(document.slots.find(slot => slot.id === entry.slotId)?.metadata).toMatchObject({ teamId: 'team', teamMemberId: 'member' });
  await act(async () => current.gather(root, [{ ...member, nativeSessionId: 'new-member' }]));
  expect(current.entries).toHaveLength(2);
  expect(current.entries.find(view => view.teamMemberId === 'member')?.id).toBe(entry.id);
  const team: Team = { id: 'team', operationId: 'create-team', revision: 2, title: 'Team', status: 'active', source: leader,
    members: [{ id: 'member', hostId: 'host', providerId: 'recorded', nativeSessionId: 'new-member', role: 'member', name: 'Member', responsibility: '', creation: 'ready', activity: 'idle', summary: '', updatedAt: 1 }], messages: [], createdAt: 1, updatedAt: 1 };
  expect(teamViewTarget(document, [team], entry.target!, entry.slotId)?.nativeSessionId).toBe('new-member');
  expect(() => teamViewTarget(document, [{ ...team, members: [{ ...team.members[0]!, nativeSessionId: undefined }] }], entry.target!, entry.slotId)).toThrow(/no current execution locator/);
});

it('renders unknown and malformed feature associations as replaceable ordinary session views', async () => {
  const document = createCompositionDocument('opaque-features');
  let window: WorkspaceWindow = { schemaVersion: 1, id: 'opaque', title: 'Window', revision: 0, primaryViewId: 'main', selectedViewId: 'unknown', mainMinimized: false, views: [
    createWindowView('main', undefined, 'primary'),
    { ...createWindowView('unknown', target('ordinary')), feature: { kind: 'external', id: 'tool', metadata: { role: 'member' } } },
    { ...createWindowView('invalid-team', target('other')), feature: { kind: 'team', id: 'team', metadata: { role: 'unsupported', memberId: 'member' } } },
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
  expect(current.entries.map(entry => [entry.id, entry.managed, entry.groupId])).toEqual([
    ['unknown', false, undefined], ['invalid-team', false, undefined],
  ]);
  expect(current.entries.every(entry => !entry.target?.teamId)).toBe(true);
  expect(current.activeId).toBe('unknown');
  await act(async () => current.bind('unknown', target('replacement')));
  expect(current.entries[0]?.target?.nativeSessionId).toBe('replacement');
});
