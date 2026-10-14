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
