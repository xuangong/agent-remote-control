import 'fake-indexeddb/auto';
import { createServer, type Server } from 'node:http';
import { act as reactAct, StrictMode, useState, type ComponentProps } from 'react';
import { WebSocket, WebSocketServer } from 'ws';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, applyWindowOperation, createWindowView, type WindowMutation, type WorkspaceWindow, type AgentChildSession, type ProjectedTimelineEntry, type SessionSuccessionReplay, type Team } from '@orchardworks/agent-remote-protocol';
import { configureImageDraftPersistence } from '@orchardworks/agent-client-web/browser';
import { HttpWebSocketTransport } from '@orchardworks/agent-client';
import { App, type LabTransport } from './App.js';
import { SessionDirectoryClient, type OpenedSession, type SuccessionActionResult, type SuccessionDescription } from './directory-client.js';
import { DraftStore } from './draft-store.js';
import { replicaState } from './test/fixtures.js';
import { render, unmount } from './test/setup.js';
import * as workbenchComponents from './components/LabWorkbench.js';
import { WorkspaceReady } from './workspace-access.js';
import type { FavoritesSnapshot } from './session-stars-client.js';


export function saveSessionComposition(scope: string, value: { path: OpenedSession[]; focus?: string; anchor?: string; addressKey: string }) {
  sessionStorage.setItem(`agent-remote:recovery:${scope}:composition`, JSON.stringify(value));
}
// These tests drive a real Relay and the whole App, so a loaded machine can slow every step. A test that ran past its deadline
// would keep running after Vitest moved on, and React work it started would overlap the next test's, which breaks React's act
// environment for every later test in the file. So each wait gives up long before the deadline, waits stop once their test
// has ended, and the hooks let React work already running finish, for a bounded time, before the next test or the cleanup.
export const testDeadline = 30_000;
// Every test here renders the whole App through succession and recovery; under a busy full run 10 s is not enough.
vi.setConfig({ testTimeout: testDeadline });
const actSettleBound = 5_000;
vi.setConfig({ testTimeout: testDeadline, hookTimeout: 3 * actSettleBound });
const runningActs = new Set<Promise<unknown>>();
let actsAllowed = true;
export function act<T>(callback: () => T | Promise<T>): Promise<T> {
  if (!actsAllowed) return Promise.reject(new Error('This test has ended.'));
  const work: Promise<T> = Promise.resolve(reactAct(callback)).finally(() => runningActs.delete(work));
  runningActs.add(work);
  return work;
}
let currentTest = { ended: false };
/** Retries the callback until it returns without throwing; every attempt finishes before the next starts or the wait gives up. */
export async function waitFor<T>(callback: () => T | Promise<T>, { timeout = 5000, interval = 20 }: { timeout?: number; interval?: number } = {}): Promise<T> {
  const test = currentTest, deadline = Date.now() + timeout;
  for (;;) {
    try { return await callback(); }
    catch (error) { if (test.ended || Date.now() >= deadline) throw error; }
    await new Promise(resolve => setTimeout(resolve, interval));
    if (test.ended) throw new Error('This test has ended.');
  }
}
/** Lets React work already running finish, for at most actSettleBound: work that never settles must not stop the cleanup. */
async function settleRunningActs() {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const settled = await Promise.race([Promise.allSettled([...runningActs]).then(() => true),
    new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(false), actSettleBound); })]);
  clearTimeout(timer);
  // Work that did not settle in that time is abandoned, so the hooks of the following tests do not wait for it again.
  if (!settled) runningActs.clear();
}
export const cleanups: Array<() => Promise<void> | void> = [];
beforeEach(async () => { await settleRunningActs(); currentTest = { ended: false }; actsAllowed = true; });
afterEach(async () => {
  currentTest.ended = true; actsAllowed = false;
  await settleRunningActs();
  for (const stop of cleanups.splice(0).reverse()) await stop();
  localStorage.clear(); sessionStorage.clear(); configureImageDraftPersistence(() => true); vi.restoreAllMocks(); vi.unstubAllGlobals();
});
export const native = (nativeSessionId: string, providerId = 'recorded') => ({ controllerId: 'installation', providerId, nativeSessionId });
export function committed(from = 'A', to = 'B', revision = 2, roleId = 'primary', providerId = 'recorded'): SessionSuccessionReplay {
  const request = { operationId: `${roleId}-op-${revision}`, roleId, expectedRevision: revision - 1, from: native(from, providerId) };
  const workspace = { controllerId: 'installation', canonicalCwd: '/fixture' };
  return { version: 1, from: { hostId: 'host', providerId, nativeSessionId: from }, to: { hostId: 'host', providerId, nativeSessionId: to },
    projection: { version: 1, role: { id: roleId, revision, origin: native(roleId === 'primary' ? 'A' : 'X', providerId), current: native(to, providerId), workspace },
      receipt: { ...request, to: native(to, providerId), phase: 'committed', committedRevision: revision, startedAt: 'now', updatedAt: 'now',
        prepared: { ...request, to: native(to, providerId), workspace, associationRevision: 1, participants: [], capture: { epoch: 'epoch', seq: 1, capturedAt: 'now' } } } } };
}
export async function failureFixture(advanceDuringRecovery = false, nativeIdentity?: string | null, strict = false, flags = '', setup?: { otherWindows?: WorkspaceWindow[]; hostService?: ComponentProps<typeof App>['hostService']; beforeWindowMutation?(mutation: WindowMutation): Promise<void>; windowDocument?: WorkspaceWindow; persistPrompt?: boolean; successionCommit?(): SuccessionActionResult; successionPrepare?(body: Record<string, unknown>): Promise<SuccessionActionResult>; teams?(): Team[]; chain?: SessionSuccessionReplay[]; replayFailure?: string; selected?: string; providerId?: string; userScoped?: boolean; favorites?: FavoritesSnapshot; liveActivity?: boolean; holdRelationsInitially?: boolean; holdReplayInitially?: boolean; holdTimelineInitially?: boolean; holdSnapshotInitially?: boolean; holdAccessInitially?: boolean; nativeConnection?: 'connected' | 'restoring'; preserveNativeState?: boolean; children?: AgentChildSession[]; timeline?: ProjectedTimelineEntry[]; nativeStatus?: 'idle' | 'running'; successionDescription?: SuccessionDescription; successionStatus?(): SuccessionActionResult; attachmentFailure?(body: Record<string, unknown>): { status: number; payload: unknown } | undefined; seed?(scope: string, source: OpenedSession): void | Promise<void> }) {
  configureImageDraftPersistence(() => setup?.persistPrompt === true);
  const requests: Array<{ url: string; body?: Record<string, unknown> }> = [];
  const hostedWindows = new Map<string, WorkspaceWindow>();
  const windowReceipts = new Map<string, unknown>();
  if (setup?.windowDocument) hostedWindows.set(setup.windowDocument.id, setup.windowDocument);
  for (const other of setup?.otherWindows ?? []) hostedWindows.set(other.id, other);
  const providerId = setup?.providerId ?? 'recorded';
  const nativeBindings = new Map<string, string>();
  const nativeFor = (agentId: string) => [...nativeBindings].find(([, binding]) => binding === agentId)?.[0] ?? agentId.slice('agent-'.length);
  const pendingInteractions = (agentId: string) => setup?.preserveNativeState && agentId === 'agent-A' ? [{ kind: 'question', requestId: 'question-A',
    questions: [{ questionId: 'one', header: 'Original question', prompt: 'Choose for A', selection: 'single', required: true,
      options: [{ value: 'web', label: 'Web' }], allowCustomText: false, allowDismiss: false }] }] : [];
  const chain = setup?.chain ?? [committed('A', 'B', 2, 'primary', providerId)];
  let replayFailure = setup?.replayFailure;
  let favorites = setup?.favorites;
  let createGate: Promise<void> | undefined, releaseCreate: (() => void) | undefined;
  let relationsGate: Promise<void> | undefined, releaseRelations: (() => void) | undefined;
  if (setup?.holdRelationsInitially) relationsGate = new Promise(resolve => { releaseRelations = resolve; });
  let releaseTimeline: (() => void) | undefined;
  const timelineGate = setup?.holdTimelineInitially ? new Promise<void>(resolve => { releaseTimeline = resolve; }) : undefined;
  let releaseSnapshot: (() => void) | undefined, releaseAccess: (() => void) | undefined;
  const snapshotGate = setup?.holdSnapshotInitially ? new Promise<void>(resolve => { releaseSnapshot = resolve; }) : undefined;
  const accessGate = setup?.holdAccessInitially ? new Promise<void>(resolve => { releaseAccess = resolve; }) : undefined;
  const attachmentGates = new Map<string, Promise<void>>();
  let currentGate: Promise<void> | undefined;
  let controlGate: Promise<void> | undefined;
  let replayGate: Promise<void> | undefined;
  let releaseReplay: (() => void) | undefined;
  if (setup?.holdReplayInitially) replayGate = new Promise(resolve => { releaseReplay = resolve; });
  const server: Server = createServer(async (request, response) => {
    const url = new URL(request.url!, 'http://fixture');
    let body: Record<string, unknown> | undefined;
    if (request.method === 'POST') { let data = ''; for await (const chunk of request) data += String(chunk); body = JSON.parse(data); }
    requests.push({ url: request.url!, body });
    if ((setup?.userScoped || setup?.windowDocument) && url.pathname.startsWith('/v1/windows')) {
      if (url.pathname.endsWith('/changes')) { await new Promise<void>(resolve => response.once('close', resolve)); return; }
      const segments = url.pathname.split('/').filter(Boolean), id = segments[2];
      let payload: unknown;
      if (request.method === 'POST') {
        let document: WorkspaceWindow;
        if (!id) document = body!.window as WorkspaceWindow;
        else {
          await setup.beforeWindowMutation?.(body as unknown as WindowMutation);
          try { document = applyWindowOperation(hostedWindows.get(id)!, (body as unknown as WindowMutation).operation); }
          catch (error) {
            const current = hostedWindows.get(id)!;
            const result = { operationId: body!.operationId, status: 'rejected', revision: current.revision,
              code: error && typeof error === 'object' && 'code' in error ? String(error.code) : 'invalid_operation',
              message: error instanceof Error ? error.message : String(error), committedAt: Date.now(), expiresAt: Date.now() + 86400000 };
            windowReceipts.set(String(body!.operationId), result);
            response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ window: current, result })); return;
          }
        }
        hostedWindows.set(document.id, document);
        if (setup.windowDocument?.id === document.id) setup.windowDocument = document;
        const result = { operationId: body!.operationId, status: 'committed', revision: document.revision,
          committedAt: Date.now(), expiresAt: Date.now() + 86400000 };
        windowReceipts.set(String(body!.operationId), result);
        payload = { window: document, result };
      } else if (segments[3] === 'operations') payload = { result: windowReceipts.get(segments[4]!) };
      else if (!id) payload = { windows: [...hostedWindows.values()] };
      else if (hostedWindows.has(id)) payload = { window: hostedWindows.get(id) };
      else { response.statusCode = 404; payload = { code: 'window_not_found', error: 'Window is unavailable.' }; }
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(payload)); return;
    }
    if (url.pathname.includes('/session-successions') && replayGate) await replayGate;
    if (url.pathname.includes('/session-successions') && replayFailure === 'network') { request.socket.destroy(); return; }
    if (url.pathname.includes('/session-successions') && replayFailure) { response.writeHead(404, { 'content-type': 'application/json' }); response.end(JSON.stringify({ code: replayFailure, error: 'Fixture succession route unavailable.' })); return; }
    let value: unknown;
    if (url.pathname.endsWith('/session-successions/current')) {
      if (currentGate) await currentGate;
      if (advanceDuringRecovery && chain.length === 1) chain.push(committed('B', 'C', 3));
      const current = chain.filter(item => item.projection.role.id === url.searchParams.get('roleId')).at(-1)!;
      value = { version: 1, role: current.projection.role, locator: current.to };
    }
    else if (url.pathname.endsWith('/session-successions/operation')) value = chain.find(item => item.projection.receipt.operationId === url.searchParams.get('operationId'));
    else if (url.pathname.endsWith('/session-successions')) {
      if (Number(url.searchParams.get('limit')) > 64) { response.statusCode = 400; value = { error: 'Replay page limit exceeded.' }; }
      else value = { version: 1, successions: url.searchParams.has('roleId') ? chain.filter(item => item.projection.role.id === url.searchParams.get('roleId')) : chain, nextCursor: null };
    }
    else if (url.pathname.endsWith('/teams')) value = { teams: setup?.teams?.() ?? [] };
    else if (url.pathname.endsWith('/succession/describe') && setup?.successionDescription) value = setup.successionDescription;
    else if (url.pathname.endsWith('/succession/commit') && setup?.successionCommit) value = setup.successionCommit();
    else if (url.pathname.endsWith('/succession/prepare') && setup?.successionPrepare) value = await setup.successionPrepare(body!);
    else if (url.pathname.endsWith('/succession/status') && setup?.successionStatus) value = setup.successionStatus();
    else if (url.pathname.endsWith('/create')) { if (createGate) await createGate; value = { agentId: 'agent-S', nativeSessionId: 'S' }; }
    else if (url.pathname.endsWith('/session-relations')) { if (relationsGate) await relationsGate; value = { relations: [] }; }
    else if (url.pathname.endsWith('/favorites') && favorites) value = favorites;
    else if (url.pathname.endsWith('/attach')) {
      await attachmentGates.get(String(body!.nativeSessionId));
      const failure = setup?.attachmentFailure?.(body!);
      if (failure) { response.statusCode = failure.status; value = failure.payload; }
      else if (nativeIdentity !== undefined) value = { agentId: nativeBindings.get(String(body!.nativeSessionId)) ?? `agent-${body!.nativeSessionId}`, nativeSessionId: body!.nativeSessionId };
      else { response.statusCode = 503; value = { code: 'host_offline', error: 'Fixture successor unavailable.' }; }
    }
    else if (url.pathname.endsWith('/providers')) value = { protocolVersion: PROTOCOL_VERSION, type: 'provider_list', payload: { providers: [] } };
    else if (url.pathname.endsWith('/timeline')) {
      const agentId = decodeURIComponent(url.pathname.split('/').at(-2)!);
      value = { protocolVersion: PROTOCOL_VERSION, type: 'timeline_page', payload: {
        requestId: url.searchParams.get('requestId') ?? 'history-page', agentId, direction: url.searchParams.get('direction'), epoch: `epoch-${agentId}`, reset: false, staleCursor: false, gap: false, error: null,
        window: { minSeq: 0, maxSeq: setup?.timeline?.length ?? 0, nextSeq: (setup?.timeline?.length ?? 0) + 1 }, startCursor: null, endCursor: null, hasOlder: false, hasNewer: false, entries: setup?.timeline ?? [],
      } };
    }
    else if (url.pathname.endsWith('/snapshot')) {
      const agentId = decodeURIComponent(url.pathname.split('/').at(-2)!);
      value = { protocolVersion: PROTOCOL_VERSION, type: 'agent_snapshot', payload: { ...replicaState.agent, id: agentId, providerId, status: setup?.nativeStatus ?? 'idle', pendingInteractions: pendingInteractions(agentId),
        runtimeInfo: { ...replicaState.agent!.runtimeInfo, providerId, status: setup?.nativeStatus ?? 'idle', childSessions: setup?.children, sessionId: agentId === 'agent-B' ? nativeIdentity : nativeFor(agentId), connection: { state: 'connected' } } } };
    }
    else if (url.pathname.endsWith('/catalog')) value = { sessions: [], revision: '1', nextCursor: null };
    else { response.statusCode = 404; value = { error: 'Fixture service unavailable.' }; }
    response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(value));
  });
  const sockets = new WebSocketServer({ server });
  const frames: Array<{ type: string; agentId?: string; message?: { type: string; payload?: Record<string, unknown> } }> = [];
  const updates: Array<(identity: string | null, connection?: 'connected' | 'restoring') => void> = [];
  const updatesByAgent = new Map<string, (identity: string | null, connection?: 'connected' | 'restoring') => void>();
  const activeUpdates = new Map<string, Set<(identity: string | null, connection?: 'connected' | 'restoring') => void>>();
  const activityUpdates = new Map<string, Set<(status: 'idle' | 'running' | 'waiting') => void>>();
  // A shown conversation reports activity through its content subscription.
  const contentStatus = new Map<string, Set<(status: 'idle' | 'running' | 'waiting') => void>>();
  sockets.on('connection', socket => {
    const subscriptions = new Map<string, string>();
    const callbacks = new Map<string, (identity: string | null, connection?: 'connected' | 'restoring') => void>();
    const activityCallbacks = new Map<string, (status: 'idle' | 'running' | 'waiting') => void>();
    const statusCallbacks = new Map<string, (status: 'idle' | 'running' | 'waiting') => void>();
    const retire = (id: string) => {
      const callback = callbacks.get(id); if (callback) activeUpdates.get(subscriptions.get(id)!)?.delete(callback);
      const activity = activityCallbacks.get(id); if (activity) activityUpdates.get(subscriptions.get(id)!)?.delete(activity);
      const status = statusCallbacks.get(id); if (status) contentStatus.get(subscriptions.get(id)!)?.delete(status);
      callbacks.delete(id); activityCallbacks.delete(id); statusCallbacks.delete(id); subscriptions.delete(id);
    };
    socket.on('close', () => { for (const id of subscriptions.keys()) retire(id); });
    socket.on('message', async data => {
      const frame = JSON.parse(String(data)); frames.push(frame);
      if (frame.type === 'unsubscribe') { retire(frame.subscriptionId); return; }
      if (frame.type === 'subscribe') subscriptions.set(frame.subscriptionId, frame.agentId);
      const agentId = subscriptions.get(frame.subscriptionId)!;
      const emit = (message: unknown) => socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'message', subscriptionId: frame.subscriptionId, message }));
      if (frame.type === 'subscribe') {
        emit({ protocolVersion: PROTOCOL_VERSION, type: 'negotiated', sessionControl: true });
        if (setup?.liveActivity && frame.message?.observation === 'activity') {
          const update = (status: 'idle' | 'running' | 'waiting') => emit({ protocolVersion: PROTOCOL_VERSION, type: 'agent_activity', payload: { agentId, status } });
          const active = activityUpdates.get(agentId) ?? new Set(); activityUpdates.set(agentId, active); active.add(update); activityCallbacks.set(frame.subscriptionId, update);
          update('idle');
          return;
        }
        const update = (identity: string | null, connection: 'connected' | 'restoring' = 'connected') => emit({ protocolVersion: PROTOCOL_VERSION, type: 'agent_snapshot', payload: {
          ...replicaState.agent, id: frame.agentId, providerId, status: setup?.nativeStatus ?? 'idle', pendingInteractions: pendingInteractions(agentId), runtimeInfo: { ...replicaState.agent!.runtimeInfo, providerId, status: setup?.nativeStatus ?? 'idle', childSessions: setup?.children, sessionId: identity, connection: { state: connection } },
        } });
        const active = activeUpdates.get(agentId) ?? new Set(); activeUpdates.set(agentId, active); active.add(update); callbacks.set(frame.subscriptionId, update);
        const status = (value: 'idle' | 'running' | 'waiting') => emit({ protocolVersion: PROTOCOL_VERSION, type: 'agent_snapshot', payload: {
          ...replicaState.agent, id: frame.agentId, providerId, status: value, pendingInteractions: pendingInteractions(agentId), runtimeInfo: { ...replicaState.agent!.runtimeInfo, providerId, status: value, childSessions: setup?.children, sessionId: nativeFor(agentId), connection: { state: 'connected' } },
        } });
        const statuses = contentStatus.get(agentId) ?? new Set(); contentStatus.set(agentId, statuses); statuses.add(status); statusCallbacks.set(frame.subscriptionId, status);
        updates.push(update); updatesByAgent.set(agentId, (identity, connection) => { for (const callback of activeUpdates.get(agentId) ?? []) callback(identity, connection); });
        if (snapshotGate) await snapshotGate;
        update(agentId === 'agent-B' ? nativeIdentity ?? null : nativeFor(agentId), setup?.nativeConnection);
        if (accessGate) await accessGate;
        emit({ protocolVersion: PROTOCOL_VERSION, type: 'session_control', payload: { agentId: frame.agentId, revision: 'control', access: 'control', available: false, token: 'token' } });
      }
      if (frame.message?.type === 'session_control_request') {
        // The Relay answers a request for control at once; a test holds it to look at the page while control is being acquired.
        if (controlGate) await controlGate;
        emit({ protocolVersion: PROTOCOL_VERSION, type: 'session_control', payload: { agentId, requestId: frame.message.payload.requestId, revision: 'control', access: 'control', available: false, token: 'token' } });
      }
      if (['send_message', 'interaction_response'].includes(frame.message?.type)) emit({ protocolVersion: PROTOCOL_VERSION, type: 'command_acknowledged', payload: {
        agentId, requestId: frame.message.payload.submissionId ?? frame.message.payload.requestId, command: frame.message.type,
      } });
      if (frame.message?.type === 'resource_request') emit({ protocolVersion: PROTOCOL_VERSION, type: 'resource_response', payload: {
        agentId, requestId: frame.message.payload.requestId, resourceId: frame.message.payload.resourceId,
        state: { status: 'available', mediaType: 'image/png', byteLength: 68, sha256: 'fixture-image', imageDimensions: { width: 1, height: 1 }, contentBase64: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+j4AAAAABJRU5ErkJggg==' },
      } });
      if (frame.message?.type === 'timeline_subscription') emit({ protocolVersion: PROTOCOL_VERSION, type: 'timeline_subscribed', payload: { requestId: frame.message.payload.requestId, agentIds: [agentId] } });
      if (frame.message?.type === 'timeline_request' && timelineGate) await timelineGate;
      if (frame.message?.type === 'timeline_request') emit({ protocolVersion: PROTOCOL_VERSION, type: 'timeline_page', payload: {
        requestId: frame.message.payload.requestId, agentId, direction: frame.message.payload.direction, epoch: `epoch-${agentId}`, reset: false, staleCursor: false, gap: false, error: null,
        window: { minSeq: 0, maxSeq: setup?.timeline?.length ?? 0, nextSeq: (setup?.timeline?.length ?? 0) + 1 }, startCursor: null, endCursor: null, hasOlder: setup?.preserveNativeState === true && agentId === 'agent-A' && frame.message.payload.direction !== 'before', hasNewer: false,
        entries: (setup?.timeline ?? []).map(entry => agentId === 'agent-S' && entry.item.type === 'agent_communication' ? { ...entry, turnId: 'received-turn' } : entry),
      } });
    });
    socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'ready', successions: 1 }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const scope = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
  const transport = new HttpWebSocketTransport(scope, { WebSocket, sessionChannels: true, sessionSuccessions: true }) as LabTransport;
  cleanups.push(async () => { (transport as HttpWebSocketTransport).dispose(); for (const socket of sockets.clients) socket.terminate(); await new Promise<void>(resolve => sockets.close(() => resolve())); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const source = { hostId: 'host', providerId, nativeSessionId: 'A', agentId: 'agent-A', title: 'Retained primary' };
  localStorage.setItem(`agent-remote-opened:${scope}`, JSON.stringify([source]));
  const drafts = new DraftStore(scope); drafts.set(source.agentId, 'A local draft');
  await drafts.flushCurrent(source.agentId, drafts.snapshot(source.agentId).revision, () => true);
  await setup?.seed?.(scope, source);
  window.history.replaceState(null, '', `/?host=host&provider=${providerId}&session=${setup?.selected ?? 'A'}${flags}`);
  const app = <App baseUrl={scope} userScoped={setup?.userScoped} transport={transport} directory={new SessionDirectoryClient(scope, undefined, 'host')}
    hostService={setup?.hostService ?? { hosts: async () => ({ hosts: [{ id: 'host', name: 'Fixture Host', online: true, providers: [] }] }), pair: async () => { throw new Error('No pairing'); }, revoke: async () => {} }} />;
  let setAccessReady!: (ready: boolean) => void;
  function Access() {
    const [ready, setReady] = useState(true); setAccessReady = setReady;
    return <WorkspaceReady.Provider value={ready}>{app}</WorkspaceReady.Provider>;
  }
  let view = await render(strict ? <StrictMode><Access /></StrictMode> : <Access />);
  cleanups.push(() => unmount(view));
  return { scope, get view() { return view; }, requests, chain, frames, updates, updatesByAgent, sockets,
    async reload(selected?: string) { await unmount(view); if (selected) window.history.replaceState(null, '', `/?host=host&provider=${providerId}&session=${selected}`); view = await render(<Access />); },
    async newTab(selected: string, windowId?: string) { await unmount(view); sessionStorage.clear(); window.history.replaceState(null, '', `/?host=host&provider=${providerId}&session=${selected}${windowId ? `&window=${encodeURIComponent(windowId)}` : ''}`); view = await render(<Access />); },
    setAccessReady(ready: boolean) { setAccessReady(ready); },
    releaseTimeline() { releaseTimeline?.(); },
    releaseSnapshot() { releaseSnapshot?.(); },
    releaseAccess() { releaseAccess?.(); },
    setNativeIdentity(identity: string | null) { nativeIdentity = identity; },
    rebind(nativeSessionId: string, agentId: string) { nativeBindings.set(nativeSessionId, agentId); },
    setFavorites(snapshot: FavoritesSnapshot) { favorites = snapshot; },
    emitActivity(agentId: string, status: 'idle' | 'running' | 'waiting') {
      for (const update of activityUpdates.get(agentId) ?? []) update(status);
      if (setup?.liveActivity) for (const update of contentStatus.get(agentId) ?? []) update(status);
    },
    failReplay(code?: string) { replayFailure = code; },
    holdCreate() { createGate = new Promise(resolve => { releaseCreate = resolve; }); return () => { releaseCreate?.(); createGate = undefined; }; },
    holdRelations() { relationsGate ??= new Promise(resolve => { releaseRelations = resolve; }); return () => { releaseRelations?.(); relationsGate = undefined; }; },
    holdAttach(nativeSessionId: string) { let release!: () => void; attachmentGates.set(nativeSessionId, new Promise(resolve => { release = resolve; })); return () => { attachmentGates.delete(nativeSessionId); release(); }; },
    holdCurrent() { let release!: () => void; currentGate = new Promise(resolve => { release = resolve; }); return () => { currentGate = undefined; release(); }; },
    holdControl() { let release!: () => void; controlGate = new Promise(resolve => { release = resolve; }); return () => { controlGate = undefined; release(); }; },
    pauseReplay() { replayGate ??= new Promise(resolve => { releaseReplay = resolve; }); return () => { releaseReplay?.(); replayGate = undefined; }; },
    notify(replay: SessionSuccessionReplay) { for (const socket of sockets.clients) socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'session_succession_committed', succession: replay })); },
  };
}

