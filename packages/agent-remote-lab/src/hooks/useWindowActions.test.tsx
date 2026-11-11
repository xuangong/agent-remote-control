import { act, useReducer } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import type { WindowGroup, WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import type { useWindowWorkspace } from './useWindowWorkspace.js';
import { render } from '../test/setup.js';
import { touchWindow } from '../window-recency.js';
import { useWindowActions } from './useWindowActions.js';

afterEach(() => { vi.restoreAllMocks(); localStorage.clear(); });

const SCOPE = 'http://localhost/window-actions/';
const windowOf = (id: string): WorkspaceWindow => ({ schemaVersion: 3, id, title: `Window ${id}`, revision: 0, selectedPrimaryViewId: null, selectedViewId: null, views: [] });

/**
 * A workspace that behaves like useWindowWorkspace where the actions depend on it: open and create switch the active
 * Window, and remove refuses the active one, as its active-Window guard does.
 */
async function fixture({ ids = ['a', 'b', 'c'], active = 'a', groups = [] as WindowGroup[], provisional = false, confirmed = true } = {}) {
  let windows = ids.map(windowOf), current = active, client: object | undefined;
  let update!: () => void;
  const calls: string[] = [];
  let openSwitches = true, created = 0;
  const open = vi.fn(async (id: string) => { calls.push(`open:${id}`); if (openSwitches) { current = id; update(); } });
  const create = vi.fn(async (options?: { empty?: boolean }) => {
    const window = windowOf(`new-${++created}`); calls.push(`create:${window.id}${options?.empty ? ':empty' : ''}`);
    windows = [...windows, window]; current = window.id; update();
  });
  const remove = vi.fn(async (id: string) => {
    calls.push(`remove:${id}`);
    if (id === current) throw new Error('Switch to another Window before deleting the active Window.');
    windows = windows.filter(window => window.id !== id); update();
  });
  const operateGroup = vi.fn(async () => {});
  let result!: ReturnType<typeof useWindowActions>;
  function Harness() {
    [, update] = useReducer(value => value + 1, 0);
    const window = windows.find(candidate => candidate.id === current);
    const workspace = { window, windows, groups, client, hasActiveWindow: confirmed && !!window, provisional, unavailable: false,
      readWindow: () => windows.find(candidate => candidate.id === current),
      open, create, remove, operateGroup, operate: async () => {} } as unknown as ReturnType<typeof useWindowWorkspace>;
    result = useWindowActions(workspace, SCOPE);
    return <p>{result.notice}</p>;
  }
  const container = await render(<Harness />);
  return { container, calls, open, create, remove, operateGroup, actions: () => result, current: () => current, ids: () => windows.map(window => window.id),
    stopSwitching() { openSwitches = false; },
    async switchTo(id: string) { await act(async () => { current = id; update(); }); },
    async useClient(next: object | undefined) { await act(async () => { client = next; update(); }); } };
}

it('copies the Window link without Bot route fields', async () => {
  const test = await fixture();
  const writeText = vi.fn(async (_value: string) => {});
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
  history.replaceState(null, '', '/?window=b&mode=bot&section=s&bot=x&keep=1');
  await act(async () => { await test.actions().copyLink(); });
  const url = new URL(writeText.mock.calls[0]![0]);
  expect(url.searchParams.get('window')).toBe('a');
  expect(url.searchParams.get('keep')).toBe('1');
  expect(['mode', 'section', 'bot'].some(key => url.searchParams.has(key))).toBe(false);
  expect(test.actions().notice).toBe('Window link copied.');
  expect(test.actions().noticeTone).toBe('info');
});

it('shows the Window as a section after the last ranked section', async () => {
  const test = await fixture({ groups: [{ window: windowOf('x'), bots: { rank: 'b' } }, { window: windowOf('y'), bots: { rank: 'd' } }] as unknown as WindowGroup[] });
  await act(async () => { await test.actions().showAsSection(); });
  expect(test.operateGroup).toHaveBeenCalledWith('a', { type: 'bots.add', rank: 'dm' });
  expect(test.actions().notice).toBe('Shown as a section in Bot mode.');
});

it('ranks the first section in the middle', async () => {
  const test = await fixture();
  await act(async () => { await test.actions().showAsSection(); });
  expect(test.operateGroup).toHaveBeenCalledWith('a', { type: 'bots.add', rank: 'm' });
});

it('runs one action at a time and reports a failure as the notice', async () => {
  const test = await fixture();
  let finish!: () => void;
  let first!: Promise<boolean>, second!: Promise<boolean>;
  await act(async () => { first = test.actions().run(() => new Promise<void>(resolve => { finish = resolve; })); });
  expect(test.actions().busy).toBe(true);
  await act(async () => { second = test.actions().run(async () => {}); });
  expect(await second).toBe(false);
  await act(async () => finish());
  expect(await first).toBe(true);
  expect(test.actions().busy).toBe(false);
  let failed!: boolean;
  await act(async () => { failed = await test.actions().run(async () => { throw new Error('The server refused this change.'); }); });
  expect(failed).toBe(false);
  expect(test.actions().notice).toBe('The server refused this change.');
});

it('deletes the current Window after opening the most recently used other one', async () => {
  touchWindow(SCOPE, 'b', 1); touchWindow(SCOPE, 'c', 2);
  const test = await fixture();
  let deleted!: boolean;
  await act(async () => { deleted = await test.actions().deleteCurrent(); });
  expect(deleted).toBe(true);
  expect(test.calls).toEqual(['open:c', 'remove:a']);
  expect(test.current()).toBe('c');
  expect(test.ids()).toEqual(['b', 'c']);
});

it('creates a Window before deleting the only one', async () => {
  const test = await fixture({ ids: ['a'] });
  await act(async () => { await test.actions().deleteCurrent(); });
  expect(test.calls).toEqual(['create:new-1:empty', 'remove:a']);
  expect(test.current()).toBe('new-1');
  expect(test.ids()).toEqual(['new-1']);
});

it('keeps the current Window and says so when no other Window opens', async () => {
  const test = await fixture();
  test.open.mockRejectedValue(new Error('This Window is unavailable.'));
  let deleted!: boolean;
  await act(async () => { deleted = await test.actions().deleteCurrent(); });
  expect(deleted).toBe(false);
  expect(test.open.mock.calls.map(([id]) => id)).toEqual(['b', 'c']);
  expect(test.remove).not.toHaveBeenCalled();
  expect(test.create).not.toHaveBeenCalled();
  expect(test.current()).toBe('a');
  expect(test.actions().notice).toBe('The Window was not deleted: This Window is unavailable.');
});

it('tries the next Window when one fails to open', async () => {
  const test = await fixture();
  test.open.mockImplementationOnce(async id => { test.calls.push(`open:${id}`); throw new Error('This Window is unavailable.'); });
  let deleted!: boolean;
  await act(async () => { deleted = await test.actions().deleteCurrent(); });
  expect(deleted).toBe(true);
  expect(test.calls).toEqual(['open:b', 'open:c', 'remove:a']);
  expect(test.current()).toBe('c');
  expect(test.actions().notice).toBeUndefined();
});

it('reports a failure in the Window it reached when opening switched and then failed', async () => {
  const test = await fixture();
  test.open.mockImplementationOnce(async id => { test.calls.push(`open:${id}`); await test.switchTo(id); throw new Error('The Window scope changed before opening.'); });
  let deleted!: boolean;
  await act(async () => { deleted = await test.actions().deleteCurrent(); });
  expect(deleted).toBe(false);
  expect(test.calls).toEqual(['open:b']);
  expect(test.current()).toBe('b');
  expect(test.ids()).toEqual(['a', 'b', 'c']);
  expect(test.actions().notice).toBe('The Window was not deleted: The Window scope changed before opening.');
});

it('reports a failed creation of the replacement Window', async () => {
  const test = await fixture({ ids: ['a'] });
  test.create.mockRejectedValueOnce(new Error('Storage full'));
  let deleted!: boolean;
  await act(async () => { deleted = await test.actions().deleteCurrent(); });
  expect(deleted).toBe(false);
  expect(test.remove).not.toHaveBeenCalled();
  expect(test.actions().notice).toBe('The Window was not deleted: Storage full');
});

it('never switches to a Window whose deletion is still in flight', async () => {
  touchWindow(SCOPE, 'c', 1); touchWindow(SCOPE, 'a', 2); touchWindow(SCOPE, 'b', 3);
  const test = await fixture();
  let finish!: () => void;
  test.remove.mockImplementationOnce(id => { test.calls.push(`remove:${id}`); return new Promise<void>(resolve => { finish = resolve; }); });
  let first!: Promise<boolean>;
  await act(async () => { first = test.actions().deleteCurrent(); });
  expect(test.current()).toBe('b');
  // A is still listed while its deletion runs; deleting B now goes to C rather than back to A.
  expect(test.ids()).toContain('a');
  await act(async () => { await test.actions().deleteCurrent(); });
  expect(test.calls).toEqual(['open:b', 'remove:a', 'open:c', 'remove:b']);
  expect(test.current()).toBe('c');
  await act(async () => finish());
  expect(await first).toBe(true);
});

it('keeps the Window when a newer navigation superseded the switch, and says so', async () => {
  // open() resolves without switching when another navigation superseded it; remove's guard then refuses the active Window.
  const test = await fixture();
  test.stopSwitching();
  let deleted!: boolean;
  await act(async () => { deleted = await test.actions().deleteCurrent(); });
  expect(deleted).toBe(false);
  expect(test.calls).toEqual(['open:b', 'remove:a']);
  expect(test.ids()).toEqual(['a', 'b', 'c']);
  expect(test.actions().notice).toBe('The Window was not deleted: Switch to another Window before deleting the active Window.');
});

it('reports a failed deletion in the Window it switched to', async () => {
  const test = await fixture();
  test.remove.mockImplementationOnce(async () => { throw new Error('The server refused this change.'); });
  let deleted!: boolean;
  await act(async () => { deleted = await test.actions().deleteCurrent(); });
  expect(deleted).toBe(false);
  expect(test.current()).toBe('b');
  expect(test.ids()).toEqual(['a', 'b', 'c']);
  expect(test.actions().notice).toBe('The Window was not deleted: The server refused this change.');
});

it('deletes another Window by id', async () => {
  const test = await fixture();
  await act(async () => { await test.actions().deleteWindow('b'); });
  expect(test.ids()).toEqual(['a', 'c']);
});

it('shows a notice only in the Window and client it was given in', async () => {
  const test = await fixture();
  await act(async () => test.actions().setNotice('Only for A.'));
  expect(test.actions().notice).toBe('Only for A.');
  await test.switchTo('b');
  expect(test.actions().notice).toBeUndefined();
  await test.switchTo('a');
  expect(test.actions().notice).toBeUndefined();
  await act(async () => test.actions().setNotice('Only for this client.'));
  await test.useClient({});
  expect(test.actions().notice).toBeUndefined();
  await test.useClient(undefined);
  expect(test.actions().notice).toBeUndefined();
});

it('gives a failure notice the error tone', async () => {
  const test = await fixture();
  await act(async () => { await test.actions().run(async () => { throw new Error('Relay offline'); }); });
  expect([test.actions().notice, test.actions().noticeTone]).toEqual(['Relay offline', 'error']);
});

it.each([['provisional', { provisional: true }], ['not yet confirmed', { confirmed: false }]] as const)('does not delete a Window that is %s', async (_state, options) => {
  const test = await fixture(options);
  let deleted!: boolean;
  await act(async () => { deleted = await test.actions().deleteCurrent(); });
  expect(deleted).toBe(false);
  expect(test.calls).toEqual([]);
  expect(test.current()).toBe('a');
});
