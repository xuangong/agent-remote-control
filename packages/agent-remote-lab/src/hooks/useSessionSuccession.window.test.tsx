import 'fake-indexeddb/auto';
import { createServer } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { act, useState, useSyncExternalStore } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { AgentReplica, HttpWebSocketTransport, WindowWorkspaceClient } from '@orchardworks/agent-remote-web';
import { configureImageDraftPersistence } from '@orchardworks/agent-remote-web/browser';
import { PROTOCOL_VERSION, applyWindowOperation, createWindowView, type SessionSuccessionReplay, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { ConversationConnections } from '../conversation-connections.js';
import { SessionDirectoryClient } from '../directory-client.js';
import { DraftStore } from '../draft-store.js';
import * as composition from '../session-composition.js';
import { render, unmount } from '../test/setup.js';
import { replicaState } from '../test/fixtures.js';
import { WindowWorkspaceStore } from '../window-workspace.js';
import { useAskConversations } from './useAskConversations.js';
import { useSessionTracking } from './useSessionTracking.js';
import { useSessionSuccession } from './useSessionSuccession.js';
import { useWindowSessionBridge } from './useWindowSessionBridge.js';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const stop of cleanup.splice(0).reverse()) await stop(); configureImageDraftPersistence(() => true); });
const native = (nativeSessionId: string) => ({ controllerId: 'installation', providerId: 'recorded', nativeSessionId });
function handoff(): SessionSuccessionReplay {
  const request = { operationId: 'handoff-a', roleId: 'role-a', expectedRevision: 1, from: native('A') };
  const workspace = { controllerId: 'installation', canonicalCwd: '/fixture' };
  return { version: 1, from: { hostId: 'host', providerId: 'recorded', nativeSessionId: 'A' }, to: { hostId: 'host', providerId: 'recorded', nativeSessionId: 'A2' },
    projection: { version: 1, role: { id: 'role-a', revision: 2, origin: native('A'), current: native('A2'), workspace },
      receipt: { ...request, to: native('A2'), phase: 'committed', committedRevision: 2, startedAt: 'now', updatedAt: 'now',
        prepared: { ...request, to: native('A2'), workspace, associationRevision: 1, participants: [], capture: { epoch: 'epoch', seq: 1, capturedAt: 'now' } } } } };
}
async function fixture(shared = false) {
  const a = { hostId: 'host', providerId: 'recorded', nativeSessionId: 'A', title: 'Group A' };
  const b = { ...a, nativeSessionId: 'B', title: 'Group B' };
  const window: WorkspaceWindow = { schemaVersion: 3, id: 'workspace', revision: 1, title: 'Window', selectedPrimaryViewId: 'a', selectedViewId: 'a',
    views: [createWindowView('a', a, 'primary'), createWindowView('b', b, 'primary')] };
  let persistedWindow = structuredClone(window);
  const attachments: Array<{ nativeSessionId: string; parentNativeSessionId?: string }> = [];
  const failedAttachments = new Set<string>();
  let replays: SessionSuccessionReplay[] = [], holdNext = false, entered = false;
  let releaseListing: (() => void) | undefined;
  const server = createServer(async (request, response) => {
    const url = new URL(request.url!, 'http://fixture');
    let body = '';
    for await (const chunk of request) body += chunk;
    let value: unknown;
    if (url.pathname.startsWith('/v1/windows/')) {
      if (request.method === 'POST') {
        const mutation = JSON.parse(body);
        persistedWindow = applyWindowOperation(persistedWindow, mutation.operation);
        value = { window: persistedWindow, result: { operationId: mutation.operationId, status: 'committed', revision: persistedWindow.revision,
          committedAt: Date.now(), expiresAt: Date.now() + 86400000 } };
      } else value = { window: persistedWindow };
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(value)); return;
    }
    if (url.pathname.endsWith('/attach')) {
      const input = JSON.parse(body), nativeSessionId = input.nativeSessionId;
      attachments.push(input);
      if (failedAttachments.has(nativeSessionId)) { response.statusCode = 403; response.end(JSON.stringify({ error: 'Fixture attachment unavailable.' })); return; }
      if (!shared && nativeSessionId !== 'B-history') return;
      value = { agentId: `agent-${nativeSessionId}`, nativeSessionId };
    }
    if (url.pathname.endsWith('/session-successions') && !url.searchParams.has('roleId') && holdNext) {
      holdNext = false; entered = true;
      await new Promise<void>(resolve => { releaseListing = resolve; });
    }
    if (url.pathname.endsWith('/session-successions/current')) value = { version: 1, role: replays[0]!.projection.role, locator: replays[0]!.to };
    else if (url.pathname.endsWith('/session-successions/operation')) value = replays[0];
    else if (url.pathname.endsWith('/session-successions')) value = { version: 1, successions: replays, nextCursor: null };
    else if (!url.pathname.endsWith('/attach')) { response.statusCode = 404; value = { error: 'Fixture route unavailable.' }; }
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(value));
  });
  const sockets = new WebSocketServer({ server });
  sockets.on('connection', socket => {
    const subscriptions = new Map<string, string>();
    socket.on('message', data => {
      const frame = JSON.parse(String(data));
      if (frame.type === 'subscribe') subscriptions.set(frame.subscriptionId, frame.agentId);
      const agentId = subscriptions.get(frame.subscriptionId);
      const emit = (message: unknown) => socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'message', subscriptionId: frame.subscriptionId, message }));
      if (frame.type === 'subscribe') {
        emit({ protocolVersion: PROTOCOL_VERSION, type: 'negotiated', sessionControl: true });
        emit({ protocolVersion: PROTOCOL_VERSION, type: 'agent_snapshot', payload: { ...replicaState.agent, id: agentId, providerId: 'recorded',
          runtimeInfo: { ...replicaState.agent!.runtimeInfo, providerId: 'recorded', sessionId: agentId!.slice('agent-'.length), connection: { state: 'connected' } } } });
        emit({ protocolVersion: PROTOCOL_VERSION, type: 'session_control', payload: { agentId, revision: 'control', access: 'control', available: false, token: 'token' } });
      }
      if (frame.message?.type === 'session_control_request') emit({ protocolVersion: PROTOCOL_VERSION, type: 'session_control', payload: {
        agentId, requestId: frame.message.payload.requestId, revision: 'control', access: 'control', available: false, token: 'token' } });
      if (frame.message?.type === 'timeline_subscription') emit({ protocolVersion: PROTOCOL_VERSION, type: 'timeline_subscribed', payload: { requestId: frame.message.payload.requestId, agentIds: [agentId] } });
      if (frame.message?.type === 'timeline_request') emit({ protocolVersion: PROTOCOL_VERSION, type: 'timeline_page', payload: {
        requestId: frame.message.payload.requestId, agentId, direction: frame.message.payload.direction, epoch: `epoch-${agentId}`, reset: false, staleCursor: false, gap: false, error: null,
        window: { minSeq: 0, maxSeq: 0, nextSeq: 1 }, startCursor: null, endCursor: null, hasOlder: false, hasNewer: false, entries: [],
      } });
    });
    socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'ready', successions: 1 }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Fixture has no address.');
  const scope = `http://127.0.0.1:${address.port}`;
  const transport = new HttpWebSocketTransport(scope, { WebSocket, sessionChannels: true, sessionSuccessions: true });
  const connections = new ConversationConnections(transport, scope), stores = new Map<string, DraftStore>();
  const client = new WindowWorkspaceClient(scope);
  let windowStore = new WindowWorkspaceStore((await client.inspect(window.id)).window, client);
  const replicas = new Map<string, AgentReplica>();
  let succession!: ReturnType<typeof useSessionSuccession>;
  let bridge!: ReturnType<typeof useWindowSessionBridge>;
  let setEnabled!: (enabled: boolean) => void;
  configureImageDraftPersistence(() => false);
  function Harness() {
    const [enabled, updateEnabled] = useState(true); setEnabled = updateEnabled;
    const workspace = useSyncExternalStore(windowStore.subscribe, windowStore.getSnapshot);
    succession = useSessionSuccession({ scope, transport, connections, enabled,
      replicaFor(id) { let replica = replicas.get(id); if (!replica) replicas.set(id, replica = new AgentReplica()); return replica; },
      directory: hostId => new SessionDirectoryClient(scope, undefined, hostId),
      textStore(key) { let store = stores.get(key); if (!store) stores.set(key, store = new DraftStore(key)); return store; },
      tracking: () => tracking, ask: () => ask,
      layout: () => ({ path: [], selections: {}, collapsed: [] }),
      retireNative() {}, bindNative() {}, confirmed() {}, failed() {},
    });
    const ask = useAskConversations(succession.document, transport);
    const tracking = useSessionTracking(scope, transport, undefined, [], [], connections, false);
    bridge = useWindowSessionBridge({ enabled: shared && enabled, window: shared ? workspace : undefined, readWindow: windowStore.getSnapshot,
      succession, operate: operation => windowStore.operate(operation), onError(error) { throw error; } });
    return null;
  }
  let container = await render(<Harness />);
  cleanup.push(async () => {
    await unmount(container); connections.clear(); releaseListing?.();
    for (const socket of sockets.clients) socket.terminate();
    await new Promise<void>(resolve => sockets.close(() => resolve()));
    server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve()));
  });
  if (!shared) await act(async () => { await succession.refresh(); });
  await vi.waitFor(() => expect({ discovering: succession.discovering, error: succession.error }).toEqual({ discovering: false, error: undefined }));
  const aSlot = succession.ensureWindowView(window.id, 'a', a), bSlot = succession.ensureWindowView(window.id, 'b', b);
  await act(async () => { succession.projectWindow(window); await succession.open(a, undefined, undefined, aSlot.id); });
  if (shared) await vi.waitFor(async () => { await act(async () => {}); expect(succession.binding?.session.nativeSessionId).toBe('A'); });
  return { read: () => succession, window, a, b, aSlot, bSlot, connections, attachments, directory: new SessionDirectoryClient(scope, undefined, 'host'),
    setEnabled: (enabled: boolean) => setEnabled(enabled),
    failAttachment(nativeSessionId: string, failed = true) { if (failed) failedAttachments.add(nativeSessionId); else failedAttachments.delete(nativeSessionId); },
    bridge: () => bridge, store: () => windowStore,
    async remount() {
      await unmount(container); connections.clear();
      windowStore = new WindowWorkspaceStore((await client.inspect(window.id)).window, client);
      container = await render(<Harness />);
    },
    commit() { replays = [handoff()]; },
    commitAndHold() { replays = [handoff()]; holdNext = true; }, entered: () => entered, release: () => releaseListing?.() };
}