/** Lets the App render and its requests finish, until the assertion holds. */
export async function settleApp(assertion: () => void, options?: { timeout?: number }) {
  await waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); assertion(); }, options);
}

export function successionHistoryLink(view: HTMLElement, nativeSessionId: string): HTMLAnchorElement {
  const link = [...view.querySelectorAll<HTMLAnchorElement>('.lab-succession-history a')]
    .find(link => !link.closest('[hidden]') && new URL(link.href).searchParams.get('session') === nativeSessionId);
  expect(link).toBeDefined(); return link!;
}

export function cachedConversation(nativeSessionId: string) {
  return { ...replicaState, agent: { ...replicaState.agent!, id: `agent-${nativeSessionId}`,
    runtimeInfo: { ...replicaState.agent!.runtimeInfo, sessionId: nativeSessionId } },
  timeline: { ...replicaState.timeline, entries: [{ providerId: 'recorded', seqStart: 1, seqEnd: 1, timestamp: 'now', turnId: `${nativeSessionId}-turn`,
    resources: [], collapsed: [], sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }],
    item: { type: 'assistant_message' as const, text: `Cached ${nativeSessionId} content` } }] } };
}

export function visibleQuery<T extends Element = Element>(view: HTMLElement, selector: string): T | null {
  return [...view.querySelectorAll<T>(selector)].find(element => !element.closest('[hidden]')) ?? null;
}

