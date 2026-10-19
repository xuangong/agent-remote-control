import { act, useEffect, useState } from 'react';
import { afterEach, expect, it } from 'vitest';
import { applyWindowOperation, createWindowView, type WindowOperation, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import type { RemoteAgentTransport } from '@orchardworks/agent-remote-web';
import { render, unmount } from '../test/setup.js';
import { replicaState } from '../test/fixtures.js';
import { SessionDirectoryClient } from '../directory-client.js';
import { createAskOwner, createCompositionDocument, createCompositionSlot } from '../session-composition.js';
import { bindWindowCompositionSlot, resolveCompositionWindowViewId } from '../window-composition.js';
import { windowSessionBinding } from '../window-workspace.js';
import { createWindowFeature } from '../window-feature-views.js';
import { useAskConversations } from './useAskConversations.js';

const scope = 'http://localhost/';
const source = { hostId: 'local', providerId: 'codex', nativeSessionId: 'source', agentId: 'source-agent', title: 'Source' };
afterEach(() => { sessionStorage.clear(); localStorage.clear(); });

it('minimizes and closes the final legacy Ask without selecting a missing source pane', async () => {
  const slot = createCompositionSlot('retained-source', source, scope), owner = createAskOwner(slot, scope);
  const document = createCompositionDocument(scope, [slot]); document.asks = [owner];
  const view = { ...createWindowView('ask-only', undefined, 'float'), feature: createWindowFeature({ kind: 'ask', id: owner.id }), bindingPolicy: 'managed' as const };
  let shared: WorkspaceWindow = { schemaVersion: 3, id: 'ask-only-window', revision: 0, title: 'Window', selectedPrimaryViewId: null, selectedViewId: view.id, views: [view] };
  let ask!: ReturnType<typeof useAskConversations>;
  const operations: WindowOperation[] = [];
  function Harness() {
    const [window, changed] = useState(shared);
    ask = useAskConversations(document, {} as RemoteAgentTransport, new SessionDirectoryClient(scope), 'local', undefined, undefined, {
      window, resolveViewId: () => undefined,
      operate(operation) { operations.push(operation); shared = applyWindowOperation(shared, operation); changed(shared); },
    });
    return null;
  }
  const container = await render(<Harness />);
  await act(async () => { ask.minimize(source, owner.id); });
  expect(operations).toEqual([{ type: 'view.collapse', viewId: view.id, collapsed: true }]);
  expect(ask.isOpen(source, owner.id)).toBe(false);
  await act(async () => { ask.close(source, owner.id); });
  expect(shared).toMatchObject({ views: [], selectedViewId: null, selectedPrimaryViewId: null });
  expect(document.slots).toEqual([slot]);
  expect(document.asks).toEqual([owner]);
  await unmount(container);
});

it('restores one shared Ask through different page-local slots and owners without copying either owner', async () => {
  let shared: WorkspaceWindow = { schemaVersion: 3, id: 'shared-window', revision: 0, title: 'Window', selectedPrimaryViewId: 'source-view', selectedViewId: 'source-view',
    views: [createWindowView('source-view', windowSessionBinding(source), 'primary')] };
  const requests: string[] = [];
  const directory = new SessionDirectoryClient(scope, async (url, init) => {
    const path = new URL(String(url)).pathname; requests.push(path);
    const body = JSON.parse(String(init?.body));
    return Response.json({ agentId: 'ask-agent', nativeSessionId: body.nativeSessionId ?? 'shared-ask-native' });
  });
  async function page(slotId: string, automatic = false) {
    const slot = createCompositionSlot(slotId, source, scope), owner = createAskOwner(slot, scope);
    const document = createCompositionDocument(scope, [slot]); document.asks = [owner]; document.primary = slot.id;
    bindWindowCompositionSlot(document, shared.id, 'source-view', source, slot.id);
    let ask!: ReturnType<typeof useAskConversations>;
    const transport = {} as RemoteAgentTransport;
    function Harness() {
      const [window, changed] = useState(shared);
      ask = useAskConversations(document, transport, directory, 'local', undefined, undefined, {
        window, resolveViewId: id => resolveCompositionWindowViewId(document, window, id),
        operate(operation) { shared = applyWindowOperation(shared, operation); changed(shared); },
      });
      ask.entryFor(source, owner.id);
      const binding = ask.sharedView(owner.id)?.binding, expanded = ask.isOpen(source, owner.id);
      useEffect(() => { if (automatic && expanded) return ask.restore(source, async () => {}, owner.id); }, [expanded, JSON.stringify(binding)]);
      return null;
    }
    const container = await render(<Harness />);
    return { document, owner, container, current: () => ask };
  }
  const first = await page('page-one-native-slot');
  await act(async () => { await first.current().open(replicaState, source, '', false, { associationOwner: first.owner.id }); });
  const feature = first.current().sharedView(first.owner.id)!;
  expect(feature.closeWith).toBe('source-view');
  expect(feature.binding?.nativeSessionId).toBe('shared-ask-native');
  first.current().setDraft(first.owner.id, 'First page draft');
  await unmount(first.container);
  sessionStorage.clear();
  const second = await page('page-two-independent-slot', true);
  expect(second.owner.id).not.toBe(first.owner.id);
  expect(second.current().sharedView(second.owner.id)?.id).toBe(feature.id);
  expect(second.current().isEnabled(source, second.owner.id)).toBe(true);
  expect(second.current().isOpen(source, second.owner.id)).toBe(true);
  expect(second.current().draftBinding(second.owner.id).store.get(second.owner.text.key)).toBe('');
  expect(second.current().entryFor(source, second.owner.id)).toMatchObject({ attached: true, record: { remote: true, target: { nativeSessionId: 'shared-ask-native', agentId: 'ask-agent' } } });
  expect(requests.filter(path => path.endsWith('/create'))).toHaveLength(1);
  expect(requests.filter(path => path.endsWith('/attach'))).toHaveLength(1);
  expect(second.document.slots.map(slot => slot.id)).toEqual(['page-two-independent-slot']);
  expect(second.document.asks.map(owner => owner.id)).toEqual([second.owner.id]);
  expect(shared.views.filter(view => view.feature?.kind === 'ask')).toHaveLength(1);
  await act(async () => second.current().close(source, second.owner.id));
  expect(shared.views.some(view => view.id === feature.id)).toBe(false);
  await act(async () => { await second.current().open(undefined, source, '', false, { associationOwner: second.owner.id }); });
  expect(second.current().entryFor(source, second.owner.id).attached).toBe(true);
  expect(requests.filter(path => path.endsWith('/create'))).toHaveLength(1);
  expect(requests.filter(path => path.endsWith('/attach'))).toHaveLength(2);
});

it('keeps the original Ask source owner after an independent main-view binding change', async () => {
  const sourceB = { ...source, nativeSessionId: 'source-B', agentId: 'agent-B', title: 'B' };
  const slotA = createCompositionSlot('local-source-A', source, scope), ownerA = createAskOwner(slotA, scope);
  const document = createCompositionDocument(scope, [slotA]); document.asks = [ownerA]; document.primary = slotA.id;
  let shared: WorkspaceWindow = { schemaVersion: 3, id: 'same-window', revision: 0, title: 'Window', selectedPrimaryViewId: 'main', selectedViewId: 'main',
    views: [createWindowView('main', windowSessionBinding(source), 'primary')] };
  bindWindowCompositionSlot(document, shared.id, 'main', source, slotA.id);
  const transport = {} as RemoteAgentTransport;
  const directory = new SessionDirectoryClient(scope, async () => Response.json({ agentId: 'ask-A-agent', nativeSessionId: 'ask-A' }));
  let ask!: ReturnType<typeof useAskConversations>, change!: (window: WorkspaceWindow) => void;
  function Harness() {
    const [window, changed] = useState(shared); change = changed;
    ask = useAskConversations(document, transport, directory, 'local', undefined, undefined, {
      window, resolveViewId: id => resolveCompositionWindowViewId(document, window, id),
      operate(operation) { shared = applyWindowOperation(shared, operation); changed(shared); },
    });
    return null;
  }
  await render(<Harness />);
  await act(async () => { await ask.open(replicaState, source, '', false, { associationOwner: ownerA.id }); });
  const askViewId = ask.sharedView(ownerA.id)!.id;
  const slotB = createCompositionSlot('local-source-B', sourceB, scope), ownerB = createAskOwner(slotB, scope);
  document.slots.push(slotB); document.asks.push(ownerB);
  bindWindowCompositionSlot(document, shared.id, 'main', sourceB, slotB.id);
  await act(async () => {
    shared = applyWindowOperation(shared, { type: 'view.bind', viewId: 'main', binding: windowSessionBinding(sourceB) });
    change(shared);
  });
  expect(document.slots.map(slot => slot.id)).toEqual(['local-source-A', 'local-source-B']);
  expect(ask.sharedView(ownerA.id)?.id).toBe(askViewId);
  expect(ask.sharedView(ownerB.id)).toBeUndefined();
  expect(ask.isOpen(source, ownerA.id)).toBe(true);
  expect(ask.isOpen(sourceB, ownerB.id)).toBe(false);
  expect(ask.entryFor(sourceB, ownerB.id).record).toBeUndefined();
  expect(shared.views.find(view => view.id === askViewId)?.closeWith).toBe('main');
});

it('waits for another page to finish opening a shared Ask before attaching its published binding', async () => {
  let shared: WorkspaceWindow = { schemaVersion: 3, id: 'opening-window', revision: 0, title: 'Window', selectedPrimaryViewId: 'main', selectedViewId: 'main',
    views: [createWindowView('main', windowSessionBinding(source), 'primary')] };
  const listeners = new Set<(window: WorkspaceWindow) => void>();
  function publish(operation: WindowOperation) {
    shared = applyWindowOperation(shared, operation);
    for (const listener of listeners) listener(shared);
  }
  const requests: string[] = [];
  let finishCreate!: () => void;
  const createPending = new Promise<void>(resolve => { finishCreate = resolve; });
  const fetcher: typeof fetch = async (url, init) => {
    const path = new URL(String(url)).pathname; requests.push(path);
    if (path.endsWith('/create')) await createPending;
    const body = JSON.parse(String(init?.body));
    return Response.json({ agentId: 'ask-agent', nativeSessionId: body.nativeSessionId ?? 'published-ask' });
  };
  async function page(id: string, automatic: boolean) {
    // Separate scopes model independent tabs' session storage in this single-window harness.
    const pageScope = `${scope}${id}/`;
    const pageDirectory = new SessionDirectoryClient(pageScope, fetcher);
    const slot = createCompositionSlot(id, source, pageScope), owner = createAskOwner(slot, pageScope);
    const document = createCompositionDocument(pageScope, [slot]); document.asks = [owner]; document.primary = slot.id;
    bindWindowCompositionSlot(document, shared.id, 'main', source, slot.id);
    let ask!: ReturnType<typeof useAskConversations>;
    const transport = {} as RemoteAgentTransport;
    function Harness() {
      const [window, changed] = useState(shared);
      useEffect(() => { listeners.add(changed); return () => { listeners.delete(changed); }; }, []);
      ask = useAskConversations(document, transport, pageDirectory, 'local', undefined, undefined, {
        window, resolveViewId: id => resolveCompositionWindowViewId(document, window, id),
        operate: publish,
      });
      ask.entryFor(source, owner.id);
      const binding = ask.sharedView(owner.id)?.binding, expanded = ask.isOpen(source, owner.id);
      useEffect(() => { if (automatic && expanded) return ask.restore(source, async () => {}, owner.id); }, [expanded, JSON.stringify(binding)]);
      return null;
    }
    const container = await render(<Harness />);
    return { container, owner, current: () => ask };
  }
  const first = await page('first-opening-owner', true);
  let opening!: Promise<unknown>;
  await act(async () => { opening = first.current().open(replicaState, source, '', false, { associationOwner: first.owner.id }); });
  expect(first.current().sharedView(first.owner.id)?.binding).toBeUndefined();
  const second = await page('second-opening-owner', true);
  expect(second.current().entryFor(source, second.owner.id).error).toBeUndefined();
  expect(requests.filter(path => path.endsWith('/create'))).toHaveLength(1);
  await act(async () => { finishCreate(); await opening; });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  expect(second.current().entryFor(source, second.owner.id), JSON.stringify({requests, shared,entry:second.current().entryFor(source,second.owner.id)})).toMatchObject({ attached: true, record: { target: { nativeSessionId: 'published-ask' } } });
  expect(second.current().entryFor(source, second.owner.id).error).toBeUndefined();
  expect(requests.filter(path => path.endsWith('/create'))).toHaveLength(1);
  expect(requests.filter(path => path.endsWith('/attach'))).toHaveLength(1);
  const viewId = first.current().sharedView(first.owner.id)!.id;
  await act(async () => {
    const { schemaVersion: _, id: __, revision: ___, ...layout } = shared;
    publish({ type: 'layout.apply', layout: { ...layout, views: layout.views.map(view => view.id === viewId
      ? { ...view, binding: { ...view.binding!, nativeSessionId: 'replacement-ask' } } : view) } });
  });
  for (const page of [first, second]) expect(page.current().entryFor(source, page.owner.id)).toMatchObject({ attached: true,
    record: { target: { nativeSessionId: 'replacement-ask' } } });
  expect(requests.filter(path => path.endsWith('/create'))).toHaveLength(1);
  expect(requests.filter(path => path.endsWith('/attach'))).toHaveLength(3);
  await unmount(second.container); await unmount(first.container);
});

it.each([false, true].flatMap(deferred => ['ask', 'attached', 'other'].map(selection => ({ deferred, selection }))))('retains minimized Ask geometry and display across page reload ($selection, deferred layout: $deferred)', async ({ deferred, selection }) => {
  const geometry = { x: 52, y: 70, width: 380, height: 660 };
  const display = { mode: 'preview' as const, lettersVisible: false };
  const binding = { ...windowSessionBinding(source), nativeSessionId: 'retained-ask-native', title: 'Ask' };
  const feature = { ...createWindowView('retained-ask', binding, 'float'), geometry, display,
    feature: createWindowFeature({ kind: 'ask', id: 'retained-ask-feature', source }), closeWith: 'main', bindingPolicy: 'managed' as const };
  let shared: WorkspaceWindow = { schemaVersion: 3, id: 'retained-layout-window', revision: 0, title: 'Window',
    selectedPrimaryViewId: selection === 'other' ? 'other' : 'main', selectedViewId: selection === 'ask' ? feature.id : selection,
    views: [{ ...createWindowView('main', windowSessionBinding(source), 'primary'), display: { mode: 'content', lettersVisible: true } },
      createWindowView('other', undefined, 'primary'), feature, { ...createWindowView('attached', undefined, 'attached'), attachedTo: feature.id }] };
  const requests: string[] = [];
  const directory = new SessionDirectoryClient(scope, async (url, init) => {
    requests.push(new URL(String(url)).pathname);
    const body = JSON.parse(String(init?.body));
    return Response.json({ agentId: 'retained-ask-agent', nativeSessionId: body.nativeSessionId });
  });
  async function page(id: string) {
    const slot = createCompositionSlot(id, source, scope), owner = createAskOwner(slot, scope);
    const document = createCompositionDocument(scope, [slot]); document.asks = [owner]; document.primary = slot.id;
    bindWindowCompositionSlot(document, shared.id, 'main', source, slot.id);
    let ask!: ReturnType<typeof useAskConversations>, publish!: (window: WorkspaceWindow) => void;
    const pending: WindowOperation[] = [];
    let rejectNext = false;
    function Harness() {
      const [window, changed] = useState(shared); publish = changed;
      ask = useAskConversations(document, {} as RemoteAgentTransport, directory, 'local', undefined, undefined, {
        window, resolveViewId: id => resolveCompositionWindowViewId(document, window, id),
        operate(operation) {
          if (rejectNext) { rejectNext = false; return; }
          if (deferred) pending.push(operation);
          else { shared = applyWindowOperation(shared, operation); changed(shared); }
        },
      });
      return null;
    }
    const container = await render(<Harness />);
    return { owner, container, current: () => ask, rejectNext() { rejectNext = true; }, flush() {
      for (const operation of pending.splice(0)) shared = applyWindowOperation(shared, operation);
      publish(shared);
    } };
  }
  const first = await page('first-owner');
  first.current().setDraft(first.owner.id, 'Retained source question');
  await act(async () => first.current().minimize(source, first.owner.id));
  expect(first.current().isOpen(source, first.owner.id)).toBe(deferred);
  await act(async () => first.flush());
  expect(first.current().isOpen(source, first.owner.id)).toBe(false);
  expect(first.current().sharedView(first.owner.id)).toMatchObject({ id: feature.id, collapsed: true, geometry, display, binding });
  expect(shared.selectedViewId).toBe(selection === 'other' ? 'other' : 'main');
  expect(first.current().draftBinding(first.owner.id).store.get(first.owner.text.key)).toBe('Retained source question');
  await unmount(first.container);
  sessionStorage.clear();
  shared = JSON.parse(JSON.stringify(shared)) as WorkspaceWindow;
  const second = await page('second-owner');
  expect(second.owner.id).not.toBe(first.owner.id);
  expect(second.current().isOpen(source, second.owner.id)).toBe(false);
  expect(second.current().sharedView(second.owner.id)).toMatchObject({ id: feature.id, collapsed: true, geometry, display, binding });
  await act(async () => { await second.current().open(undefined, source, '', false, { associationOwner: second.owner.id }); second.flush(); });
  expect(second.current().isOpen(source, second.owner.id)).toBe(true);
  expect(second.current().sharedView(second.owner.id)).toMatchObject({ id: feature.id, collapsed: false, geometry, display, binding });
  expect(shared.views.find(view => view.id === 'main')?.display).toEqual({ mode: 'content', lettersVisible: true });
  expect(requests).toEqual(['/v1/remote/attach']);
  second.rejectNext();
  await act(async () => { second.current().minimize(source, second.owner.id); second.flush(); });
  expect(second.current().isOpen(source, second.owner.id)).toBe(true);
  expect(second.current().entryFor(source, second.owner.id).attached).toBe(true);
  expect(second.current().sharedView(second.owner.id)).toMatchObject({ id: feature.id, collapsed: false, geometry, display, binding });
  await act(async () => {
    second.current().minimize(source, second.owner.id);
    await second.current().open(undefined, source, '', false, { associationOwner: second.owner.id });
    second.flush();
  });
  expect(second.current().sharedView(second.owner.id)).toMatchObject({ id: feature.id, collapsed: false, geometry, display, binding });
  expect(shared.views.filter(view => view.feature?.kind === 'ask')).toHaveLength(1);
  await act(async () => { second.current().close(source, second.owner.id); second.flush(); });
  expect(second.current().sharedView(second.owner.id)).toBeUndefined();
});