it('accepts a shared child from its SessionFamily without a coordinator attachment', async () => {
  const test = await fixture(true);
  const child = { ...test.a, nativeSessionId: 'child', parentNativeSessionId: 'A', title: 'Child' };
  await act(async () => { await test.store().operate({ type: 'view.create', view: { ...createWindowView('child-view', child, 'attached'), attachedTo: 'a' } }); });
  const slot = test.bridge().slots!.get('child-view')!;
  await vi.waitFor(() => expect(test.read().document.edges).toContainEqual({ source: test.aSlot.id, target: slot.id, selected: true }));
  expect(test.attachments.filter(value => value.nativeSessionId === 'child')).toEqual([]);
  await act(async () => {
    const attached = await test.directory.attachChild(child.providerId, 'A', 'child');
    test.read().rememberSide({ ...child, agentId: attached.agentId, viewId: slot.id });
    await test.read().refresh();
  });
  expect(test.read().layoutView()?.sides).toContainEqual({ ...child, agentId: 'agent-child', viewId: slot.id });
  expect(test.attachments.filter(value => value.nativeSessionId === 'child')).toHaveLength(1);
}, 10000);

it('remembers a shared Side with existing metadata once and still saves changed titles', async () => {
  const test = await fixture(true);
  const child = { ...test.a, nativeSessionId: 'child', parentNativeSessionId: 'A', title: 'Child' };
  await act(async () => { await test.store().operate({ type: 'view.create', view: { ...createWindowView('child-view', child, 'attached'), attachedTo: 'a' } }); });
  const slot = test.bridge().slots!.get('child-view')!;
  const session = { ...child, agentId: 'agent-child', viewId: slot.id };
  slot.metadata = composition.compositionSessionMetadata(session);
  expect(test.read().layoutView()?.sides).not.toContainEqual(session);
  await act(async () => { test.read().rememberSide(session); });
  expect(test.read().layoutView()?.sides).toContainEqual(session);

  const revision = test.read().document.editRevision;
  const save = vi.spyOn(composition, 'saveCompositionDocument');
  try {
    await act(async () => { test.read().rememberSide({ viewId: session.viewId, agentId: session.agentId, ...child }); });
    expect(test.read().document.editRevision).toBe(revision);
    expect(save).not.toHaveBeenCalled();

    const renamed = { ...session, title: 'Renamed child' };
    await act(async () => { test.read().rememberSide(renamed); });
    expect(test.read().layoutView()?.sides).toContainEqual(renamed);
    expect(slot.metadata?.title).toBe('Renamed child');
    expect(test.read().document.editRevision).toBeGreaterThan(revision);
    expect(save).toHaveBeenCalled();
  } finally { save.mockRestore(); }
}, 10000);