export function visibleText(view: HTMLElement): string {
  const copy = view.cloneNode(true) as HTMLElement;
  for (const hidden of copy.querySelectorAll('[hidden]')) hidden.remove();
  return copy.textContent ?? '';
}

export async function editVisiblePrompt(view: HTMLElement, text: string) {
  const editor = visibleQuery<HTMLElement>(view, '[data-testid="prompt-input"]')!;
  await act(async () => {
    if (editor instanceof HTMLTextAreaElement) Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(editor, text);
    else editor.textContent = text;
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

export async function setGlobalAskVisible(view: HTMLElement, visible: boolean) {
  const menu = view.querySelector<HTMLButtonElement>('[aria-label="View options"]')!;
  await act(async () => menu.click());
  await settleApp(() => expect(view.querySelector('[aria-label="Ask view"]'), view.textContent ?? '').not.toBeNull());
  const toggle = view.querySelector<HTMLInputElement>('[aria-label="Ask view"]')!;
  expect(toggle.disabled).toBe(false);
  if (toggle.checked !== visible) await act(async () => toggle.click());
  expect(toggle.checked).toBe(visible);
  await act(async () => menu.click());
}


export async function handoffCommandFixture(options: { nativeStatus?: 'idle' | 'running'; context?: 'history' | 'child' } = {}) {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.open = true; } });
  const real = workbenchComponents.LabWorkbench;
  let primary!: ComponentProps<typeof real>;
  vi.spyOn(workbenchComponents, 'LabWorkbench').mockImplementation(props => { if (props.state?.agent) primary = props; return real(props); });
  const ref = native('A', 'opencode');
  const description: SuccessionDescription = { role: { id: 'primary', revision: 1, origin: ref, current: ref,
    workspace: { controllerId: 'installation', canonicalCwd: '/fixture' } },
    targets: [{ providerId: 'opencode', displayName: 'OpenCode' }, { providerId: 'claude-code', displayName: 'Claude Code' }],
    eligibility: options.nativeStatus === 'running' ? { status: 'blocked', code: 'busy', reason: 'The source is still working.' } : { status: 'ready' } };
  const flags = options.context === 'history' ? '&intent=history' : options.context === 'child' ? '&parent=parent' : '';
  const f = await failureFixture(false, 'B', false, flags, { chain: [], providerId: 'opencode', userScoped: true,
    nativeStatus: options.nativeStatus, successionDescription: description,
    seed(scope, source) { if (options.context === 'child') localStorage.setItem(`agent-remote-opened:${scope}`, JSON.stringify([{ ...source, parentNativeSessionId: 'parent' }])); } });
  await settleApp(() => { expect(primary.state?.agent?.id).toBe('agent-A'); expect(primary.sessionStatus).toBe('ready'); });
  return { ...f, get primary() { return primary; } };
}

