import { act, useReducer } from 'react';
import { expect, it, vi } from 'vitest';
import { applyWindowOperation, createWindowView, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { windowSessionBinding } from '../window-workspace.js';
import { compositionRoleKey, createCompositionDocument } from '../session-composition.js';
import { bindWindowCompositionSlot, ensureWindowCompositionSlot, projectWindowComposition } from '../window-composition.js';
import { render } from '../test/setup.js';
import { useWindowSessionBridge } from './useWindowSessionBridge.js';

type Options = Parameters<typeof useWindowSessionBridge>[0];
const session = { agentId: 'agent', hostId: 'host', providerId: 'recorded', nativeSessionId: 'native', title: 'Session' };
const emptyWindow = (id = 'window'): WorkspaceWindow => ({ schemaVersion: 2, id, revision: 0, title: 'Window', selectedPrimaryViewId: 'main', selectedViewId: 'main', views: [createWindowView('main', undefined, 'primary')] });
async function harness(configure?: (options: Options) => void) {
  const document = createCompositionDocument('bridge');
  const native = vi.fn(async (..._args: Parameters<Options['succession']['open']>) => true), attached = vi.fn(async () => true), clear = vi.fn(), project = vi.fn((window?: WorkspaceWindow) => { if (window) projectWindowComposition(document, window); });
  const options: Options = { enabled: false, window: emptyWindow(), onError: vi.fn(), readWindow: () => options.window,
    operate: vi.fn(operation => { options.window = applyWindowOperation(options.window!, operation); update(); return Promise.resolve(); }),
    succession: { document, desired: undefined, selected: undefined, discovering: false, navigationIntent: { sessionIntent: undefined, keepOriginal: undefined }, open: native, openAttached: attached,
      ensureWindowView: (windowId, viewId, binding) => ensureWindowCompositionSlot(document, windowId, viewId, binding),
      bindWindowView: (windowId, viewId, binding, slotId) => bindWindowCompositionSlot(document, windowId, viewId, binding, slotId), projectWindow: project, leave: vi.fn(), clearPresentation: clear },
  };
  configure?.(options);
  let bridge!: ReturnType<typeof useWindowSessionBridge>, update!: () => void;
  function Harness() { const [, refresh] = useReducer(n => n + 1, 0); update = refresh; bridge = useWindowSessionBridge(options); return null; }
  await render(<Harness />);
  return { options, native, attached, clear, project, read: () => bridge, update: async () => { await act(async () => update()); } };
}
it('opens an attached native Session View from its local binding while saving remains pending', async () => {
  const test = await harness();
  let finish!: () => void;
  const saved = new Promise<void>(resolve => { finish = resolve; });
  const edit = test.options.operate;
  test.options.operate = vi.fn(operation => { void edit(operation); return saved; });
  let result!: Promise<boolean>;
  await act(async () => { result = test.read().openAttached(session); });
  expect(test.options.window!.views[0]?.binding).toMatchObject({ nativeSessionId: 'native' });
  expect(test.native).toHaveBeenCalledWith(session, undefined, undefined, expect.stringContaining('window:window:main:'), undefined, undefined, session, false);
  expect(await result).toBe(true);
  expect(test.attached).not.toHaveBeenCalled();
  await act(async () => finish());
});

it('reports background save rejection without treating the native Session as rejected or ready', async () => {
  const test = await harness();
  let failSave!: (error: Error) => void, finishNative!: (opened: boolean) => void;
  const saved = new Promise<void>((_resolve, reject) => { failSave = reject; });
  const edit = test.options.operate;
  test.options.operate = operation => { void edit(operation); return saved; };
  test.native.mockImplementationOnce(() => new Promise<boolean>(resolve => { finishNative = resolve; }));
  let result!: Promise<boolean>, settled = false;
  await act(async () => { result = test.read().openAttached(session); void result.then(() => { settled = true; }); });
  expect(test.native).toHaveBeenCalledOnce();
  const error = new Error('Saving failed');
  await act(async () => failSave(error));
  expect(test.options.onError).toHaveBeenCalledWith(error);
  expect(settled).toBe(false);
  await act(async () => { finishNative(false); expect(await result).toBe(false); });
});

it.each([null, windowSessionBinding(session)])('refuses a guarded primary binding after its captured target changes: %j', async expectedBinding => {
  const test = await harness(options => { if (expectedBinding) options.window!.views[0]!.binding = expectedBinding; });
  const operate = test.options.operate;
  test.options.operate = operation => {
    test.options.window = applyWindowOperation(test.options.window!, { type: 'view.bind', viewId: 'main', binding: { ...windowSessionBinding(session), nativeSessionId: 'replacement' } });
    return operate(operation);
  };
  await act(async () => {
    await expect(test.read().openPrimary(session, undefined, false, undefined, undefined, 'main', undefined, expectedBinding)).rejects.toThrow('The target session view changed');
  });
  expect(test.options.window!.views[0]?.binding?.nativeSessionId).toBe('replacement');
  expect(test.native).not.toHaveBeenCalled();
});

it('projects another primary immediately while native discovery is pending', async () => {
  const test = await harness(options => {
    options.enabled = true;
    options.window!.views[0]!.binding = windowSessionBinding(session);
    options.window!.views.push(createWindowView('other', { ...windowSessionBinding(session), nativeSessionId: 'other-native' }, 'primary'));
  });
  test.options.succession.discovering = true;
  test.options.window = { ...test.options.window!, revision: 1, selectedPrimaryViewId: 'other', selectedViewId: 'other' };
  await test.update();
  expect(test.read().primary?.nativeSessionId).toBe('other-native');
  expect(test.options.succession.document.slots.find(slot => slot.id === test.options.succession.document.primary)?.intent.target.native.nativeSessionId).toBe('other-native');
  expect(test.native.mock.calls.at(-1)?.[0]).toMatchObject({ nativeSessionId: 'other-native' });
}, 10000);

it('retains an opening target after another primary is selected without stealing focus', async () => {
  const test = await harness(options => { options.window!.views.push(createWindowView('other', { ...windowSessionBinding(session), nativeSessionId: 'other-native' }, 'primary')); });
  let finish!: () => void;
  test.options.operate = vi.fn(operation => {
    const committed = applyWindowOperation(test.options.window!, operation);
    test.options.window = { ...committed, revision: committed.revision + 1, selectedPrimaryViewId: 'other', selectedViewId: 'other' };
    return new Promise<void>(resolve => { finish = resolve; });
  });
  const result = test.read().openAttached(session);
  await act(async () => { expect(await result).toBe(true); finish(); });
  expect(test.options.window!.views.find(view => view.id === 'main')?.binding?.nativeSessionId).toBe('native');
  expect(test.options.window!.selectedPrimaryViewId).toBe('other');
  expect(test.native).not.toHaveBeenCalled();
}, 10000);

it('binds an explicitly addressed primary without changing another selected group', async () => {
  const test = await harness(options => {
    options.window!.views.push(createWindowView('other', { ...windowSessionBinding(session), nativeSessionId: 'other-native' }, 'primary'));
  });
  await act(async () => { expect(await test.read().openPrimary(session, undefined, false, undefined, undefined, 'other')).toBe(true); });
  expect(test.options.window!.selectedPrimaryViewId).toBe('main');
  expect(test.options.window!.selectedViewId).toBe('main');
  expect(test.options.window!.views.find(view => view.id === 'other')?.binding?.nativeSessionId).toBe('native');
  expect(test.options.window!.views[0]?.binding).toBeUndefined();
  expect(test.native).not.toHaveBeenCalled();
  test.options.window!.views.push(createWindowView('dock'));
  await expect(test.read().openPrimary(session, undefined, false, undefined, undefined, 'dock')).rejects.toThrow('primary');
  await expect(test.read().openPrimary(session, undefined, false, undefined, undefined, 'missing')).rejects.toThrow('primary');
}, 10000);

it('allows another primary projection before a previous native opening finishes', async () => {
  const test = await harness(options => { options.window!.views.push(createWindowView('other', { ...windowSessionBinding(session), nativeSessionId: 'other-native' }, 'primary')); });
  let finish!: (opened: boolean) => void;
  test.native.mockImplementationOnce(() => new Promise<boolean>(resolve => { finish = resolve; }));
  let result!: Promise<boolean>;
  await act(async () => { result = test.read().openAttached(session); });
  test.options.enabled = true;
  test.options.succession.discovering = true;
  test.options.window = { ...test.options.window!, revision: test.options.window!.revision + 1, selectedPrimaryViewId: 'other', selectedViewId: 'other' };
  await test.update();
  expect(test.native.mock.calls.at(-1)?.[0]).toMatchObject({ nativeSessionId: 'other-native' });
  await act(async () => { finish(false); expect(await result).toBe(true); });
  expect(test.options.window!.selectedPrimaryViewId).toBe('other');
}, 10000);

it('does not hold another primary in the previous group concrete history', async () => {
  const test = await harness(options => {
    options.enabled = true; options.window!.views[0]!.binding = windowSessionBinding(session, 'history');
    options.window!.views.push(createWindowView('other', windowSessionBinding(session), 'primary'));
    options.succession.navigationIntent = { sessionIntent: 'history', keepOriginal: true };
  });
  expect(test.native.mock.calls[0]?.[1]).toBe('history');
  expect(test.read().slots?.size).toBe(2);
  test.options.window = { ...test.options.window!, revision: 1, selectedPrimaryViewId: 'other', selectedViewId: 'other' };
  await test.update();
  expect(test.read().concreteHistory).toBe(false);
  expect(test.native.mock.calls.at(-1)?.[3]).toContain('window:window:other:');
}, 10000);
it('does not open native content when local Window validation rejects the binding', async () => {
  const test = await harness(options => { options.operate = vi.fn(() => { throw new Error('Rejected'); }); });
  await expect(test.read().openAttached(session)).rejects.toThrow('Rejected');
  expect(test.native).not.toHaveBeenCalled(); expect(test.project).not.toHaveBeenCalled();
});
it('uses the latest Window for callbacks retained before a Window switch', async () => {
  const test = await harness(); const open = test.read().openAttached;
  test.options.window = emptyWindow('other'); await test.update();
  await act(async () => { await open(session); });
  expect(test.native.mock.calls[0]?.[3]).toContain('window:other:main:');
});
it('does not navigate a new Window when an older binding commit completes', async () => {
  const test = await harness(); let finish!: () => void;
  test.options.operate = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const result = test.read().openAttached(session);
  test.options.window = emptyWindow('other'); await test.update();
  await act(async () => { finish(); await result; });
  expect(test.native).not.toHaveBeenCalled();
});
it('clears only presentation for an empty primary and exposes its empty state', async () => {
  const test = await harness(options => { options.enabled = true; });
  expect(test.read().empty).toBe(true); expect(test.clear).toHaveBeenCalledTimes(1); expect(test.native).not.toHaveBeenCalled();
  await test.update(); expect(test.clear).toHaveBeenCalledTimes(1);
});
it('projects persisted concrete history through shared layout changes and a newly selected Window', async () => {
  const test = await harness(options => { options.enabled = true; options.succession.navigationIntent = { sessionIntent: 'history', keepOriginal: true }; options.window!.views[0]!.binding = windowSessionBinding(session, 'history'); });
  const history = test.read().slots?.get('main');
  expect(history?.intent.kind).toBe('history');
  expect(test.native.mock.calls.at(-1)?.[1]).toBe('history');
  test.options.window = { ...test.options.window!, revision: 1 }; await test.update();
  expect(test.read().slots?.get('main')).toBe(history);
  test.options.window = { ...test.options.window!, id: 'other' }; await test.update();
  expect(test.native.mock.calls.at(-1)?.[3]).toContain('window:other:main:');
  expect(test.native.mock.calls.at(-1)?.[1]).toBe('history');
});
it('commits explicit history intent before opening its independent local slot', async () => {
  const test = await harness();
  await act(async () => { await test.read().openPrimary(session, undefined, false, undefined, undefined, 'main', 'history'); });
  const history = test.read().slots?.get('main');
  expect(test.options.window!.views[0]?.binding?.sessionIntent).toBe('history');
  expect(history?.intent.kind).toBe('history');
  expect(test.native.mock.calls.at(-1)?.slice(0, 4)).toEqual([session, 'history', undefined, history?.id]);
  await act(async () => { await test.read().openPrimary(session); });
  expect(test.options.window!.views[0]?.binding?.sessionIntent).toBeUndefined();
  expect(test.read().slots?.get('main')?.intent.kind).toBe('fixed');
  expect(test.read().slots?.get('main')?.id).not.toBe(history?.id);
});
it('keeps standalone native opening on its existing path', async () => {
  const test = await harness(options => { options.window = undefined; });
  await act(async () => { await test.read().openAttached(session, true); });
  expect(test.attached).toHaveBeenCalledWith(session, true); expect(test.options.operate).not.toHaveBeenCalled();
});

it('projects the latest committed primary after an older native open finishes', async () => {
  const test = await harness();
  let finish!: (opened: boolean) => void;
  test.native.mockImplementationOnce(() => new Promise<boolean>(resolve => { finish = resolve; }));
  let result!: Promise<boolean>;
  await act(async () => { result = test.read().openAttached(session); });
  const next = { ...session, nativeSessionId: 'other-native' };
  test.options.window = applyWindowOperation(test.options.window!, { type: 'view.bind', viewId: 'main', binding: windowSessionBinding(next) });
  test.options.enabled = true;
  await test.update();
  expect(test.native).toHaveBeenCalledTimes(1);
  await act(async () => { finish(true); expect(await result).toBe(false); });
  expect(test.native).toHaveBeenCalledTimes(2);
  expect(test.native.mock.calls[1]?.[0]).toMatchObject({ nativeSessionId: 'other-native' });
  expect(test.options.window!.views[0]!.binding?.nativeSessionId).toBe('other-native');
});

it('exposes the selected dock binding for manager assignment and leaves empty selections unassigned', async () => {
  const test = await harness(options => {
    options.window!.views[0]!.binding = windowSessionBinding(session);
    options.window!.views.push(createWindowView('dock', { ...windowSessionBinding(session), nativeSessionId: 'dock-native' }));
    options.window!.selectedViewId = 'dock';
  });
  expect(test.read().selected?.nativeSessionId).toBe('dock-native');
  test.options.window!.views.push(createWindowView('empty'));
  test.options.window!.selectedViewId = 'empty'; await test.update();
  expect(test.read().selected).toBeUndefined();
});
it('projects the same Window again after replacing its native runtime document', async () => {
  const test = await harness(options => { options.enabled = true; options.window!.views[0]!.binding = windowSessionBinding(session); });
  expect(test.native).toHaveBeenCalledTimes(1);
  test.options.succession.document = createCompositionDocument('bridge');
  test.options.succession.discovering = true;
  await test.update();
  expect(test.native).toHaveBeenCalledTimes(1);
  test.options.succession.discovering = false;
  await test.update();
  expect(test.native).toHaveBeenCalledTimes(2);
});

it('rejects stale opening callbacks while the Window recovery surface is unavailable', async () => {
  const test = await harness(); const open = test.read().openAttached;
  test.options.unavailable = true; test.options.window = undefined; await test.update();
  await expect(open(session)).rejects.toThrow('available Window');
  expect(test.read().empty).toBe(true);
  expect(test.attached).not.toHaveBeenCalled(); expect(test.native).not.toHaveBeenCalled();
}, 10000);

it('does not project cached Window state or publish runtime layout changes while disabled', async () => {
  const test = await harness(options => { options.window!.views[0]!.binding = windowSessionBinding(session); });
  const original = structuredClone(test.options.window);
  const slot = ensureWindowCompositionSlot(test.options.succession.document, 'window', 'main', windowSessionBinding(session));
  slot.intent.target.native.nativeSessionId = 'unconfirmed-runtime';
  test.options.succession.document.primary = slot.id;
  test.options.succession.document.editRevision++;
  await test.update();
  expect(test.project).not.toHaveBeenCalled();
  expect(test.native).not.toHaveBeenCalled();
  expect(test.options.operate).not.toHaveBeenCalled();
  expect(test.options.window).toEqual(original);
});

it('reports synchronous Window validation failures while projecting an applied succession', async () => {
  const test = await harness(options => { options.window!.views[0]!.binding = windowSessionBinding(session); });
  const document = test.options.succession.document;
  const slot = ensureWindowCompositionSlot(document, 'window', 'main', windowSessionBinding(session));
  const native = { controllerId: 'controller', providerId: session.providerId, nativeSessionId: session.nativeSessionId };
  const target = { ...native, nativeSessionId: 'successor' };
  const progress = { revision: 1, status: 'applied' as const, retention: 'page' as const };
  const checkpoint = { scope: document.scope, hostId: session.hostId, controllerId: native.controllerId, roleId: 'role', appliedRevision: 1,
    desired: { operationId: 'handoff', expectedRevision: 0, committedRevision: 1, from: native, to: target,
      projectionDigest: { version: 1 as const, algorithm: 'sha256' as const, hex: 'a'.repeat(64) } },
    documents: { composition: progress, track: progress, ask: progress, draftViews: progress } };
  document.roles.push(checkpoint);
  slot.intent = { kind: 'role', roleKey: compositionRoleKey(checkpoint), revision: 1, target: { hostId: session.hostId, native: target } };
  document.primary = slot.id; document.editRevision++;
  const error = new Error('The local Window is unavailable.');
  test.options.operate = vi.fn(() => { throw error; });
  test.options.enabled = true;
  await test.update();
  expect(test.options.operate).toHaveBeenCalledOnce();
  expect(test.options.onError).toHaveBeenCalledWith(error);
  expect(test.options.window!.views[0]!.binding?.nativeSessionId).toBe(session.nativeSessionId);
}, 10000);