it('still attaches a standalone descendant through the succession coordinator', async () => {
  const test = await fixture();
  const child = { ...test.a, nativeSessionId: 'child', parentNativeSessionId: 'A', title: 'Child' };
  await act(async () => {
    const slot = test.read().ensureView(child);
    test.read().projectWindow(undefined);
    test.read().document.edges = [{ source: test.aSlot.id, target: slot.id, selected: true }];
    test.read().document.editRevision++;
    await test.read().refresh();
  });
  await vi.waitFor(() => expect(test.attachments.filter(value => value.nativeSessionId === 'child')).toEqual([{ providerId: 'recorded', parentNativeSessionId: 'A', nativeSessionId: 'child' }]));
}, 10000);

it('retains a failed explicit shared view through reselection and retries only on request', async () => {
  const test = await fixture(true);
  test.failAttachment('B');
  await act(async () => { await test.store().operate({ type: 'view.select', viewId: 'b' }); });
  await vi.waitFor(() => expect(test.read().error).toBe('Fixture attachment unavailable.'));
  await act(async () => { await test.read().open(test.b, undefined, undefined, test.bSlot.id); });
  expect(test.read().error).toBe('Fixture attachment unavailable.');
  expect(test.attachments.filter(value => value.nativeSessionId === 'B')).toHaveLength(1);
  test.failAttachment('B', false);
  await act(async () => test.read().retry());
  await vi.waitFor(() => expect(test.read().binding?.session.nativeSessionId).toBe('B'));
  expect(test.attachments.filter(value => value.nativeSessionId === 'B')).toHaveLength(2);
}, 10000);

