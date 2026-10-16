import { act, useEffect, useState } from 'react';
import { afterEach, expect, it } from 'vitest';
import { applyWindowOperation, createWindowView, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import type { RemoteAgentTransport } from '@orchardworks/agent-remote-web';
import { render, unmount } from '../test/setup.js';
import { replicaState } from '../test/fixtures.js';
import { SessionDirectoryClient } from '../directory-client.js';
import { createAskOwner, createCompositionDocument, createCompositionSlot } from '../session-composition.js';
import { bindWindowCompositionSlot, resolveCompositionWindowViewId } from '../window-composition.js';
import { windowSessionBinding } from '../window-workspace.js';
import { useAskConversations } from './useAskConversations.js';

const scope = 'http://localhost/';
const source = { hostId: 'local', providerId: 'codex', nativeSessionId: 'source', agentId: 'source-agent', title: 'Source' };
afterEach(() => { sessionStorage.clear(); localStorage.clear(); });

it('restores one shared Ask through different page-local slots and owners without copying either owner', async () => {
  let shared: WorkspaceWindow = { schemaVersion: 2, id: 'shared-window', revision: 0, title: 'Window', selectedPrimaryViewId: 'source-view', selectedViewId: 'source-view',
    views: [createWindowView('source-view', windowSessionBinding(source), 'primary')] };
  const requests: string[] = [];
  const directory = new SessionDirectoryClient(scope, async (url, init) => {
    const path = new URL(String(url)).pathname; requests.push(path);
    const body = JSON.parse(String(init?.body));
    return Response.json({ agentId: 'ask-agent', nativeSessionId: body.nativeSessionId ?? 'shared-ask-native' });
  });
  async function page(slotId: string) {
    const slot = createCompositionSlot(slotId, source, scope), owner = createAskOwner(slot, scope);
    const document = createCompositionDocument(scope, [slot]); document.asks = [owner]; document.primary = slot.id;
    bindWindowCompositionSlot(document, shared.id, shared.selectedPrimaryViewId, source, slot.id);
    let ask!: ReturnType<typeof useAskConversations>;
    const transport = {} as RemoteAgentTransport;
    function Harness() {
      const [window, changed] = useState(shared);
      ask = useAskConversations(document, transport, directory, 'local', undefined, undefined, {
        window, resolveViewId: id => resolveCompositionWindowViewId(document, window, id),
        operate(operation) { shared = applyWindowOperation(shared, operation); changed(shared); },
      });
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
  const second = await page('page-two-independent-slot');
  expect(second.owner.id).not.toBe(first.owner.id);
  expect(second.current().sharedView(second.owner.id)?.id).toBe(feature.id);
  expect(second.current().isEnabled(source, second.owner.id)).toBe(true);
  expect(second.current().isOpen(source, second.owner.id)).toBe(true);
  expect(second.current().draftBinding(second.owner.id).store.get(second.owner.text.key)).toBe('');
  await act(async () => { await second.current().open(undefined, source, '', false, { associationOwner: second.owner.id }); });
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
  let shared: WorkspaceWindow = { schemaVersion: 2, id: 'same-window', revision: 0, title: 'Window', selectedPrimaryViewId: 'main', selectedViewId: 'main',
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
  let shared: WorkspaceWindow = { schemaVersion: 2, id: 'opening-window', revision: 0, title: 'Window', selectedPrimaryViewId: 'main', selectedViewId: 'main',
    views: [createWindowView('main', windowSessionBinding(source), 'primary')] };
  const listeners = new Set<(window: WorkspaceWindow) => void>();
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
        operate(operation) { shared = applyWindowOperation(shared, operation); for (const listener of listeners) listener(shared); },
      });
      const binding = ask.sharedView(owner.id)?.binding;
      useEffect(() => { if (automatic) ask.restore(source, async () => {}, owner.id); }, [JSON.stringify(binding)]);
      return null;
    }
    const container = await render(<Harness />);
    return { container, owner, current: () => ask };
  }
  const first = await page('first-opening-owner', false);
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
  await unmount(second.container); await unmount(first.container);
});