export async function windowHandoffFixture(placement: 'primary' | 'dock' | 'float' | 'attached', restriction?: 'history' | 'shared') {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.open = true; } });
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const real = workbenchComponents.LabWorkbench;
  let target!: ComponentProps<typeof real>;
  vi.spyOn(workbenchComponents, 'LabWorkbench').mockImplementation(props => {
    if (props.displayBinding?.key === 'target') target = props;
    return real(props);
  });
  const binding = (id: string) => ({ hostId: 'host', providerId: 'recorded', nativeSessionId: id, title: `Session ${id}` });
  const document: WorkspaceWindow = { schemaVersion: 3, id: 'handoff-views', title: 'Handoff views', revision: 0,
    selectedPrimaryViewId: placement === 'primary' ? 'target' : 'main', selectedViewId: 'target', views: [
      createWindowView('main', binding('A'), 'primary'),
      { ...createWindowView('target', { ...binding('X'), ...(restriction === 'history' ? { sessionIntent: 'history' as const } : {}) }, placement),
        ...(placement === 'attached' ? { attachedTo: 'main' } : {}) },
      createWindowView('duplicate', binding('X'), 'dock'),
      createWindowView('old-history', { ...binding('X'), sessionIntent: 'history' }, 'dock'),
    ] };
  const replay = committed('X', 'Y', 2, 'view-role');
  const description: SuccessionDescription = { role: { ...replay.projection.role, revision: 1, current: native('X') },
    targets: [{ providerId: 'recorded', displayName: 'Recorded' }], eligibility: { status: 'ready' } };
  const setup = { chain: [] as SessionSuccessionReplay[], userScoped: true, windowDocument: document, successionDescription: description,
    async successionPrepare(body: Record<string, unknown>): Promise<SuccessionActionResult> {
      replay.projection.receipt.operationId = String(body.operationId);
      replay.projection.receipt.prepared!.operationId = String(body.operationId);
      return { role: description.role, record: { ...replay.projection.receipt, phase: 'ready', committedRevision: undefined } };
    }, successionCommit(): SuccessionActionResult {
      setup.chain.push(replay);
      return { role: replay.projection.role, record: replay.projection.receipt, locator: replay.to };
    }, successionStatus(): SuccessionActionResult {
      return { role: replay.projection.role, record: replay.projection.receipt, locator: replay.to,
        context: { operationId: replay.projection.receipt.operationId, target: native('Y'), state: 'pending' } };
    }, ...(restriction === 'shared' ? { hostService: {
      hosts: async () => ({ hosts: [{ id: 'host', name: 'Shared Host', online: true, access: 'shared' as const, providers: [] }] }),
      pair: async () => { throw new Error('No pairing'); }, revoke: async () => {},
    } } : {}),
  };
  const f = await failureFixture(false, 'A', false, `&window=${document.id}`, setup);
  await settleApp(() => { expect(target?.sessionIdentity?.nativeSessionId).toBe('X'); expect(target.sessionStatus).toBe('ready'); });
  return { ...f, setup, get target() { return target; } };
}

export function expectDockedBeside(views: readonly WorkspaceWindow['views'][number][], empty: boolean) {
  const index = views.findIndex(view => view.binding?.nativeSessionId === 'D');
  expect(views[index]?.placement).toBe('dock');
  if (empty) { expect(views[index]?.id).toBe('ordinary-dock'); return; }
  expect(views[index]?.id).not.toBe('ordinary-dock');
  expect(views.find(view => view.id === 'ordinary-dock')?.binding?.nativeSessionId).toBe('X');
  expect(views[index - 1]?.id).toBe('ordinary-dock');
}