it('restores a shared successor only after access and authorized replay resume', async () => {
  const test = await fixture(true);
  test.commit();
  await act(async () => { await test.read().refreshCommitted('handoff-a'); });
  await vi.waitFor(async () => { await act(async () => {}); expect(test.read().binding?.session.nativeSessionId).toBe('A2'); });
  await act(async () => test.setEnabled(false));
  expect(test.read().binding).toBeUndefined();
  test.commitAndHold();
  await act(async () => test.setEnabled(true));
  await vi.waitFor(() => expect(test.entered()).toBe(true));
  expect(test.read().binding).toBeUndefined();
  await act(async () => test.release());
  await vi.waitFor(async () => { await act(async () => {}); expect(test.read().binding?.session.nativeSessionId).toBe('A2'); });
}, 10000);

it('keeps a shared history group beside a live group through Handoff, selection and reload over HTTP', async () => {
  const test = await fixture(true);
  await act(async () => { expect(await test.bridge().openPrimary(test.a, undefined, false, undefined, undefined, 'a', 'history')).toBe(true); });
  const history = test.bridge().slots!.get('a')!;
  expect(history.intent.kind).toBe('history');
  expect(test.read().desired?.slot.id).toBe(history.id);
  expect(test.store().getSnapshot().views[0]?.binding?.sessionIntent).toBe('history');
  await act(async () => { await test.store().operate({ type: 'view.select', viewId: 'b' }); });
  await vi.waitFor(() => expect(test.read().selected?.nativeSessionId).toBe('B'));
  test.commit();
  await act(async () => { await test.read().refreshCommitted('handoff-a'); });
  expect(test.aSlot.intent.target.native.nativeSessionId).toBe('A2');
  expect(history.intent.target.native.nativeSessionId).toBe('A');
  expect(test.bridge().slots?.get('a')).toBe(history);
  expect(test.bridge().slots?.get('b')?.intent.kind).toBe('fixed');
  await test.remount();
  await vi.waitFor(() => expect(test.read().selected?.nativeSessionId).toBe('B'));
  expect(test.bridge().slots?.get('a')?.id).toBe(history.id);
  expect(test.bridge().slots?.get('a')?.intent.kind).toBe('history');
  await act(async () => { await test.store().operate({ type: 'view.select', viewId: 'a' }); });
  await vi.waitFor(() => expect(test.read().desired?.slot.id).toBe(history.id));
  expect(test.read().selected?.nativeSessionId).toBe('A');
  expect(test.read().navigationIntent.sessionIntent).toBe('history');
  expect(test.store().getSnapshot().views.find(view => view.id === 'b')?.binding?.nativeSessionId).toBe('B');
}, 10000);

it.each(['bound', 'empty', 'history'])('verifies a committed Handoff after a %s group replaces its pending discovery', async mode => {
  const test = await fixture();
  test.commitAndHold();
  let settled!: Promise<{ ok: boolean; error?: string }>;
  await act(async () => {
    settled = test.read().refreshCommitted('handoff-a').then(() => ({ ok: true }), error => ({ ok: false, error: String(error) }));
  });
  await vi.waitFor(() => expect(test.entered()).toBe(true));
  await act(async () => {
    test.read().projectWindow({ ...test.window, selectedPrimaryViewId: 'b', selectedViewId: 'b',
      views: mode !== 'empty' ? test.window.views : [test.window.views[0]!, createWindowView('b', undefined, 'primary')] });
    if (mode === 'bound') await test.read().open(test.b, undefined, undefined, test.bSlot.id);
    else if (mode === 'history') await test.read().open({ ...test.b, nativeSessionId: 'B-history' }, 'history');
    else test.read().clearPresentation();
  });
  test.release();
  expect(await settled).toEqual({ ok: true });
  expect(test.read().selected?.nativeSessionId).toBe(mode === 'bound' ? 'B' : mode === 'history' ? 'B-history' : undefined);
  if (mode === 'history') {
    expect(test.read().desired?.sessionIntent).toBe('history');
    expect(test.read().desired?.slot.intent.kind).toBe('history');
  }
  expect(test.aSlot.intent.target.native.nativeSessionId).toBe('A2');
  expect(test.read().document.roles[0]?.appliedRevision).toBe(2);
  const source = { ...test.a, nativeSessionId: 'A2', viewId: test.aSlot.id };
  expect(test.read().historyNavigationFor(source)).toMatchObject({ history: false, session: { nativeSessionId: 'A2' }, predecessor: { nativeSessionId: 'A' } });
  expect(test.read().historyNavigationFor({ ...source, nativeSessionId: 'A' })).toBeUndefined();
  expect(test.read().historyNavigationFor({ ...source, viewId: test.bSlot.id })).toBeUndefined();
  expect(test.read().successionContextFor(test.aSlot.id)).toEqual({ operationId: 'handoff-a', target: native('A2') });
  expect(test.read().successionContextFor(test.bSlot.id)).toBeUndefined();
}, 10000);

it.each(['selected', 'unselected'])('accepts a %s group independently connected by its stable Session View', async mode => {
  const test = await fixture();
  if (mode === 'unselected') await act(async () => {
    test.read().projectWindow({ ...test.window, selectedPrimaryViewId: 'b', selectedViewId: 'b' });
    await test.read().open(test.b, undefined, undefined, test.bSlot.id);
  });
  const source = { ...test.a, agentId: 'agent-A', viewId: test.aSlot.id };
  const lease = test.connections.acquire(source.agentId, new AgentReplica(), source);
  await vi.waitFor(() => expect(lease.replica.getState().agent?.runtimeInfo.sessionId).toBe('A'));
  expect(test.read().binding).toBeUndefined();
  expect(test.read().sourceCurrent(source)).toBe(true);
  expect(test.read().sourceCurrent({ ...source, agentId: 'wrong-agent' })).toBe(false);
  expect(test.read().sourceCurrent({ ...source, viewId: test.bSlot.id })).toBe(false);
  lease.release();
}, 10000);
