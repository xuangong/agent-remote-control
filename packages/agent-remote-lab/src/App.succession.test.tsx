import 'fake-indexeddb/auto';
import { createServer, type Server } from 'node:http';
import { createHash, webcrypto } from 'node:crypto';
import { act, StrictMode, useContext, useState, type ComponentProps } from 'react';
import { WebSocket, WebSocketServer } from 'ws';
import { afterEach, expect, it, vi } from 'vitest';
import { PROTOCOL_VERSION, type AgentChildSession, type ProjectedTimelineEntry, type SessionSuccessionReplay, type Team } from '@orchardworks/agent-remote-protocol';
import { configureImageDraftPersistence, inspectImageDraft, readImageDraft, writeImageDraft } from '@orchardworks/agent-remote-web/browser';
import { HttpWebSocketTransport } from '@orchardworks/agent-remote-web';
import { CommunicationNavigationContext, type CommunicationNavigation } from '@orchardworks/agent-remote-web/react';
import { App, type LabTransport } from './App.js';
import { SessionDirectoryClient, type OpenedSession, type SuccessionActionResult, type SuccessionDescription } from './directory-client.js';
import { DraftStore } from './draft-store.js';
import { replicaState } from './test/fixtures.js';
import { readCompositionDocument, parseComposition, initializeCompositionDocument, saveCompositionDocument, createCompositionDocument, createCompositionSlot, createAskOwner } from './session-composition.js';
import { TrackedSessionViews } from './tracked-session-views.js';
import { flushRecoveryWrites } from './recovery-writes.js';
import { render, unmount } from './test/setup.js';
import * as trackingHooks from './hooks/useSessionTracking.js';
import * as askHooks from './hooks/useAskConversations.js';
import * as successionHooks from './hooks/useSessionSuccession.js';
import { ForkStore, referenceForkContext } from './session-forks.js';
import { sessionKey } from './session-tree.js';
import { readTrackedSessions, saveTrackedSessions } from './tracking-state.js';
import * as workbenchComponents from './components/LabWorkbench.js';
import * as forkActions from './fork-actions.js';
import { clearConversationRecovery } from './conversation-recovery.js';
import * as sessionCommunication from './session-communication.js';
import * as remoteReact from '@orchardworks/agent-remote-web/react';
import * as historyHooks from './hooks/useConversationHistory.js';
import { RecoveryScope, readLastSession, type ReadingPositions } from './conversation-recovery.js';
import { WorkspaceReady } from './workspace-access.js';
import * as starsHooks from './hooks/useSessionStars.js';
import * as attentionHooks from './hooks/useSessionAttention.js';
import type { FavoritesSnapshot } from './session-stars-client.js';
import * as managerComponents from './components/ChatSessionManager.js';
import { saveWorkspaceSnapshot } from './workspace-cache.js';

function saveSessionComposition(scope: string, value: { path: OpenedSession[]; focus?: string; anchor?: string; addressKey: string }) {
  sessionStorage.setItem(`agent-remote:recovery:${scope}:composition`, JSON.stringify(value));
}
const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => { for (const stop of cleanups.splice(0).reverse()) await stop(); localStorage.clear(); sessionStorage.clear(); configureImageDraftPersistence(() => true); vi.restoreAllMocks(); vi.unstubAllGlobals(); });
const native = (nativeSessionId: string, providerId = 'recorded') => ({ controllerId: 'installation', providerId, nativeSessionId });
function committed(from = 'A', to = 'B', revision = 2, roleId = 'primary', providerId = 'recorded'): SessionSuccessionReplay {
  const request = { operationId: `${roleId}-op-${revision}`, roleId, expectedRevision: revision - 1, from: native(from, providerId) };
  const workspace = { controllerId: 'installation', canonicalCwd: '/fixture' };
  return { version: 1, from: { hostId: 'host', providerId, nativeSessionId: from }, to: { hostId: 'host', providerId, nativeSessionId: to },
    projection: { version: 1, role: { id: roleId, revision, origin: native(roleId === 'primary' ? 'A' : 'X', providerId), current: native(to, providerId), workspace },
      receipt: { ...request, to: native(to, providerId), phase: 'committed', committedRevision: revision, startedAt: 'now', updatedAt: 'now',
        prepared: { ...request, to: native(to, providerId), workspace, associationRevision: 1, participants: [], capture: { epoch: 'epoch', seq: 1, capturedAt: 'now' } } } } };
}
async function failureFixture(advanceDuringRecovery = false, nativeIdentity?: string | null, strict = false, flags = '', setup?: { persistPrompt?: boolean; successionCommit?(): SuccessionActionResult; successionPrepare?(body: Record<string, unknown>): Promise<SuccessionActionResult>; teams?(): Team[]; chain?: SessionSuccessionReplay[]; replayFailure?: string; selected?: string; providerId?: string; userScoped?: boolean; favorites?: FavoritesSnapshot; holdRelationsInitially?: boolean; holdReplayInitially?: boolean; holdTimelineInitially?: boolean; holdSnapshotInitially?: boolean; holdAccessInitially?: boolean; nativeConnection?: 'connected' | 'restoring'; preserveNativeState?: boolean; children?: AgentChildSession[]; timeline?: ProjectedTimelineEntry[]; nativeStatus?: 'idle' | 'running'; successionDescription?: SuccessionDescription; successionStatus?(): SuccessionActionResult; attachmentFailure?(body: Record<string, unknown>): { status: number; payload: unknown } | undefined; seed?(scope: string, source: OpenedSession): void | Promise<void> }) {
  configureImageDraftPersistence(() => setup?.persistPrompt === true);
  const requests: Array<{ url: string; body?: Record<string, unknown> }> = [];
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
    if (url.pathname.includes('/session-successions') && replayGate) await replayGate;
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
  sockets.on('connection', socket => {
    const subscriptions = new Map<string, string>();
    const callbacks = new Map<string, (identity: string | null, connection?: 'connected' | 'restoring') => void>();
    const retire = (id: string) => { const callback = callbacks.get(id); if (callback) activeUpdates.get(subscriptions.get(id)!)?.delete(callback); callbacks.delete(id); subscriptions.delete(id); };
    socket.on('close', () => { for (const id of callbacks.keys()) retire(id); });
    socket.on('message', async data => {
      const frame = JSON.parse(String(data)); frames.push(frame);
      if (frame.type === 'unsubscribe') { retire(frame.subscriptionId); return; }
      if (frame.type === 'subscribe') subscriptions.set(frame.subscriptionId, frame.agentId);
      const agentId = subscriptions.get(frame.subscriptionId)!;
      const emit = (message: unknown) => socket.send(JSON.stringify({ protocolVersion: PROTOCOL_VERSION, type: 'message', subscriptionId: frame.subscriptionId, message }));
      if (frame.type === 'subscribe') {
        emit({ protocolVersion: PROTOCOL_VERSION, type: 'negotiated', sessionControl: true });
        const update = (identity: string | null, connection: 'connected' | 'restoring' = 'connected') => emit({ protocolVersion: PROTOCOL_VERSION, type: 'agent_snapshot', payload: {
          ...replicaState.agent, id: frame.agentId, providerId, status: setup?.nativeStatus ?? 'idle', pendingInteractions: pendingInteractions(agentId), runtimeInfo: { ...replicaState.agent!.runtimeInfo, providerId, status: setup?.nativeStatus ?? 'idle', childSessions: setup?.children, sessionId: identity, connection: { state: connection } },
        } });
        const active = activeUpdates.get(agentId) ?? new Set(); activeUpdates.set(agentId, active); active.add(update); callbacks.set(frame.subscriptionId, update);
        updates.push(update); updatesByAgent.set(agentId, (identity, connection) => { for (const callback of activeUpdates.get(agentId) ?? []) callback(identity, connection); });
        if (snapshotGate) await snapshotGate;
        update(agentId === 'agent-B' ? nativeIdentity ?? null : nativeFor(agentId), setup?.nativeConnection);
        if (accessGate) await accessGate;
        emit({ protocolVersion: PROTOCOL_VERSION, type: 'session_control', payload: { agentId: frame.agentId, revision: 'control', access: 'control', available: false, token: 'token' } });
      }
      if (frame.message?.type === 'session_control_request') {
        if (frame.message.payload.action === 'take_over') await controlGate;
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
    hostService={{ hosts: async () => ({ hosts: [{ id: 'host', name: 'Fixture Host', online: true, providers: [] }] }), pair: async () => { throw new Error('No pairing'); }, revoke: async () => {} }} />;
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

async function settleApp(assertion: () => void) {
  await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); assertion(); });
}

function successionHistoryLink(view: HTMLElement, nativeSessionId: string): HTMLAnchorElement {
  const link = [...view.querySelectorAll<HTMLAnchorElement>('.lab-succession-history a')]
    .find(link => new URL(link.href).searchParams.get('session') === nativeSessionId);
  expect(link).toBeDefined(); return link!;
}

function cachedConversation(nativeSessionId: string) {
  return { ...replicaState, agent: { ...replicaState.agent!, id: `agent-${nativeSessionId}`,
    runtimeInfo: { ...replicaState.agent!.runtimeInfo, sessionId: nativeSessionId } },
  timeline: { ...replicaState.timeline, entries: [{ providerId: 'recorded', seqStart: 1, seqEnd: 1, timestamp: 'now', turnId: `${nativeSessionId}-turn`,
    resources: [], collapsed: [], sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }],
    item: { type: 'assistant_message' as const, text: `Cached ${nativeSessionId} content` } }] } };
}

async function editVisiblePrompt(view: HTMLElement, text: string) {
  const editor = view.querySelector<HTMLElement>('[data-testid="prompt-input"]')!;
  await act(async () => {
    if (editor instanceof HTMLTextAreaElement) Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(editor, text);
    else editor.textContent = text;
    editor.dispatchEvent(new Event('input', { bubbles: true }));
  });
}

it.each(['recovering', 'attach-failed', 'identity-mismatch'] as const)('keeps sharing the selected session while %s', async phase => {
  const modal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.setAttribute('open', ''); } });
  cleanups.push(() => { if (modal) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', modal); else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal'); });
  const f = await failureFixture(false, 'wrong-native', false, '', {
    chain: [], selected: 'B', providerId: 'codex', holdReplayInitially: phase === 'recovering',
    attachmentFailure: phase === 'attach-failed' ? () => ({ status: 403, payload: { error: 'Session cannot be opened.' } }) : undefined,
  });
  if (phase !== 'recovering') await settleApp(() => expect(f.view.textContent).toContain(
    phase === 'attach-failed' ? 'Session cannot be opened.' : 'The native session identity could not be confirmed.',
  ));
  const share = f.view.querySelector<HTMLButtonElement>('[aria-label="Share session link"]');
  expect(share).not.toBeNull();
  expect(share!.disabled).toBe(false);
  await act(async () => share!.click());
  const dialog = document.querySelector<HTMLDialogElement>('dialog[aria-label="Share session"]')!;
  expect(dialog).not.toBeNull();
  const url = new URL(dialog.querySelector<HTMLInputElement>('#session-transfer-url')!.value);
  expect(url.searchParams.get('host')).toBe('host');
  expect(url.searchParams.get('provider')).toBe('codex');
  expect(url.searchParams.get('session')).toBe('B');
  expect(url.searchParams.has('agent')).toBe(false);
  expect(dialog.textContent).toContain('Resume locally');
});

it('retains a local resume command for a session that cannot be opened', async () => {
  const id = '01a0be55-d755-7d72-8463-5a04a193e20e';
  const modal = Object.getOwnPropertyDescriptor(HTMLDialogElement.prototype, 'showModal');
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() {} });
  cleanups.push(() => { if (modal) Object.defineProperty(HTMLDialogElement.prototype, 'showModal', modal); else Reflect.deleteProperty(HTMLDialogElement.prototype, 'showModal'); });
  const f = await failureFixture(false, undefined, false, '', {
    chain: [], selected: id, providerId: 'codex',
    attachmentFailure: () => ({ status: 403, payload: { error: 'Session cannot be opened.' } }),
  });
  await settleApp(() => expect(f.view.textContent).toContain('Session cannot be opened.'));
  await act(async () => f.view.querySelector<HTMLButtonElement>('[aria-label="Share session link"]')!.click());
  const command = document.querySelector<HTMLInputElement>('.lab-native-session-command input');
  expect(command?.value).toBe(`agent-remote-controller codex resume ${id}`);
});

it.each(['A', 'B'])('keeps native takeover visible from failed initial binding %s until explicit takeover is confirmed', async nativeSessionId => {
  const generation = 'native-owner-generation';
  const f = await failureFixture(false, nativeSessionId, false, '', { chain: nativeSessionId === 'A' ? [] : [committed()], attachmentFailure(body) {
    if (!body.takeOver) return { status: 409, payload: { code: 'native_session_owned',
      error: 'This session is controlled by another native client.', nativeOwner: { kind: 'native_cli', generation } } };
  } });
  const takeover = () => f.view.querySelector<HTMLButtonElement>('[aria-label="Interrupt and take control"]');
  await settleApp(() => expect(takeover()).not.toBeNull());
  expect(takeover()!.closest('[hidden]')).toBeNull();
  expect(f.view.textContent).toContain('Taking over interrupts its running work.');
  expect(f.view.textContent).not.toContain('This session is controlled by another native client.');
  expect(f.view.querySelector('[data-testid="prompt-submit"]')).toBeNull();
  expect(f.requests.filter(request => request.url.endsWith('/attach')).map(request => request.body?.takeOver)).toEqual([undefined]);
  const release = f.holdAttach(nativeSessionId), releaseControl = f.holdControl();
  try {
    await act(async () => takeover()!.click());
    await settleApp(() => expect(f.requests.filter(request => request.url.endsWith('/attach'))).toHaveLength(2));
    expect(f.view.querySelector('.lab-session-control')?.getAttribute('aria-busy')).toBe('true');
    expect(f.view.querySelector<HTMLButtonElement>('[aria-label="Taking control…"]')?.disabled).toBe(true);
    expect(f.requests.filter(request => request.url.endsWith('/attach'))[1]!.body).toMatchObject({ nativeSessionId, takeOver: generation });
    expect(f.frames.some(frame => frame.message?.type === 'send_message')).toBe(false);
    await act(async () => release());
    await settleApp(() => expect(f.frames.some(frame => frame.message?.type === 'session_control_request' && frame.message.payload?.action === 'take_over')).toBe(true));
    expect(f.view.querySelector<HTMLButtonElement>('[aria-label="Restoring session…"]')?.disabled).toBe(true);
    expect(f.view.querySelector('[data-testid="prompt-submit"]')).toBeNull();
    await act(async () => releaseControl());
    await settleApp(() => {
      expect(f.view.querySelector('.lab-session-control')).toBeNull();
      expect(f.view.querySelector('[data-testid="prompt-submit"]')).not.toBeNull();
    });
  } finally { release(); releaseControl(); }
});

it('retains an uncertain initial takeover and checks status without repeating the interruption', async () => {
  const generation = 'uncertain-native-owner';
  let interrupted = false;
  const f = await failureFixture(false, 'A', false, '', { chain: [], attachmentFailure(body) {
    if (body.takeOver) {
      interrupted = true;
      return { status: 409, payload: { code: 'native_handoff_unknown', error: 'Native release could not be confirmed.' } };
    }
    if (!interrupted) return { status: 409, payload: { code: 'native_session_owned', error: 'Native CLI has control.', nativeOwner: { kind: 'native_cli', generation } } };
  } });
  await settleApp(() => expect(f.view.querySelector('[aria-label="Interrupt and take control"]')).not.toBeNull());
  await act(async () => f.view.querySelector<HTMLButtonElement>('[aria-label="Interrupt and take control"]')!.click());
  await settleApp(() => expect(f.view.querySelector('[aria-label="Check session status"]')).not.toBeNull());
  expect(f.view.textContent).toContain('Native release could not be confirmed.');
  expect(f.view.querySelector('.lab-session-control-error')?.textContent).toContain('Handoff is not confirmed.');
  expect(f.view.querySelector('[data-testid="prompt-submit"]')).toBeNull();
  await act(async () => f.view.querySelector<HTMLButtonElement>('[aria-label="Check session status"]')!.click());
  await settleApp(() => {
    expect(f.view.querySelector('.lab-session-control')).toBeNull();
    expect(f.view.querySelector('[data-testid="prompt-submit"]')).not.toBeNull();
  });
  expect(f.requests.filter(request => request.url.endsWith('/attach')).map(request => request.body?.takeOver)).toEqual([undefined, generation, undefined]);
  expect(f.frames.some(frame => frame.message?.type === 'send_message')).toBe(false);
});

it('shows exact cached content while replay and native attachment wait without granting control', async () => {
  const real = successionHooks.useSessionSuccession;
  let succession!: ReturnType<typeof real>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  const f = await failureFixture(false, 'B', false, '', { holdReplayInitially: true, seed(scope) {
    for (const nativeSessionId of ['A', 'B']) saveWorkspaceSnapshot(scope, { hostId: 'host', providerId: 'recorded', nativeSessionId }, cachedConversation(nativeSessionId));
  } });
  const releaseReplay = f.pauseReplay(), releaseAttach = f.holdAttach('B');
  try {
    await settleApp(() => expect(f.view.textContent).toContain('Cached A content'));
    expect(succession.binding).toBeUndefined(); expect(succession.isCurrent()).toBe(false);
    expect(succession.sessionState.connection).toBe('connecting');
    expect(succession.sessionState.operations.send_message.allowed).toBe(false);
    expect(f.requests.some(request => request.url.endsWith('/attach'))).toBe(false);
    await act(async () => releaseReplay());
    await settleApp(() => { expect(succession.selected?.nativeSessionId).toBe('B'); expect(f.view.textContent).toContain('Cached B content'); });
    expect(f.view.textContent).not.toContain('Cached A content');
    expect(succession.binding).toBeUndefined();
    expect(f.frames.some(frame => frame.message?.type === 'send_message')).toBe(false);
    await act(async () => releaseAttach());
    await settleApp(() => { expect(succession.binding?.session.nativeSessionId).toBe('B'); expect(succession.sessionState.connection).toBe('ready'); });
    expect(f.requests.filter(request => request.url.endsWith('/attach')).every(request => request.body?.nativeSessionId === 'B')).toBe(true);
  } finally { releaseReplay(); releaseAttach(); }
});

it('retains edits made beside cached content before initial checks and native attachment finish', async () => {
  const real = successionHooks.useSessionSuccession, realWorkbench = workbenchComponents.LabWorkbench;
  let succession!: ReturnType<typeof real>, primary!: ComponentProps<typeof realWorkbench>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  vi.spyOn(workbenchComponents, 'LabWorkbench').mockImplementation(props => { primary = props; return realWorkbench(props); });
  const f = await failureFixture(false, 'B', false, '', { holdReplayInitially: true, seed(scope) {
    saveWorkspaceSnapshot(scope, { hostId: 'host', providerId: 'recorded', nativeSessionId: 'A' }, cachedConversation('A'));
  } });
  const releaseReplay = f.pauseReplay(), releaseAttach = f.holdAttach('B');
  try {
    await settleApp(() => expect(f.view.textContent).toContain('Cached A content'));
    const owner = primary.draftBinding;
    expect(owner).toBeDefined();
    expect(succession.binding).toBeUndefined();
    await editVisiblePrompt(f.view, 'Edited before checks completed');
    expect(owner!.store.get(owner!.key)).toBe('Edited before checks completed');
    expect(f.view.querySelector('[data-testid="prompt-input"]')?.textContent).toBe('Edited before checks completed');
    await act(async () => releaseReplay());
    await settleApp(() => expect(succession.selected?.nativeSessionId).toBe('B'));
    expect(primary.draftBinding).toEqual(owner);
    expect(f.view.querySelector('[data-testid="prompt-input"]')?.textContent).toBe('Edited before checks completed');
    await act(async () => releaseAttach());
    await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('B'));
    expect(primary.draftBinding).toEqual(owner);
    expect(f.view.querySelector('[data-testid="prompt-input"]')?.textContent).toBe('Edited before checks completed');
    expect(f.frames.filter(frame => frame.message?.type === 'send_message')).toEqual([]);
  } finally { releaseReplay(); releaseAttach(); }
});

it('retains the selected session draft while cached navigation waits for checks and binding', async () => {
  const real = successionHooks.useSessionSuccession, realWorkbench = workbenchComponents.LabWorkbench;
  let succession!: ReturnType<typeof real>, primary!: ComponentProps<typeof realWorkbench>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  vi.spyOn(workbenchComponents, 'LabWorkbench').mockImplementation(props => { primary = props; return realWorkbench(props); });
  const f = await failureFixture(false, 'B', false, '', { chain: [], seed(scope) {
    saveWorkspaceSnapshot(scope, { hostId: 'host', providerId: 'recorded', nativeSessionId: 'C' }, cachedConversation('C'));
  } });
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('A'));
  const releaseReplay = f.pauseReplay(), releaseAttach = f.holdAttach('C');
  try {
    await act(async () => { void succession.open({ hostId: 'host', providerId: 'recorded', nativeSessionId: 'C', title: 'C' }); });
    expect(f.view.textContent).toContain('Cached C content');
    const owner = primary.draftBinding;
    expect(owner).toBeDefined();
    await editVisiblePrompt(f.view, 'C edit before connection');
    expect(owner!.store.get(owner!.key)).toBe('C edit before connection');
    expect(f.view.querySelector('[data-testid="prompt-input"]')?.textContent).toBe('C edit before connection');
    await act(async () => releaseReplay());
    await settleApp(() => expect(succession.desired?.target.native.nativeSessionId).toBe('C'));
    expect(primary.draftBinding).toEqual(owner);
    await act(async () => releaseAttach());
    await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('C'));
    expect(primary.draftBinding).toEqual(owner);
    expect(f.view.querySelector('[data-testid="prompt-input"]')?.textContent).toBe('C edit before connection');
    expect(f.frames.filter(frame => frame.message?.type === 'send_message')).toEqual([]);
  } finally { releaseReplay(); releaseAttach(); }
});

it('changes cached content immediately on session selection and clears it for uncached targets', async () => {
  const real = successionHooks.useSessionSuccession;
  let succession!: ReturnType<typeof real>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  const f = await failureFixture(false, 'B', false, '', { chain: [], timeline: cachedConversation('A').timeline.entries, seed(scope) {
    saveWorkspaceSnapshot(scope, { hostId: 'host', providerId: 'recorded', nativeSessionId: 'C' }, cachedConversation('C'));
  } });
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('A'));
  const release = f.pauseReplay();
  let first!: Promise<boolean>, second!: Promise<boolean>;
  try {
    await act(async () => { first = succession.open({ hostId: 'host', providerId: 'recorded', nativeSessionId: 'C', title: 'C' }); });
    expect(f.view.textContent).toContain('Cached C content');
    expect(f.view.textContent).not.toContain('Cached A content');
    expect(succession.binding).toBeUndefined();
    await act(async () => { second = succession.open({ hostId: 'host', providerId: 'recorded', nativeSessionId: 'D', title: 'D' }); });
    expect(succession.selected?.nativeSessionId).toBe('D');
    expect(succession.state).toBeUndefined();
    expect(f.view.textContent).not.toContain('Cached C content');
    await act(async () => { release(); await Promise.all([first, second]); });
    await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('D'));
  } finally { release(); }
});

it('keeps already visible content during workspace access recovery with no usable native binding', async () => {
  const real = successionHooks.useSessionSuccession;
  let succession!: ReturnType<typeof real>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  const f = await failureFixture(false, 'B', false, '', { chain: [], timeline: cachedConversation('A').timeline.entries });
  await settleApp(() => { expect(succession.binding?.session.nativeSessionId).toBe('A'); expect(f.view.textContent).toContain('Cached A content'); });
  await act(async () => f.setAccessReady(false));
  expect(succession.binding).toBeUndefined(); expect(succession.isCurrent()).toBe(false);
  expect(f.view.textContent).toContain('Cached A content');
  expect(succession.sessionState.operations.send_message.allowed).toBe(false);
  const before = f.frames.filter(frame => frame.message?.type === 'send_message').length;
  await act(async () => f.setAccessReady(true));
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('A'));
  expect(f.frames.filter(frame => frame.message?.type === 'send_message')).toHaveLength(before);
});

it('opens predecessor A from current B, reloads its concrete history and returns to B without moving draft ownership', async () => {
  const real = successionHooks.useSessionSuccession;
  let succession!: ReturnType<typeof real>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  const f = await failureFixture(false, 'B');
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('B'));
  const currentSlot = succession.desired!.slot.id, owners = structuredClone(succession.desired!.slot.owners);
  const oldLink = successionHistoryLink(f.view, 'A');
  expect(new URL(oldLink.href).searchParams.get('intent')).toBe('history');
  expect(new URL(oldLink.href).searchParams.has('agent')).toBe(false);
  await act(async () => oldLink.click());
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('A'));
  expect(new URL(window.location.href).searchParams.get('intent')).toBe('history');
  expect(succession.desired!.slot.intent.kind).toBe('history');
  expect(succession.document.slots.find(slot => slot.id === currentSlot)?.owners).toEqual(owners);
  expect(f.view.querySelector('[data-testid="prompt-input"]')?.textContent).toBe('');
  await f.reload();
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('A'));
  const returnLink = successionHistoryLink(f.view, 'B');
  expect(returnLink.textContent).toBe('Return to current');
  expect(new URL(returnLink.href).searchParams.has('intent')).toBe(false);
  await act(async () => returnLink.click());
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('B'));
  expect(new URL(window.location.href).searchParams.has('intent')).toBe(false);
  expect(succession.desired!.slot.id).toBe(currentSlot);
  expect(succession.desired!.slot.owners).toEqual(owners);
  expect(f.view.querySelector('[data-testid="prompt-input"]')?.textContent).toBe('A local draft');
  expect(f.requests.some(request => request.url.endsWith('/create'))).toBe(false);
  expect(f.frames.some(frame => ['send_message', 'execute_command', 'image_upload_begin'].includes(frame.message?.type ?? ''))).toBe(false);
}, 10000);

it('shows A-B-C handoff history once in reverse order while ordinary A navigation still resolves current C', async () => {
  const real = successionHooks.useSessionSuccession, realHistory = historyHooks.useConversationHistory;
  let succession!: ReturnType<typeof real>, open!: Parameters<typeof realHistory>[2];
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  vi.spyOn(historyHooks, 'useConversationHistory').mockImplementation((...args) => { open = args[2]; return realHistory(...args); });
  const f = await failureFixture(false, 'B', false, '', { chain: [committed(), committed('B', 'C', 3)] });
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('C'));
  const nav = f.view.querySelector('.lab-succession-history')!;
  expect([...nav.querySelectorAll<HTMLAnchorElement>('a')].map(link => new URL(link.href).searchParams.get('session'))).toEqual(['B', 'A']);
  expect(nav.querySelector('details')?.open).toBe(false);
  expect(nav.querySelectorAll('a')).toHaveLength(2);
  await act(async () => successionHistoryLink(f.view, 'B').click());
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('B'));
  expect(new URL(window.location.href).searchParams.get('intent')).toBe('history');
  await act(async () => successionHistoryLink(f.view, 'C').click());
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('C'));
  await act(async () => f.view.querySelector<HTMLElement>('.lab-succession-history summary')!.click());
  expect(f.view.querySelector<HTMLDetailsElement>('.lab-succession-history details')?.open).toBe(true);
  await act(async () => successionHistoryLink(f.view, 'A').click());
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('A'));
  await f.reload();
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('A'));
  await act(async () => successionHistoryLink(f.view, 'C').click());
  await settleApp(() => expect(succession.binding?.session.nativeSessionId, succession.error).toBe('C'));
  await act(async () => { expect(await open({ hostId: 'host', providerId: 'recorded', nativeSessionId: 'A', title: 'Original A link' })).toBe(true); });
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('C'));
  expect(new URL(window.location.href).searchParams.get('session')).toBe('C');
  expect(new URL(window.location.href).searchParams.has('intent')).toBe(false);
  expect(f.frames.some(frame => ['send_message', 'execute_command', 'image_upload_begin'].includes(frame.message?.type ?? ''))).toBe(false);
}, 10000);

it('removes handoff navigation when fresh authorized replay is denied', async () => {
  const real = successionHooks.useSessionSuccession;
  let succession!: ReturnType<typeof real>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  const f = await failureFixture(false, 'B');
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('B'));
  successionHistoryLink(f.view, 'A');
  f.failReplay('succession_not_found');
  await act(async () => { await succession.refresh(); });
  expect(succession.historyNavigation).toBeUndefined();
  expect(f.view.querySelector('.lab-succession-history')).toBeNull();
}, 10000);

it('waits for the selected native successor before reporting a committed refresh complete', async () => {
  const real = successionHooks.useSessionSuccession;
  let succession!: ReturnType<typeof real>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  const f = await failureFixture(false, 'B', false, '', { chain: [] });
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('A'));
  const replay = committed(); f.chain.push(replay);
  const release = f.holdAttach('B');
  let outcome = 'pending', failure: unknown, pending!: Promise<void>;
  try {
    await act(async () => { pending = succession.refreshCommitted(replay.projection.receipt.operationId).then(() => { outcome = 'confirmed'; }, error => { outcome = 'failed'; failure = error; }); });
    await settleApp(() => expect(f.requests.some(request => request.url.endsWith('/attach') && request.body?.nativeSessionId === 'B')).toBe(true));
    expect(outcome).toBe('pending');
    await act(async () => release());
    await settleApp(() => expect(outcome).toBe('confirmed'));
    await pending;
    expect(failure).toBeUndefined(); expect(succession.binding?.session.nativeSessionId).toBe('B');
  } finally { release(); }
}, 10000);

it('finishes committed recovery when an earlier native attachment synchronizes during replay', async () => {
  const real = successionHooks.useSessionSuccession;
  let succession!: ReturnType<typeof real>;
  let options!: Parameters<typeof real>[0];
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { options = args[0]; succession = real(...args); return succession; });
  const f = await failureFixture(false, 'B');
  const releaseAttach = f.holdAttach('B');
  let releaseCurrent = () => {};
  try {
    await settleApp(() => expect(f.requests.some(request => request.url.endsWith('/attach') && request.body?.nativeSessionId === 'B')).toBe(true));
    releaseCurrent = f.holdCurrent();
    const currentRequests = f.requests.filter(request => request.url.includes('/session-successions/current')).length;
    let outcome = 'pending', failure: unknown;
    await act(async () => { void succession.refreshCommitted('primary-op-2').then(() => { outcome = 'confirmed'; }, error => { outcome = 'failed'; failure = error; }); });
    await settleApp(() => expect(f.requests.filter(request => request.url.includes('/session-successions/current')).length).toBeGreaterThan(currentRequests));
    await act(async () => releaseAttach());
    await settleApp(() => {
      const connection = options.connections.find({ hostId: 'host', providerId: 'recorded', nativeSessionId: 'B' });
      expect(connection?.replica.getState().timeline.initialized).toBe(true);
      expect(connection?.client.getSessionState().synchronized).toBe(true);
    });
    await act(async () => releaseCurrent());
    await settleApp(() => { expect(failure).toBeUndefined(); expect(outcome).toBe('confirmed'); });
    expect(succession.error).toBeUndefined(); expect(succession.binding?.session.nativeSessionId).toBe('B');
    expect(succession.document.roles[0]?.appliedRevision).toBe(2);
    expect(f.requests.filter(request => request.url.endsWith('/attach') && request.body?.nativeSessionId === 'B')).toHaveLength(1);
  } finally { releaseAttach(); releaseCurrent(); }
}, 10000);

it.each(['cancelled', 'rejected'] as const)('waits for the original native session to recover after a %s handoff', async phase => {
  const real = successionHooks.useSessionSuccession;
  let succession!: ReturnType<typeof real>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  const f = await failureFixture(false, 'B', false, '', { chain: [] });
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('A'));
  const binding = succession.binding!;
  const source = binding.session;
  const result: SuccessionActionResult = { role: { id: 'primary', revision: 1, origin: native('A'), current: native('A'),
    workspace: { controllerId: 'installation', canonicalCwd: '/fixture' } },
    record: { operationId: 'cancelled-op', roleId: 'primary', expectedRevision: 1, from: native('A'), phase, startedAt: 'now', updatedAt: 'now' } };
  await act(async () => f.updatesByAgent.get('agent-A')!('A', 'restoring'));
  await settleApp(() => expect(binding.client.getSessionState().recovering).toBe(true));
  let outcome = 'pending', failure: unknown;
  await act(async () => { void succession.refreshSettled(result, source).then(() => { outcome = 'confirmed'; }, error => { outcome = 'failed'; failure = error; }); });
  await settleApp(() => expect(succession.discovering).toBe(false));
  expect(outcome).toBe('pending');
  expect(succession.binding?.client).toBe(binding.client);
  await act(async () => f.updatesByAgent.get('agent-A')!('A', 'connected'));
  await settleApp(() => { expect(failure).toBeUndefined(); expect(outcome).toBe('confirmed'); });
  expect(f.requests.filter(request => request.url.endsWith('/attach') && request.body?.nativeSessionId === 'A')).toHaveLength(1);
  expect(f.frames.some(frame => ['send_message', 'execute_command'].includes(frame.message?.type ?? ''))).toBe(false);
}, 10000);

it('does not complete a committed refresh while its previously confirmed native session is restoring', async () => {
  const real = successionHooks.useSessionSuccession;
  let succession!: ReturnType<typeof real>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  const f = await failureFixture(false, 'B');
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('B'));
  const binding = succession.binding!;
  await act(async () => f.updatesByAgent.get('agent-B')!('B', 'restoring'));
  await settleApp(() => expect(binding.client.getSessionState().recovering).toBe(true));
  let outcome = 'pending', failure: unknown;
  await act(async () => { void succession.refreshCommitted('primary-op-2').then(() => { outcome = 'confirmed'; }, error => { outcome = 'failed'; failure = error; }); });
  await settleApp(() => expect(succession.discovering).toBe(false));
  expect(outcome).toBe('pending');
  await act(async () => f.updatesByAgent.get('agent-B')!('B', 'connected'));
  await settleApp(() => { expect(failure).toBeUndefined(); expect(outcome).toBe('confirmed'); });
  expect(succession.binding?.client).toBe(binding.client);
}, 10000);

it('allows a manual refresh to confirm the retained source after a native restoration deadline', async () => {
  const real = successionHooks.useSessionSuccession;
  let succession!: ReturnType<typeof real>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  const f = await failureFixture(false, 'B', false, '', { chain: [] });
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('A'));
  const binding = succession.binding!, source = binding.session;
  const result: SuccessionActionResult = { role: { id: 'primary', revision: 1, origin: native('A'), current: native('A'),
    workspace: { controllerId: 'installation', canonicalCwd: '/fixture' } },
    record: { operationId: 'cancelled-op', roleId: 'primary', expectedRevision: 1, from: native('A'), phase: 'cancelled', startedAt: 'now', updatedAt: 'now' } };
  await act(async () => f.updatesByAgent.get('agent-A')!('A', 'restoring'));
  await settleApp(() => expect(binding.client.getSessionState().recovering).toBe(true));
  const timeout = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation(((callback: TimerHandler, delay?: number, ...args: unknown[]) =>
    timeout(callback, delay === 16000 ? 100 : delay, ...args)) as typeof setTimeout);
  let outcome = 'pending', failure: unknown;
  await act(async () => { void succession.refreshSettled(result, source).then(() => { outcome = 'confirmed'; }, error => { outcome = 'failed'; failure = error; }); });
  await settleApp(() => expect(outcome).toBe('failed'));
  expect(failure).toBeInstanceOf(Error);
  expect((failure as Error).message).toContain('Retry the session connection');
  expect(succession.binding?.client).toBe(binding.client);
  await act(async () => f.updatesByAgent.get('agent-A')!('A', 'connected'));
  await settleApp(() => expect(binding.client.getSessionState().recovering).toBe(false));
  await act(async () => { await succession.refreshSettled(result, source); });
  expect(succession.binding?.client).toBe(binding.client);
  expect(f.requests.filter(request => request.url.endsWith('/attach') && request.body?.nativeSessionId === 'A')).toHaveLength(1);
  expect(f.requests.some(request => /succession\/(prepare|commit)/.test(request.url))).toBe(false);
}, 10000);

it('retries a failed metadata refresh without retaining its old error on a healthy native binding', async () => {
  const real = successionHooks.useSessionSuccession;
  let succession!: ReturnType<typeof real>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  const f = await failureFixture(false, 'B');
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('B'));
  const binding = succession.binding!;
  f.failReplay('temporary_failure');
  await act(async () => { await expect(succession.refreshCommitted('primary-op-2')).rejects.toThrow('Fixture succession route unavailable'); });
  f.failReplay();
  await act(async () => { await expect(succession.refreshCommitted('primary-op-2')).resolves.toBeUndefined(); });
  expect(succession.error).toBeUndefined();
  expect(succession.binding?.client).toBe(binding.client);
  expect(f.requests.filter(request => request.url.endsWith('/attach') && request.body?.nativeSessionId === 'B')).toHaveLength(1);
}, 10000);

it.each(['denied', 'missing-operation', 'native-unavailable'] as const)('rejects a committed refresh with %s evidence instead of reporting success', async reason => {
  const real = successionHooks.useSessionSuccession;
  let succession!: ReturnType<typeof real>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  const f = await failureFixture(false, reason === 'native-unavailable' ? undefined : 'B');
  await settleApp(() => reason === 'native-unavailable' ? expect(succession.error).toBe('Fixture successor unavailable.') : expect(succession.binding?.session.nativeSessionId).toBe('B'));
  if (reason === 'denied') f.failReplay('succession_not_found');
  await act(async () => { await expect(succession.refreshCommitted(reason === 'missing-operation' ? 'missing-operation' : 'primary-op-2')).rejects.toThrow(); });
}, 10000);

it('confirms an older committed operation after C while leaving an unrelated selected session alone', async () => {
  const real = successionHooks.useSessionSuccession;
  let succession!: ReturnType<typeof real>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  const f = await failureFixture(false, 'B', false, '', { chain: [committed(), committed('B', 'C', 3)] });
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('C'));
  await act(async () => { await succession.open({ hostId: 'host', providerId: 'recorded', nativeSessionId: 'D', title: 'Independent D' }); });
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('D'));
  await act(async () => { await succession.refreshCommitted('primary-op-2'); });
  expect(succession.binding?.session.nativeSessionId).toBe('D');
  expect(succession.document.roles[0]?.appliedRevision).toBe(3);
  expect(new URL(window.location.href).searchParams.get('session')).toBe('D');
  expect(f.frames.some(frame => ['send_message', 'execute_command'].includes(frame.message?.type ?? ''))).toBe(false);
}, 10000);

it('does not verify another role operation through the current historical role evidence', async () => {
  const real = successionHooks.useSessionSuccession;
  let succession!: ReturnType<typeof real>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  const f = await failureFixture(false, 'B', false, '', { chain: [committed(), committed('X', 'Y', 2, 'side')] });
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('B'));
  await act(async () => successionHistoryLink(f.view, 'A').click());
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('A'));
  await act(async () => { await expect(succession.refreshCommitted('side-op-2')).rejects.toThrow(); });
  expect(succession.binding?.session.nativeSessionId).toBe('A');
}, 10000);

async function handoffCommandFixture(options: { nativeStatus?: 'idle' | 'running'; context?: 'history' | 'child' } = {}) {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value() { this.open = true; } });
  const real = workbenchComponents.LabWorkbench;
  let primary!: ComponentProps<typeof real>;
  vi.spyOn(workbenchComponents, 'LabWorkbench').mockImplementation(props => { primary = props; return real(props); });
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

it('opens the Handoff chooser from its command, resolves claude and sends no native input', async () => {
  const f = await handoffCommandFixture();
  expect(f.primary.consoleCommands?.some(command => command.id === 'console:handoff')).toBe(true);
  await act(async () => { await f.primary.onExecuteConsoleCommand!('console:handoff', 'claude'); });
  await settleApp(() => expect(document.querySelector<HTMLSelectElement>('dialog [aria-label="Successor provider"]')?.value).toBe('claude-code'));
  expect(document.querySelector<HTMLButtonElement>('dialog button[type="submit"]')?.disabled).toBe(false);
  expect(f.requests.find(request => request.url.endsWith('/succession/describe'))?.body).toEqual({ providerId: 'opencode', nativeSessionId: 'A' });
  expect(f.requests.some(request => request.url.endsWith('/succession/prepare') || request.url.endsWith('/create'))).toBe(false);
  expect(f.frames.some(frame => ['send_message', 'execute_command'].includes(frame.message?.type ?? ''))).toBe(false);
  expect(new DraftStore(f.scope).get('agent-A')).toBe('A local draft');
}, 10000);

it.each(['claude extra', 'claude;codex'])('rejects malformed Handoff provider arguments %s before choosing or sending', async args => {
  const f = await handoffCommandFixture();
  await act(async () => { await expect(f.primary.onExecuteConsoleCommand!('console:handoff', args)).rejects.toThrow(); });
  expect(document.querySelector('dialog')).toBeNull();
  expect(f.requests.some(request => request.url.endsWith('/succession/describe'))).toBe(false);
  expect(f.frames.some(frame => ['send_message', 'execute_command'].includes(frame.message?.type ?? ''))).toBe(false);
}, 10000);

it('does not silently replace an unavailable requested Handoff provider', async () => {
  const f = await handoffCommandFixture();
  let failure: unknown;
  await act(async () => { try { await f.primary.onExecuteConsoleCommand!('console:handoff', 'missing-provider'); } catch (error) { failure = error; } });
  if (failure) expect(document.querySelector('dialog')).toBeNull();
  else {
    await settleApp(() => expect(document.querySelector<HTMLSelectElement>('dialog [aria-label="Successor provider"]')?.value).toBe(''));
    expect(document.querySelector<HTMLButtonElement>('dialog button[type="submit"]')?.disabled).toBe(true);
    expect(document.querySelector('dialog')?.textContent).toContain('missing-provider');
  }
  expect(f.requests.some(request => request.url.endsWith('/succession/prepare'))).toBe(false);
  expect(f.frames.some(frame => ['send_message', 'execute_command'].includes(frame.message?.type ?? ''))).toBe(false);
}, 10000);

it('opens Handoff while the native session is working and respects the Host blocked eligibility', async () => {
  const f = await handoffCommandFixture({ nativeStatus: 'running' });
  expect(f.primary.state?.agent?.status).toBe('running');
  expect(f.primary.consoleCommands?.some(command => command.id === 'console:handoff')).toBe(true);
  await act(async () => { await f.primary.onExecuteConsoleCommand!('console:handoff', ''); });
  await settleApp(() => expect(document.querySelector('dialog')?.textContent).toContain('The source is still working.'));
  expect(document.querySelector<HTMLButtonElement>('dialog button[type="submit"]')?.disabled).toBe(true);
  expect(f.requests.some(request => request.url.endsWith('/succession/prepare'))).toBe(false);
  expect(f.frames.some(frame => ['send_message', 'execute_command'].includes(frame.message?.type ?? ''))).toBe(false);
}, 10000);

it('keeps the Handoff chooser available while pending input blocks preparation and recovers when cleared', async () => {
  const f = await handoffCommandFixture();
  await act(async () => f.primary.onPendingInputChange!(2));
  await act(async () => { await f.primary.onExecuteConsoleCommand!('console:handoff', ''); });
  await settleApp(() => expect(document.querySelector<HTMLSelectElement>('dialog [aria-label="Successor provider"]')?.value).toBe('opencode'));
  const submit = () => document.querySelector<HTMLButtonElement>('dialog button[type="submit"]')!;
  expect(document.querySelector('dialog')?.textContent).toContain('Send or remove pending messages before handing off this conversation.');
  expect(submit().disabled).toBe(true);
  await act(async () => document.querySelector('dialog form')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true })));
  expect(f.requests.some(request => request.url.endsWith('/succession/prepare'))).toBe(false);
  await act(async () => f.primary.onPendingInputChange!(0));
  expect(submit().disabled).toBe(false);
  await act(async () => f.primary.onPendingInputChange!(1));
  expect(submit().disabled).toBe(true);
  await act(async () => f.primary.onPendingInputChange!(0));
  expect(submit().disabled).toBe(false);
  expect(f.requests.some(request => request.url.endsWith('/succession/prepare'))).toBe(false);
  expect(f.frames.some(frame => ['send_message', 'execute_command'].includes(frame.message?.type ?? ''))).toBe(false);
  expect(new DraftStore(f.scope).get('agent-A')).toBe('A local draft');
}, 10000);

it('refreshes successor context after Composer delivery without waiting for a native timeline echo', async () => {
  vi.stubGlobal('crypto', webcrypto);
  const real = workbenchComponents.LabWorkbench;
  let primary!: ComponentProps<typeof real>, reads = 0;
  const pendingCounts: number[] = [];
  vi.spyOn(workbenchComponents, 'LabWorkbench').mockImplementation(props => { primary = props; return real({ ...props,
    onPendingInputChange: count => { pendingCounts.push(count); props.onPendingInputChange?.(count); },
  }); });
  const replay = committed();
  let contextState: 'pending' | 'materialized' = 'pending';
  const f = await failureFixture(false, 'B', false, '', { userScoped: true, successionStatus: () => {
    reads++;
    return { record: replay.projection.receipt, role: replay.projection.role,
      context: { operationId: replay.projection.receipt.operationId, target: native('B'), state: contextState } };
  } });
  await settleApp(() => { expect(primary.state?.agent?.id).toBe('agent-B'); expect(primary.pendingFirstInputContext?.state).toBe('pending'); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 2200)); });
  const observed = reads, timeline = structuredClone(primary.state!.timeline);
  contextState = 'materialized';
  expect(f.view.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!.disabled).toBe(false);
  await act(async () => {
    const button = f.view.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!;
    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); button.click();
  });
  expect([...f.view.querySelectorAll('.agent-composer [role="alert"]')].map(item => item.textContent)).toEqual([]);
  await settleApp(() => expect(f.frames.filter(frame => frame.message?.type === 'send_message')).toHaveLength(1));
  expect(pendingCounts).toContain(1);
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 2200)); });
  expect(primary.pendingFirstInputContext).toBeUndefined();
  expect(reads).toBeGreaterThan(observed);
  expect(primary.state!.timeline).toEqual(timeline);
  expect(f.requests.filter(request => request.url.endsWith('/succession/status')).every(request => request.body?.includeContext === true)).toBe(true);
}, 10000);

it.each(['history', 'child'] as const)('does not expose or execute Handoff from the %s native view', async context => {
  const f = await handoffCommandFixture({ context });
  expect(f.primary.consoleCommands?.some(command => command.id === 'console:handoff')).toBe(false);
  await act(async () => { await expect(f.primary.onExecuteConsoleCommand!('console:handoff', '')).rejects.toThrow(); });
  expect(document.querySelector('dialog')).toBeNull();
  expect(f.requests.some(request => request.url.endsWith('/succession/describe') || request.url.endsWith('/succession/prepare'))).toBe(false);
  expect(f.frames.some(frame => ['send_message', 'execute_command'].includes(frame.message?.type ?? ''))).toBe(false);
}, 10000);

it('old desktop A notification still opens concrete A history after B and C confirmation', async () => {
  const notices: Array<{ title: string; options: NotificationOptions; onclick?: () => void; close: ReturnType<typeof vi.fn> }> = [];
  vi.stubGlobal('crypto', webcrypto);
  vi.stubGlobal('Notification', class {
    static permission = 'granted';
    close = vi.fn();
    constructor(readonly title: string, readonly options: NotificationOptions) { notices.push(this); }
  });
  const focus = vi.spyOn(window, 'focus').mockImplementation(() => {});
  const realAttention = attentionHooks.useSessionAttention, realSuccession = successionHooks.useSessionSuccession;
  const realWorkbench = workbenchComponents.LabWorkbench;
  let attention!: ReturnType<typeof realAttention>, succession!: ReturnType<typeof realSuccession>, primary!: ComponentProps<typeof realWorkbench>;
  const opened: unknown[] = [];
  vi.spyOn(attentionHooks, 'useSessionAttention').mockImplementation((scope, active, open) => {
    attention = realAttention(scope, active, session => { opened.push(structuredClone(session)); open(session); }); return attention;
  });
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = realSuccession(...args); return succession; });
  vi.spyOn(workbenchComponents, 'LabWorkbench').mockImplementation(props => { primary = props; return realWorkbench(props); });
  let source!: OpenedSession;
  const entry: ProjectedTimelineEntry = { providerId: 'recorded', seqStart: 1, seqEnd: 1, timestamp: 'now', turnId: 'A-turn', resources: [], collapsed: [], sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }],
    item: { type: 'assistant_message', text: 'Original A completion' } };
  const f = await failureFixture(false, 'B', false, '', { chain: [], userScoped: true, timeline: [entry], seed(_scope, original) { source = original; } });
  await settleApp(() => { expect(primary.state?.agent?.id).toBe('agent-A'); expect(primary.state?.timeline.initialized).toBe(true); expect(attention.enabled).toBe(true); });
  const locator = structuredClone(source), cursor = { epoch: 'epoch-agent-A', seq: 1 };
  await act(async () => {
    await attention.notifier.observe(source, { connection: 'ready', activity: 'running', cursor: { ...cursor, seq: 0 } });
    await attention.notifier.observe(source, { connection: 'ready', activity: 'idle', cursor });
  });
  expect(notices).toHaveLength(1);
  const original = notices[0]!, receipt = createHash('sha256').update(JSON.stringify([f.scope, sessionKey(locator), 'idle', cursor])).digest('hex');
  expect(original.options.tag).toBe(`arc:${receipt}`);
  expect(JSON.parse(localStorage.getItem('agent-remote:notification-receipts')!)).toEqual([receipt]);
  const receipts = localStorage.getItem('agent-remote:notification-receipts');
  for (const replay of [committed(), committed('B', 'C', 3)]) {
    f.chain.push(replay); await act(async () => f.notify(replay));
    await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe(replay.to.nativeSessionId));
  }
  const beforeClick = f.requests.length;
  await act(async () => original.onclick!());
  await settleApp(() => { expect(primary.state?.agent?.id).toBe('agent-A'); expect(primary.state?.timeline.initialized).toBe(true); });
  expect(opened).toEqual([locator]);
  expect(source).toEqual(locator);
  expect(original.options.tag).toBe(`arc:${receipt}`);
  expect(localStorage.getItem('agent-remote:notification-receipts')).toBe(receipts);
  expect(notices[0]).toBe(original);
  expect(original.close).toHaveBeenCalledOnce(); expect(focus).toHaveBeenCalledOnce();
  expect(new URL(window.location.href).searchParams.get('session')).toBe('A');
  expect(new URL(window.location.href).searchParams.get('intent')).toBe('history');
  expect(succession.desired?.slot.intent).toMatchObject({ kind: 'history', target: { native: { providerId: 'recorded', nativeSessionId: 'A' } } });
  expect(succession.desired?.slot.owners.text.key).toMatch(/^view:/);
  expect(f.view.textContent).toContain('Original A completion');
  expect(f.view.querySelector('[data-testid="prompt-input"]')?.textContent).toBe('');
  expect(f.requests.slice(beforeClick).filter(item => item.url.endsWith('/attach')).map(item => item.body?.nativeSessionId)).toEqual(['A']);
  expect(f.frames.some(frame => ['send_message', 'execute_command', 'image_upload_begin'].includes(frame.message?.type ?? ''))).toBe(false);
});

it.each([false, true])('first complete A-B-C discovery retains the origin owners with independent B=%s', async independentB => {
  const real = successionHooks.useSessionSuccession;
  let succession!: ReturnType<typeof real>, source!: OpenedSession, independent!: OpenedSession;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  const f = await failureFixture(false, 'B', false, '', { chain: [committed(), committed('B', 'C', 3)], async seed(scope, original) {
    source = original; independent = { ...original, nativeSessionId: 'B', agentId: 'agent-B', title: 'Independent B' };
    localStorage.setItem(`agent-remote-opened:${scope}`, JSON.stringify(independentB ? [source, independent] : [source]));
    const drafts = new DraftStore(scope); drafts.set(independent.agentId, 'Independent B draft'); drafts.flush();
    await writeImageDraft({ version: 1, scope, key: JSON.stringify([scope, sessionKey(source)]),
      parts: [{ type: 'text', text: 'A local draft' }, { type: 'image', imageId: 'origin-image', label: 'Origin image' }],
      images: { 'origin-image': { imageId: 'origin-image', blob: new Blob(['Origin image bytes'], { type: 'image/png' }), uploadId: 'origin-upload', status: 'pending', progress: 0 } }, nextLabel: 2 });
  } });
  await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); expect(succession.desired?.slot.owners.text.key).toBe('agent-A'); });
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('C'));
  expect(succession.result?.status).toBe('applied');
  expect(f.view.querySelector('[data-testid="prompt-input"]')?.textContent).toContain('A local draft');
  expect(succession.desired?.slot.owners).toEqual({ text: { scope: f.scope, key: 'agent-A' },
    image: { scope: f.scope, key: JSON.stringify([f.scope, sessionKey(source)]) }, display: { scope: f.scope, key: sessionKey(source) } });
  const image = (await readImageDraft(succession.desired!.slot.owners.image.key))?.images['origin-image'];
  expect(image?.blob && await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsText(image.blob!); })).toBe('Origin image bytes');
  if (independentB) {
    const slot = succession.document.slots.find(slot => slot.owners.text.key === independent.agentId)!;
    expect(slot.intent).toMatchObject({ kind: 'fixed', target: { native: { nativeSessionId: 'B' } } });
    expect(slot.id).not.toBe(succession.desired!.slot.id);
    expect(new DraftStore(f.scope).get(independent.agentId)).toBe('Independent B draft');
    expect(succession.document.retained).toContainEqual({ slot: slot.id, against: succession.desired!.slot.id });
  }
  expect(f.requests.filter(item => item.url.endsWith('/attach')).map(item => item.body?.nativeSessionId)).toEqual(['C']);
  expect(f.frames.filter(frame => frame.message && ['send_message', 'execute_command', 'image_upload_begin'].includes(frame.message.type))).toEqual([]);
});

it.each(['confirmed', 'failed'] as const)('reopening current B preserves its %s outcome until explicit Retry', async outcome => {
  const real = successionHooks.useSessionSuccession, realHistory = historyHooks.useConversationHistory;
  let succession!: ReturnType<typeof real>, open!: Parameters<typeof realHistory>[2];
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  vi.spyOn(historyHooks, 'useConversationHistory').mockImplementation((...args) => { open = args[2]; return realHistory(...args); });
  const f = await failureFixture(false, outcome === 'confirmed' ? 'B' : undefined);
  await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
    if (outcome === 'confirmed') expect(succession.binding?.session.nativeSessionId).toBe('B');
    else expect(succession.error).toBe('Fixture successor unavailable.');
  });
  const editor = f.view.querySelector('[data-testid="prompt-input"]'), owners = structuredClone(succession.desired!.slot.owners), binding = succession.binding;
  await act(async () => { expect(await open({ hostId: 'host', providerId: 'recorded', nativeSessionId: 'B', title: 'Current B' })).toBe(true); });
  if (outcome === 'confirmed') { expect(succession.binding).toBe(binding); expect(succession.isCurrent()).toBe(true); }
  else {
    expect(succession.error).toBe('Fixture successor unavailable.');
    expect([...f.view.querySelectorAll('button')].some(button => button.textContent === 'Retry session')).toBe(true);
  }
  for (const keepOriginal of [true, false]) {
    await act(async () => { expect(await open({ hostId: 'host', providerId: 'recorded', nativeSessionId: 'B', title: 'Current B' }, undefined, keepOriginal)).toBe(true); });
    expect(succession.desired?.keepOriginal).toBe(keepOriginal);
    if (outcome === 'confirmed') expect(succession.binding).toBe(binding);
    else expect(succession.error).toBe('Fixture successor unavailable.');
  }
  expect(succession.desired!.slot.owners).toEqual(owners);
  expect(f.view.querySelector('[data-testid="prompt-input"]')).toBe(editor);
  expect(editor?.textContent).toBe('A local draft');
  expect(f.requests.filter(item => item.url.endsWith('/attach')).map(item => item.body?.nativeSessionId)).toEqual(['B']);
  if (outcome === 'failed') {
    f.setNativeIdentity('B');
    await act(async () => [...f.view.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Retry session')!.click());
    await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('B'));
    expect(f.requests.filter(item => item.url.endsWith('/attach')).map(item => item.body?.nativeSessionId)).toEqual(['B', 'B']);
  }
  expect(f.frames.filter(frame => frame.message && ['send_message', 'execute_command', 'image_upload_begin'].includes(frame.message.type))).toEqual([]);
});

it('access suspension keeps hot B ownership and resumes only after authoritative recovery', async () => {
  const real = successionHooks.useSessionSuccession, realWorkbench = workbenchComponents.LabWorkbench;
  let succession!: ReturnType<typeof real>, primary!: ComponentProps<typeof realWorkbench>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  vi.spyOn(workbenchComponents, 'LabWorkbench').mockImplementation(props => { primary = props; return realWorkbench(props); });
  const f = await failureFixture(false, 'B', false, '', { chain: [] });
  await settleApp(() => expect(primary.state?.agent?.id).toBe('agent-A'));
  const next = committed(); f.chain.push(next); await act(async () => f.notify(next));
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('B'));
  const editor = f.view.querySelector('[data-testid="prompt-input"]'), owners = structuredClone(succession.desired!.slot.owners);
  const oldRecipient = succession.imageRecipient!, oldPrimary = primary;
  const beforeRequests = f.requests.length, beforeFrames = f.frames.length;
  await act(async () => f.setAccessReady(false));
  expect(new URL(window.location.href).searchParams.get('session')).toBe('B');
  expect(succession.active).toBe(true);
  expect(succession.selected?.nativeSessionId).toBe('B');
  expect(readLastSession(f.scope)?.nativeSessionId).toBe('B');
  expect(primary.state?.agent?.id).not.toBe('agent-A');
  expect(primary.draftOnly).toBe(true); expect(succession.isCurrent()).toBe(false); expect(oldRecipient.isCurrent()).toBe(false);
  expect(succession.desired!.slot.owners).toEqual(owners);
  expect(f.view.querySelector('[data-testid="prompt-input"]')).toBe(editor);
  await act(async () => { primary.draftBinding!.store.set(primary.draftBinding!.key, 'Edited while access paused'); });
  expect(editor?.textContent).toBe('Edited while access paused');
  await expect(oldPrimary.actions.sendMessage!('Must remain local')).rejects.toThrow();
  expect(f.requests.slice(beforeRequests).filter(item => item.url.endsWith('/attach'))).toEqual([]);
  expect(f.frames.slice(beforeFrames).filter(frame => frame.message && ['send_message', 'execute_command', 'image_upload_begin'].includes(frame.message.type))).toEqual([]);
  const release = f.pauseReplay();
  await act(async () => f.setAccessReady(true));
  await settleApp(() => expect(f.requests.slice(beforeRequests).some(item => item.url.includes('/session-successions'))).toBe(true));
  expect(succession.isCurrent()).toBe(false); expect(oldRecipient.isCurrent()).toBe(false);
  expect(succession.selected?.nativeSessionId).toBe('B');
  expect(editor?.textContent).toBe('Edited while access paused');
  release();
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('B'));
  expect(succession.imageRecipient?.isCurrent()).toBe(true); expect(oldRecipient.isCurrent()).toBe(false);
  expect(succession.desired!.slot.owners).toEqual(owners);
  expect(f.view.querySelector('[data-testid="prompt-input"]')).toBe(editor);
  expect(f.requests.slice(beforeRequests).filter(item => item.url.endsWith('/attach')).every(item => item.body?.nativeSessionId === 'B')).toBe(true);
  expect(new URL(window.location.href).searchParams.get('session')).toBe('B');
  expect(readLastSession(f.scope)?.nativeSessionId).toBe('B');
});

it('newer Favorites progress with the same tree revision recovers missed succession once', async () => {
  const real = successionHooks.useSessionSuccession, realStars = starsHooks.useSessionStars;
  let succession!: ReturnType<typeof real>, favorites!: ReturnType<typeof realStars>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  vi.spyOn(starsHooks, 'useSessionStars').mockImplementation((...args) => { favorites = realStars(...args); return favorites; });
  const snapshot = (revision: number, status: 'applied' | 'pending' = 'applied'): FavoritesSnapshot => ({ revision: 7, folders: [],
    stars: ['B', 'C'].map((nativeSessionId, index) => ({ hostId: 'host', providerId: 'recorded', nativeSessionId, title: nativeSessionId,
      starredAt: 1, favoriteId: `favorite-${nativeSessionId}`, folderId: null, order: index, available: true, online: true })),
    successionProgress: { version: 1, roles: [{ hostId: 'host', controllerId: 'installation', roleId: 'primary', roleRevision: revision, operationId: `primary-op-${revision}`, status }] } });
  const f = await failureFixture(false, 'B', false, '', { userScoped: true, favorites: snapshot(2) });
  await settleApp(() => { expect(succession.binding?.session.nativeSessionId).toBe('B'); expect(favorites.ready).toBe(true); });
  const queries = () => f.requests.filter(item => item.url.includes('/session-successions?')).length;
  const before = queries(), editor = f.view.querySelector('[data-testid="prompt-input"]');
  f.chain.push(committed('B', 'C', 3)); f.setFavorites(snapshot(3));
  const release = f.pauseReplay();
  try {
    await act(async () => { await favorites.refresh(); });
    expect(favorites.revision).toBe(7); expect(favorites.successionProgress?.roles[0]?.roleRevision).toBe(3);
    await settleApp(() => expect(queries()).toBeGreaterThan(before));
    expect(succession.selected?.nativeSessionId).toBe('B');
    expect(f.requests.filter(item => item.url.endsWith('/attach')).map(item => item.body?.nativeSessionId)).toEqual(['B']);
  } finally { release(); }
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('C'));
  expect(f.view.querySelector('[data-testid="prompt-input"]')).toBe(editor);
  expect(editor?.textContent).toBe('A local draft');
  const after = queries();
  for (const value of [snapshot(3), snapshot(2), snapshot(2, 'pending'), { revision: 7, folders: [], stars: snapshot(3).stars }]) {
    f.setFavorites(value); await act(async () => { await favorites.refresh(); });
    expect(queries()).toBe(after); expect(succession.selected?.nativeSessionId).toBe('C');
  }
  f.setFavorites(snapshot(4, 'pending')); await act(async () => { await favorites.refresh(); });
  await settleApp(() => { expect(queries()).toBeGreaterThan(after); expect(succession.discovering).toBe(false); });
  expect(succession.selected?.nativeSessionId).toBe('C');
  expect(succession.document.roles[0]?.appliedRevision).toBe(3);
  const pendingQueries = queries();
  f.setFavorites(snapshot(4, 'pending')); await act(async () => { await favorites.refresh(); });
  expect(queries()).toBe(pendingQueries);
  expect(f.requests.filter(item => item.url.endsWith('/attach')).map(item => item.body?.nativeSessionId)).toEqual(['B', 'C']);
  expect(f.frames.filter(frame => frame.message && ['send_message', 'execute_command', 'image_upload_begin'].includes(frame.message.type))).toEqual([]);
});

it('discovers desired B over HTTP before any A attach, retains its owner on failure and retries only explicitly', async () => {
  const f = await failureFixture();
  await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); expect(f.view.textContent).toContain('Fixture successor unavailable.'); });
  expect(f.requests.filter(item => item.url.endsWith('/attach')).map(item => item.body?.nativeSessionId)).toEqual(['B']);
  expect(f.view.querySelector('[data-testid="prompt-input"]')?.textContent).toBe('A local draft');
  const saved = readCompositionDocument(f.scope);
  expect(saved.status).toBe('ready');
  if (saved.status === 'ready') expect(saved.document.slots[0]?.intent).toMatchObject({ kind: 'role', revision: 2, target: { native: native('B') } });
  await act(async () => {
    const retry = [...f.view.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Retry session');
    expect(retry).toBeDefined(); retry!.click();
    await vi.waitFor(() => expect(f.requests.filter(item => item.url.endsWith('/attach'))).toHaveLength(2));
  });
  expect(f.requests.filter(item => item.body).every(item => item.url.endsWith('/attach'))).toBe(true);
});

it('uses C when current advances during initial A enrollment after the discovery page reported B', async () => {
  const f = await failureFixture(true);
  await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); expect(f.view.textContent).toContain('Fixture successor unavailable.'); });
  expect(f.requests.filter(item => item.url.endsWith('/attach')).map(item => item.body?.nativeSessionId)).toEqual(['C']);
  expect(new URL(f.requests.find(item => item.url.includes('/session-successions?'))!.url, f.scope).searchParams.get('limit')).toBe('64');
  const saved = readCompositionDocument(f.scope);
  if (saved.status !== 'ready') throw new Error('Composition was not saved.');
  expect(saved.document.slots[0]!.intent).toMatchObject({ kind: 'role', revision: 3, target: { native: native('C') } });
  await act(async () => [...f.view.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Retry session')!.click());
  await vi.waitFor(() => expect(f.requests.filter(item => item.url.endsWith('/attach')).map(item => item.body?.nativeSessionId)).toEqual(['C', 'C']));
});


it.each([null, 'wrong-native'])('keeps the opaque draft editable and refuses native input for snapshot identity %s', async identity => {
  const f = await failureFixture(false, identity);
  await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); expect(f.view.textContent).toContain('The native session identity could not be confirmed.'); });
  expect(f.view.querySelector('[data-testid="prompt-input"]')?.textContent).toBe('A local draft');
  expect(f.frames.some(frame => frame.message?.type === 'send_message')).toBe(false);
  expect(f.requests.filter(item => item.url.endsWith('/attach')).map(item => item.body?.nativeSessionId)).toEqual(['B']);
});

it('confirms only B through the real session channel in StrictMode and keeps its view during native recovery', async () => {
  const f = await failureFixture(false, 'B', true);
  await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); expect(f.view.querySelector('.lab-has-agent')).not.toBeNull(); });
  expect(f.view.querySelector('[data-testid="prompt-input"]')?.textContent).toBe('A local draft');
  await act(async () => { for (const update of f.updates) update('B', 'restoring'); });
  await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); expect(f.view.textContent).toContain('Native runtime is restoring this session.'); });
  expect(f.view.querySelector('.lab-has-agent')).not.toBeNull();
  await act(async () => { for (const update of f.updates) update('B'); });
  expect(f.frames.filter(frame => frame.type === 'subscribe').every(frame => frame.agentId === 'agent-B')).toBe(true);
  expect(f.requests.filter(item => item.url.endsWith('/attach')).map(item => item.body?.nativeSessionId)).toEqual(['B']);
});


it.each([['&keepOriginal=1', 'B', 'A local draft'], ['&intent=history', 'A', '']])('keeps prompt-edit behavior independent of succession history owners: %s', async (flags, expected, draft) => {
  const f = await failureFixture(false, undefined, false, flags);
  await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); expect(f.view.textContent).toContain('Fixture successor unavailable.'); });
  expect(f.requests.filter(item => item.url.endsWith('/attach')).map(item => item.body?.nativeSessionId)).toEqual([expected]);
  expect(f.view.querySelector('[data-testid="prompt-input"]')?.textContent).toBe(draft);
  const read = readCompositionDocument(f.scope);
  if (read.status !== 'ready') throw new Error('Missing composition.');
  const slot = read.document.slots.find(slot => slot.intent.kind === (flags.includes('history') ? 'history' : 'role'))!;
  expect(slot).toBeDefined();
  expect(slot.owners.text.key === 'agent-A').toBe(!flags.includes('history'));
});

it('treats succession notifications as hints until authorized HTTP recovery completes', async () => {
  const f = await failureFixture(false, 'B');
  await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); expect(f.view.querySelector('.lab-has-agent')).not.toBeNull(); });
  const release = f.pauseReplay();
  try {
    const before = f.requests.length;
    await act(async () => f.notify(committed('B', 'C', 3)));
    await vi.waitFor(() => expect(f.requests.length).toBeGreaterThan(before));
    expect(f.view.querySelector('.lab-has-agent')).not.toBeNull();
    expect(f.requests.filter(item => item.url.endsWith('/attach')).map(item => item.body?.nativeSessionId)).toEqual(['B']);
  } finally { release(); }
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 50)); });
  const saved = readCompositionDocument(f.scope);
  if (saved.status !== 'ready') throw new Error('Missing composition.');
  expect(saved.document.slots.find(slot => slot.intent.kind === 'role')?.intent).toMatchObject({ revision: 2, target: { native: native('B') } });
  expect(f.requests.filter(item => item.url.endsWith('/attach')).map(item => item.body?.nativeSessionId)).toEqual(['B']);
});

it('commits the first role Track view before a later role participant fails', async () => {
  const realTracking = trackingHooks.useSessionTracking, rendered: string[][] = [];
  vi.spyOn(trackingHooks, 'useSessionTracking').mockImplementation((...args) => {
    const tracking = realTracking(...args); rendered.push(tracking.sessions.map(item => item.nativeSessionId)); return tracking;
  });
  const realFlush = DraftStore.prototype.flushCurrent;
  let beforeFailure: string[] | undefined;
  vi.spyOn(DraftStore.prototype, 'flushCurrent').mockImplementation(function (this: DraftStore, key, revision, current) {
    if (key === 'agent-X') {
      beforeFailure = rendered.at(-1);
      return Promise.resolve({ status: 'failed', ticket: 0, error: new Error('Second owner unavailable'), sessionWritten: false, localWritten: false });
    }
    return realFlush.call(this, key, revision, current);
  });
  const errors = vi.spyOn(console, 'error').mockImplementation(() => {});
  const f = await failureFixture(false, undefined, false, '', { chain: [committed(), committed('X', 'Y', 2, 'secondary')], seed(scope, source) {
    const secondary = { ...source, nativeSessionId: 'X', agentId: 'agent-X', title: 'Independent second role' };
    localStorage.setItem(`agent-remote-opened:${scope}`, JSON.stringify([source, secondary]));
    saveTrackedSessions(scope, [source, secondary].map(item => ({ ...item, hostId: 'host', starredAt: 1 })));
  } });
  await vi.waitFor(() => expect(beforeFailure).toBeDefined());
  expect(beforeFailure).toEqual(['B', 'X']);
  expect(readTrackedSessions(f.scope).map(item => item.nativeSessionId)).toEqual(['B', 'X']);
  await vi.waitFor(() => expect(f.requests.filter(item => item.url.endsWith('/attach')).map(item => item.body?.nativeSessionId)).toEqual(['B']));
  const read = readCompositionDocument(f.scope);
  if (read.status !== 'ready') throw new Error('Missing composition.');
  expect(read.document.roles.find(role => role.roleId === 'primary')?.appliedRevision).toBe(2);
  expect(read.document.roles.find(role => role.roleId === 'secondary')?.appliedRevision).toBeLessThan(2);
  expect(errors.mock.calls.flat().join(' ')).not.toContain('flushSync was called from inside a lifecycle method');
});

it.each(['edit', 'retire'] as const)('rejects an accepted but queued Track publication after %s without native observation', async boundary => {
  const realTracking = trackingHooks.useSessionTracking;
  let scope = '', interrupted = false, rendered: string[] = [];
  vi.spyOn(trackingHooks, 'useSessionTracking').mockImplementation((...args) => {
    const tracking = realTracking(...args); rendered = tracking.sessions.map(item => item.nativeSessionId);
    return { ...tracking, refresh(revision, current) {
      const result = tracking.refresh(revision, current);
      if (!interrupted && result.status === 'ready') {
        interrupted = true;
        if (boundary === 'edit') tracking.toggle({ hostId: 'host', providerId: 'recorded', nativeSessionId: 'User-edit', title: 'User edit', starredAt: 2 });
        else clearConversationRecovery(scope);
      }
      return result;
    } };
  });
  const f = await failureFixture(false, undefined, false, '', { seed(value, source) { scope = value; saveTrackedSessions(scope, [{ ...source, hostId: 'host', starredAt: 1 }]); } });
  await vi.waitFor(() => expect(interrupted).toBe(true));
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 40)); });
  expect(f.requests.filter(item => item.url.endsWith('/attach'))).toEqual([]);
  expect(f.frames.filter(frame => frame.type === 'subscribe')).toEqual([]);
  if (boundary === 'edit') {
    expect(rendered).toEqual(['B', 'User-edit']);
    expect(readTrackedSessions(scope).map(item => item.nativeSessionId)).toEqual(rendered);
    expect(f.view.textContent).toContain('track_publish_uncommitted');
  }
});

it('retains closed and nested Ask owners, and supplies T with its own replaceable native image recipient', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const realAsk = askHooks.useAskConversations, realSuccession = successionHooks.useSessionSuccession;
  let ask!: ReturnType<typeof realAsk>, succession!: ReturnType<typeof realSuccession>;
  let consumer!: Parameters<typeof realSuccession>[0];
  vi.spyOn(askHooks, 'useAskConversations').mockImplementation((...args) => { ask = realAsk(...args); return ask; });
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { consumer = args[0]; succession = realSuccession(...args); return succession; });
  let original!: OpenedSession, target!: OpenedSession, nested!: OpenedSession;
  const f = await failureFixture(false, 'B', false, '', { seed(scope, source) {
    original = source; target = { ...source, nativeSessionId: 'T', agentId: 'agent-T', title: 'Independent Ask target' };
    nested = { ...target, nativeSessionId: 'U', agentId: 'agent-U', title: 'Nested Ask target' };
    const store = new ForkStore(`ask:${scope}`, sessionStorage);
    for (const [from, to] of [[source, target], [target, nested]]) {
      const record = store.prepare(referenceForkContext(from!), { sourceNativeSessionId: from!.nativeSessionId }); store.bind(record.id, to!); store.markConfigured(record.id); store.finishCreation(record.id);
    }
  } });
  await vi.waitFor(() => expect(succession.binding).toBeDefined());
  const primaryOwner = succession.ownerFor(succession.desired!.slot.id);
  expect(primaryOwner).toBeDefined();
  expect(succession.ownerFor(succession.document.slots.find(slot => slot.owners.text.key === target.agentId)!.id)).toBeDefined();
  expect(ask.isOpen(original, primaryOwner)).toBe(false);
  expect(ask.entryFor(original, primaryOwner).record?.source).toEqual(original);
  expect(f.requests.filter(item => item.url.endsWith('/attach')).map(item => item.body?.nativeSessionId)).toEqual(['B']);
  await act(async () => { await ask.open(undefined, succession.binding!.session, '', false, { associationOwner: primaryOwner }); });
  await vi.waitFor(() => expect(succession.recipientFor(target, primaryOwner)?.isCurrent()).toBe(true));
  const first = succession.recipientFor(target, primaryOwner)!, primary = succession.imageRecipient!;
  expect(first.lifetime).not.toBe(primary.lifetime);
  expect(first.identity).toContain('agent-T'); expect(primary.identity).toContain('agent-B');
  await act(async () => f.updatesByAgent.get('agent-T')!('T', 'restoring'));
  await vi.waitFor(() => expect(first.isCurrent()).toBe(false)); expect(primary.isCurrent()).toBe(true);
  await act(async () => f.updatesByAgent.get('agent-T')!('T'));
  await vi.waitFor(() => expect(succession.recipientFor(target, primaryOwner)?.isCurrent()).toBe(true));
  const recovered = succession.recipientFor(target, primaryOwner)!;
  expect(recovered.lifetime).not.toBe(first.lifetime); expect(first.isCurrent()).toBe(false);
  const connection = consumer.connections.find(target)!;
  const retained = consumer.connections.acquire(target.agentId, connection.replica, target); cleanups.push(retained.release);
  await act(async () => {
    ask.close(original, primaryOwner);
    const record = ask.store.prepare(referenceForkContext(original), { sourceNativeSessionId: original.nativeSessionId });
    ask.store.bind(record.id, target); ask.store.markConfigured(record.id); ask.store.finishCreation(record.id);
    succession.document.asks.find(owner => owner.id === primaryOwner)!.records!.push({ id: record.id, target: sessionKey(target) });
    succession.document.editRevision++; succession.save();
    await ask.open(undefined, succession.binding!.session, '', false, { associationOwner: primaryOwner });
  });
  await vi.waitFor(() => expect(succession.recipientFor(target, primaryOwner)?.isCurrent()).toBe(true));
  expect(recovered.isCurrent()).toBe(false);
  expect(succession.recipientFor(target, primaryOwner)?.lifetime).not.toBe(recovered.lifetime);
  expect(f.frames.some(frame => ['send_message', 'execute_command'].includes(frame.message?.type ?? ''))).toBe(false);
});


it.each(['route_not_found', 'http_404'])('keeps ordinary fixed navigation available when initial HTTP discovery reports unsupported %s', async code => {
  const f = await failureFixture(false, 'A', false, '', { replayFailure: code });
  await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); expect(f.requests.filter(item => item.url.endsWith('/attach')).map(item => item.body?.nativeSessionId)).toEqual(['A']); });
  await vi.waitFor(() => expect(f.view.querySelector('.lab-has-agent')).not.toBeNull());
});

it('does not treat authorization-hidden succession as an unsupported transport', async () => {
  const f = await failureFixture(false, 'A', false, '', { replayFailure: 'session_not_found' });
  await vi.waitFor(() => expect(f.view.textContent).toContain('Fixture succession route unavailable.'));
  expect(f.requests.filter(item => item.url.endsWith('/attach'))).toEqual([]);
});

it('restores a selected Side path and focus while the primary changes from A to B', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const real = successionHooks.useSessionSuccession;
  let succession!: ReturnType<typeof real>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  let side!: OpenedSession;
  const f = await failureFixture(false, 'B', false, '', { selected: 'S', seed(scope, source) {
    side = { ...source, nativeSessionId: 'S', agentId: 'agent-S', title: 'Retained Side' };
    localStorage.setItem(`agent-remote-opened:${scope}`, JSON.stringify([source, side]));
    saveSessionComposition(scope, { path: [source, side], focus: sessionKey(side), anchor: sessionKey(side), addressKey: sessionKey(side) });
  } });
  await vi.waitFor(() => expect(succession.binding).toBeDefined());
  await vi.waitFor(() => expect(f.view.querySelector('.lab-side-conversation')).not.toBeNull());
  const sideId = succession.document.slots.find(slot => slot.intent.target.native.nativeSessionId === 'S')!.id;
  expect(succession.layoutView()).toMatchObject({ primary: { nativeSessionId: 'B' }, sides: [side], focus: sideId, anchor: sideId });
  const saved = readCompositionDocument(f.scope);
  if (saved.status !== 'ready') throw new Error('Missing composition.');
  const sideSlot = saved.document.slots.find(slot => slot.owners.text.key === side.agentId)!;
  expect(saved.document.focus).toBe(sideSlot.id); expect(saved.document.anchor).toBe(sideSlot.id); expect(saved.document.address).toBe(sideSlot.id);
  expect(f.frames.filter(frame => frame.type === 'subscribe').map(frame => frame.agentId)).not.toContain('agent-A');
});


it('retains an authorized desired B after its replay endpoint becomes unavailable', async () => {
  const f = await failureFixture();
  await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); expect(f.view.textContent).toContain('Fixture successor unavailable.'); });
  f.failReplay('route_not_found');
  await act(async () => window.dispatchEvent(new Event('online')));
  await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); expect(f.view.textContent).toContain('Fixture succession route unavailable.'); });
  expect(f.requests.filter(item => item.url.endsWith('/attach')).map(item => item.body?.nativeSessionId)).toEqual(['B']);
  expect(new URL(window.location.href).searchParams.get('session')).toBe('B');
  expect(f.view.querySelector('[data-testid="prompt-input"]')?.textContent).toBe('A local draft');
});


it.each(['A', 'B'])('retains a completed old-source creation before rejecting new configuration, input and navigation after %s changes', async initial => {
  const realWorkbench = workbenchComponents.LabWorkbench, realSuccession = successionHooks.useSessionSuccession;
  let primary!: ComponentProps<typeof realWorkbench>, succession!: ReturnType<typeof realSuccession>;
  vi.spyOn(workbenchComponents, 'LabWorkbench').mockImplementation(props => { primary = props; return realWorkbench(props); });
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = realSuccession(...args); return succession; });
  const configure = vi.spyOn(forkActions, 'configureFork').mockRejectedValue(new Error('Unexpected target configuration'));
  const f = await failureFixture(false, 'B', false, '', initial === 'A' ? { chain: [] } : undefined);
  await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); expect(primary.state?.agent?.id).toBe(`agent-${initial}`); });
  const oldPrimary = primary, oldRecipient = succession.imageRecipient;
  const release = f.holdCreate();
  let pending!: Promise<unknown>;
  await act(async () => { pending = oldPrimary.onExecuteConsoleCommand!('console:side', 'Retained first input').catch(error => error); });
  await vi.waitFor(() => expect(f.requests.some(item => item.url.endsWith('/create'))).toBe(true));
  const current = initial === 'A' ? 'B' : 'C';
  const next = committed(initial, current, initial === 'A' ? 2 : 3); f.chain.push(next);
  await act(async () => f.notify(next));
  await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); expect(succession.binding?.session.nativeSessionId).toBe(current); });
  let result: unknown;
  await act(async () => { release(); result = await pending; });
  expect(result).toBeInstanceOf(Error); expect((result as Error).message).toContain('source session changed');
  const record = new ForkStore(f.scope).allLocal().find(record => record.source.nativeSessionId === initial)!;
  expect(record.target).toMatchObject({ nativeSessionId: 'S', agentId: 'agent-S' });
  expect(record.configured).not.toBe(true); expect(record.delivery).toBe('pending');
  expect(configure).not.toHaveBeenCalled(); if (oldRecipient) expect(oldRecipient.isCurrent()).toBe(false);
  await expect(oldPrimary.onExecuteConsoleCommand!('console:ask', 'late')).rejects.toThrow(/source session changed|view no longer matches/);
  await expect(oldPrimary.actions.sendMessage!('late native input')).rejects.toThrow();
  expect(f.frames.some(frame => ['send_message', 'execute_command'].includes(frame.message?.type ?? ''))).toBe(false);
  expect(new URL(window.location.href).searchParams.get('session')).toBe(current);
});

it.each(['A', 'B'].flatMap(initial => ['child', 'child-mobile', 'communication', 'ask'].map(operation => ({ initial, operation }))))
('fences held $operation work from source $initial after its successor is confirmed', async ({ initial, operation }) => {
  vi.stubGlobal('matchMedia', vi.fn((query: string) => ({ matches: query.includes(operation === 'child-mobile' ? 'max-width: 1180px' : 'min-width: 1181px'), media: query, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} })));
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const realWorkbench = workbenchComponents.LabWorkbench, realSuccession = successionHooks.useSessionSuccession;
  let primary!: ComponentProps<typeof realWorkbench>, succession!: ReturnType<typeof realSuccession>, communication: CommunicationNavigation | undefined;
  vi.spyOn(workbenchComponents, 'LabWorkbench').mockImplementation(props => { const navigation = useContext(CommunicationNavigationContext); if (props.state?.agent?.id !== 'agent-S') { primary = props; communication = navigation; } return realWorkbench(props); });
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = realSuccession(...args); return succession; });
  const configure = vi.spyOn(forkActions, 'configureFork').mockRejectedValue(new Error('Unexpected stale operation configuration'));
  const providerId = 'recorded';
  const child: AgentChildSession = { nativeSessionId: 'S', title: '/root/side', createdAt: 'now', status: 'idle', observation: 'live' };
  const letter: ProjectedTimelineEntry = { providerId, seqStart: 1, seqEnd: 1, timestamp: '2026-10-10T00:00:00Z', resources: [], collapsed: [], sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }],
    item: { type: 'agent_communication', messageId: 'letter', sender: '/root', recipient: '/root/side', text: 'Read the source message.' } };
  const f = await failureFixture(false, 'B', false, '', { providerId,
    chain: initial === 'A' ? [] : [committed('A', 'B', 2, 'primary', providerId)], children: operation === 'child-mobile' ? [] : [child], timeline: operation === 'communication' ? [letter] : [] });
  await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); expect(primary.state?.agent?.id).toBe(`agent-${initial}`); });
  const oldPrimary = primary, oldCommunication = communication;
  const create = operation === 'ask';
  let loaded = false, releaseLoad!: () => void;
  const loadGate = new Promise<void>(resolve => { releaseLoad = resolve; });
  if (operation === 'communication') {
    const load = sessionCommunication.loadSessionCommunication;
    vi.spyOn(sessionCommunication, 'loadSessionCommunication').mockImplementation(async (...args) => { const result = await load(...args); loaded = true; await loadGate; return result; });
  }
  const release = create ? f.holdCreate() : operation === 'communication' ? releaseLoad : f.holdAttach('S');
  cleanups.push(release);
  let pending!: Promise<unknown>;
  await act(async () => {
    const request = operation.startsWith('child') ? oldPrimary.onOpenChildSession!(child)
      : operation === 'communication' ? oldCommunication!.open(letter)
      : oldPrimary.onExecuteConsoleCommand!('console:ask', 'Question for the original source');
    pending = Promise.resolve(request).catch(error => error);
  });
  await vi.waitFor(() => expect(f.requests.some(item => create ? item.url.endsWith('/create') : item.url.endsWith('/child/attach'))).toBe(true));
  if (operation === 'communication') await vi.waitFor(() => expect(loaded).toBe(true));
  const destination = f.requests.find(item => create ? item.url.endsWith('/create') : item.url.endsWith('/child/attach'))!;
  expect(destination.body).toMatchObject(create ? { providerId, sourceNativeSessionId: initial } : { providerId, parentNativeSessionId: initial, nativeSessionId: 'S' });
  const current = initial === 'A' ? 'B' : 'C';
  const next = committed(initial, current, initial === 'A' ? 2 : 3, 'primary', providerId); f.chain.push(next);
  await act(async () => f.notify(next));
  await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); expect(succession.binding?.session.nativeSessionId).toBe(current); });
  const layoutBeforeRelease = JSON.stringify(succession.layoutView());
  let result: unknown;
  await act(async () => { release(); result = await pending; });
  if (operation === 'communication') { expect(result).toBeInstanceOf(Error); expect((result as Error).message).toContain('source session changed'); }
  if (operation === 'ask') {
    const record = new ForkStore(`ask:${f.scope}`, sessionStorage).allLocal().find(record => record.source.nativeSessionId === initial)!;
    expect(record.target).toMatchObject({ agentId: 'agent-S', providerId, nativeSessionId: 'S' });
    expect(record.configured).not.toBe(true); expect(record.delivery).toBe('pending');
    const inputs = JSON.parse(sessionStorage.getItem(`agent-remote-ask:${f.scope}:inputs:${JSON.stringify(['host', providerId, 'A'])}`) ?? '[]');
    expect(inputs).toEqual([expect.objectContaining({ text: 'Question for the original source', owner: expect.objectContaining({ recordId: record.id }) })]);
  }
  expect(configure).not.toHaveBeenCalled();
  expect(f.frames.some(frame => frame.type === 'subscribe' && frame.agentId === 'agent-S')).toBe(operation === 'communication');
  expect(f.frames.some(frame => ['send_message', 'execute_command', 'session_setting_request', 'interaction_response'].includes(frame.message?.type ?? ''))).toBe(false);
  expect(new URL(window.location.href).searchParams.get('session')).toBe(current);
  expect(primary.state?.agent?.id).toBe(`agent-${current}`);
  expect(JSON.stringify(succession.layoutView())).toBe(layoutBeforeRelease);
  expect(f.view.querySelector('.lab-side-conversation [data-inspected="true"]')).toBeNull();
});


it('rejects a retired source after awaiting Ask relations before creating any native target', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const realWorkbench = workbenchComponents.LabWorkbench, realSuccession = successionHooks.useSessionSuccession;
  let primary!: ComponentProps<typeof realWorkbench>, succession!: ReturnType<typeof realSuccession>;
  vi.spyOn(workbenchComponents, 'LabWorkbench').mockImplementation(props => { primary = props; return realWorkbench(props); });
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = realSuccession(...args); return succession; });
  const f = await failureFixture(false, 'B', false, '', { providerId: 'codex', userScoped: true, holdRelationsInitially: true });
  await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); expect(primary.state?.agent?.id).toBe('agent-B'); });
  const oldPrimary = primary;
  const release = f.holdRelations(); cleanups.push(release);
  let pending!: Promise<unknown>;
  await act(async () => { pending = oldPrimary.onExecuteConsoleCommand!('console:ask', 'Preserve the submitting source').catch(error => error); });
  await vi.waitFor(() => expect(f.requests.some(item => item.url.endsWith('/session-relations'))).toBe(true));
  const next = committed('B', 'C', 3, 'primary', 'codex'); f.chain.push(next);
  await act(async () => f.notify(next));
  await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); expect(succession.binding?.session.nativeSessionId).toBe('C'); });
  await act(async () => { release(); await pending; });
  expect(f.requests.filter(item => item.url.endsWith('/create'))).toEqual([]);
  expect(f.frames.filter(frame => frame.message?.type === 'resource_request').map(frame => frame.message?.payload?.agentId)).toEqual([]);
  expect(f.frames.some(frame => ['send_message', 'execute_command', 'session_setting_request'].includes(frame.message?.type ?? ''))).toBe(false);
  expect(new URL(window.location.href).searchParams.get('session')).toBe('C');
});

it.each(['retention failure', 'draft edit'])('retains independent B stores and selected Track through an Ask %s before publishing the role', async boundary => {
  const realAsk = askHooks.useAskConversations, realSuccession = successionHooks.useSessionSuccession;
  let ask!: ReturnType<typeof realAsk>, succession!: ReturnType<typeof realSuccession>, consumer!: Parameters<typeof realSuccession>[0];
  let source!: OpenedSession, independent!: OpenedSession, blocked = true, entered = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); cleanups.push(release);
  vi.spyOn(askHooks, 'useAskConversations').mockImplementation((...args) => {
    ask = realAsk(...args); const value = ask;
    return { ...value, async retainAssociationOwners(...params) {
      const result = await value.retainAssociationOwners(...params);
      if (blocked && result.status === 'applied') {
        entered = true;
        if (boundary === 'retention failure') return { status: 'failed', retention: 'page', code: 'fixture_ask_retention' };
        await gate;
      }
      return result;
    } };
  });
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => {
    consumer = args[0];
    succession = realSuccession(...args); return succession;
  });
  const f = await failureFixture(false, 'B', false, '', { async seed(scope, original) {
    source = original; independent = { ...original, nativeSessionId: 'B', agentId: 'agent-B', title: 'Independent B' };
    localStorage.setItem(`agent-remote-opened:${scope}`, JSON.stringify([source, independent]));
    saveTrackedSessions(scope, [source, independent].map((entry, index) => ({ ...entry, hostId: 'host', starredAt: index + 1 })));
    const text = new DraftStore(scope); text.set(independent.agentId, 'Independent B draft'); text.flush();
    await writeImageDraft({ version: 1, scope, key: JSON.stringify([scope, sessionKey(independent)]),
      parts: [{ type: 'image', imageId: 'independent-B-image', label: 'Independent B image' }],
      images: { 'independent-B-image': { imageId: 'independent-B-image', blob: new Blob(['Independent B image bytes'], { type: 'image/png' }), uploadId: 'independent-B-upload', status: 'pending', progress: 0 } }, nextLabel: 2 });
    const askText = new DraftStore(`${scope}:ask`); askText.set(sessionKey(source), 'Primary Ask draft'); askText.set(sessionKey(independent), 'Independent Ask draft'); askText.flush();
    const store = new ForkStore(`ask:${scope}`, sessionStorage);
    for (const [origin, nativeSessionId] of [[source, 'T'], [independent, 'U']] as const) {
      const record = store.prepare(referenceForkContext(origin), { sourceNativeSessionId: origin.nativeSessionId });
      store.bind(record.id, { ...origin, nativeSessionId, agentId: `agent-${nativeSessionId}` }); store.markConfigured(record.id); store.finishCreation(record.id);
    }
    const imported = initializeCompositionDocument(scope);
    if (imported.status !== 'ready') throw new Error('Fixture import failed');
    const views = new TrackedSessionViews(imported.document, () => {});
    for (const entry of [source, independent]) {
      const slot = imported.document.slots.find(slot => slot.owners.text.key === entry.agentId)!;
      views.select(sessionKey(entry)); views.remember({ primarySlot: slot.id, selections: {}, focus: slot.id, anchor: slot.id });
    }
    saveCompositionDocument(imported.document, () => true); flushRecoveryWrites();
  } });
  await vi.waitFor(() => expect(entered).toBe(true));
  if (boundary === 'draft edit') {
    await act(async () => { consumer.textStore(f.scope).set(source.agentId, 'Edited while Ask retained'); release(); });
  }
  await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); expect(succession.error).toContain('needs synchronization'); });
  expect(consumer.tracking().sessions.map(entry => entry.nativeSessionId)).toEqual(['A', 'B']);
  expect(readTrackedSessions(f.scope).map(entry => entry.nativeSessionId)).toEqual(['A', 'B']);
  expect(succession.document.selectedTrack).toBe(sessionKey(independent));
  expect(new TrackedSessionViews(succession.document, () => {}).get(sessionKey(independent))?.primary.nativeSessionId).toBe('B');
  const independentSlot = succession.document.slots.find(slot => slot.owners.text.key === independent.agentId)!;
  const independentImage = independentSlot.owners.image;
  const assertIndependentImage = async () => {
    expect(independentImage).toEqual({ scope: f.scope, key: JSON.stringify([f.scope, sessionKey(independent)]) });
    expect(succession.desired!.slot.owners.image).not.toEqual(independentImage);
    const image = (await readImageDraft(independentImage.key))?.images['independent-B-image'];
    expect(image?.blob && await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(reader.error); reader.readAsText(image.blob!); })).toBe('Independent B image bytes');
    expect((await inspectImageDraft(independentImage)).snapshot()).toMatchObject({ status: 'ready', retention: 'page' });
    expect((await readImageDraft(succession.desired!.slot.owners.image.key))?.images['independent-B-image']).toBeUndefined();
  };
  await assertIndependentImage();
  expect(succession.document.retained.some(value => value.slot === independentSlot.id)).toBe(true);
  const primaryOwner = succession.ownerFor(succession.document.slots.find(slot => slot.owners.text.key === source.agentId)!.id), independentOwner = succession.ownerFor(independentSlot.id);
  expect(primaryOwner).not.toBe(independentOwner);
  expect(ask.entryFor(source, primaryOwner).record?.target?.nativeSessionId).toBe('T');
  expect(ask.entryFor(independent, independentOwner).record?.target?.nativeSessionId).toBe('U');
  expect(ask.draftBinding(independentOwner).store.get(ask.draftBinding(independentOwner).key)).toBe('Independent Ask draft');
  expect(consumer.textStore(f.scope).get(independent.agentId)).toBe('Independent B draft');
  expect(f.requests.filter(item => item.url.endsWith('/attach'))).toEqual([]);
  expect(f.frames.filter(frame => frame.type === 'subscribe')).toEqual([]);
  const trackedLayouts = structuredClone(succession.document.tracks.map(({ entryId, view }) => ({ entryId, view })));
  blocked = false; release();
  await act(async () => succession.retry());
  await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); expect(succession.binding?.session.nativeSessionId).toBe('B'); });
  expect(consumer.tracking().sessions.map(entry => entry.nativeSessionId)).toEqual(['B']);
  await assertIndependentImage();
  expect(succession.document.selectedTrack).toBe(sessionKey(independent));
  expect(succession.document.tracks.map(({ entryId, view }) => ({ entryId, view }))).toEqual(trackedLayouts);
  expect(consumer.textStore(f.scope).get(independent.agentId)).toBe('Independent B draft');
  const text = boundary === 'draft edit' ? 'Edited while Ask retained' : 'A local draft';
  expect(f.view.querySelector('[data-testid="prompt-input"]')?.textContent).toBe(text);
  expect(ask.entryFor(independent, independentOwner).record?.source.nativeSessionId).toBe('B');
  expect(ask.entryFor(independent, independentOwner).record?.target?.nativeSessionId).toBe('U');
  expect(succession.document.tracks.map(track => track.view?.primarySlot)).toEqual(expect.arrayContaining([succession.desired!.slot.id, independentSlot.id]));
  expect(f.requests.filter(item => item.url.endsWith('/attach')).map(item => item.body?.nativeSessionId)).toEqual(['B']);
});

it('keeps A outbox, question drafts and reading cursor concrete through B confirmation and explicit A history', async () => {
  const realWorkbench = workbenchComponents.LabWorkbench, realHistory = historyHooks.useConversationHistory, realSuccession = successionHooks.useSessionSuccession;
  let primary!: ComponentProps<typeof realWorkbench>, positions!: ReadingPositions, open!: Parameters<typeof realHistory>[2], succession!: ReturnType<typeof realSuccession>;
  vi.spyOn(workbenchComponents, 'LabWorkbench').mockImplementation(props => { primary = props; positions = useContext(RecoveryScope)!; return realWorkbench(props); });
  vi.spyOn(historyHooks, 'useConversationHistory').mockImplementation((...args) => { open = args[2]; return realHistory(...args); });
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = realSuccession(...args); return succession; });
  let source!: OpenedSession, outboxKey = '';
  const f = await failureFixture(false, 'B', false, '', { chain: [], preserveNativeState: true, seed(scope, original) {
    source = original; outboxKey = `agent-remote:recovery:${scope}:outbox:${sessionKey(source)}`;
    localStorage.setItem(outboxKey, JSON.stringify([{ id: 'saved-A', agentId: 'agent-A', text: 'Unsent A', epoch: 'epoch-agent-A', afterSeq: 0, status: 'failed', operationId: 'original-A-operation', error: 'Original failure' }]));
  } });
  await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); expect(primary.state?.agent?.id).toBe('agent-A'); expect(primary.state?.timeline.initialized).toBe(true); });
  const question = { answers: { one: { selectedValues: ['web'] } } };
  const readingKey = JSON.stringify(['agent-A', 'epoch-agent-A']);
  await act(async () => { primary.onQuestionDraftChange!('question-A', question); positions.set(readingKey, { following: false, anchor: { key: 'A-message-anchor', offset: 23 } }); });
  const originalPosition = positions.get(readingKey), originalOutbox = localStorage.getItem(outboxKey), oldPrimary = primary;
  expect(primary.state?.outgoingMessages).toContainEqual(expect.objectContaining({ id: 'saved-A', agentId: 'agent-A', status: 'failed' }));
  expect(primary.questionDrafts).toEqual({ 'question-A': question });
  const next = committed(); f.chain.push(next); await act(async () => f.notify(next));
  await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); expect(succession.binding?.session.nativeSessionId).toBe('B'); expect(primary.state?.agent?.id).toBe('agent-B'); });
  expect(primary.state?.outgoingMessages ?? []).toEqual([]); expect(primary.questionDrafts).toEqual({});
  expect(positions.get(readingKey)).toEqual(originalPosition);
  expect(positions.get(JSON.stringify(['agent-B', 'epoch-agent-B']))).not.toEqual(originalPosition);
  expect(localStorage.getItem(outboxKey)).toBe(originalOutbox);
  expect(localStorage.getItem(`agent-remote:recovery:${f.scope}:outbox:${sessionKey({ ...source, nativeSessionId: 'B' })}`)).toBeNull();
  await expect(oldPrimary.actions.retryMessage!('saved-A')).rejects.toThrow();
  await expect(oldPrimary.actions.respondToInteraction!('question-A', { kind: 'question', answers: [{ questionId: 'one', selectedValues: ['web'] }] })).rejects.toThrow();
  expect(f.frames.some(frame => ['send_message', 'interaction_response'].includes(frame.message?.type ?? ''))).toBe(false);
  await act(async () => { expect(await open(source, 'history')).toBe(true); });
  await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); expect(primary.state?.agent?.id).toBe('agent-A'); expect(primary.state?.timeline.initialized).toBe(true); });
  expect(new URL(window.location.href).searchParams.get('intent')).toBe('history');
  expect(primary.questionDrafts).toEqual({ 'question-A': question });
  expect(primary.state?.outgoingMessages).toContainEqual(expect.objectContaining({ id: 'saved-A', agentId: 'agent-A', status: 'failed' }));
  const before = f.frames.length;
  await act(async () => {
    await primary.actions.retryMessage!('saved-A');
    await primary.actions.respondToInteraction!('question-A', { kind: 'question', answers: [{ questionId: 'one', selectedValues: ['web'] }] });
    await primary.actions.loadOlder!();
  });
  const operations = f.frames.slice(before).filter(frame => ['send_message', 'interaction_response', 'timeline_request'].includes(frame.message?.type ?? ''));
  expect(operations.map(frame => [frame.message?.type, frame.message?.payload?.agentId])).toEqual([
    ['send_message', 'agent-A'], ['interaction_response', 'agent-A'],
  ]);
  const older = new URL(f.requests.filter(item => item.url.includes('/timeline?')).at(-1)!.url, f.scope);
  expect(older.pathname).toContain('/agent-A/timeline');
  expect(older.searchParams.get('direction')).toBe('before');
  expect(older.searchParams.get('epoch')).toBe('epoch-agent-A');
  expect(older.searchParams.get('seq')).toBe('1');
  expect(f.requests.filter(item => item.url.endsWith('/attach')).map(item => item.body?.nativeSessionId)).toEqual(['A', 'B', 'A']);
});

it.each([['damaged', '{broken'], ['unsupported', JSON.stringify({ version: 99 })], ['capacity', ' '.repeat(1048577)]])('preserves %s composition bytes without attaching the saved predecessor', async (_kind, original) => {
  const f = await failureFixture(false, 'B', false, '', { seed(scope) { sessionStorage.setItem(`agent-remote:recovery:${scope}:composition-v1`, original!); } });
  await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); expect(f.view.textContent).toContain('Saved session composition is unreadable or unsupported.'); });
  expect(sessionStorage.getItem(`agent-remote:recovery:${f.scope}:composition-v1`)).toBe(original);
  expect(f.requests.filter(item => item.url.endsWith('/attach'))).toEqual([]);
  expect(f.frames.filter(frame => frame.type === 'subscribe')).toEqual([]);
  expect(JSON.parse(sessionStorage.getItem(`agent-remote:recovery:${f.scope}:drafts`)!)['agent-A']).toBe('A local draft');
});

it('retains desired B and the editable owner when the composition checkpoint cannot be saved', async () => {
  const set = Storage.prototype.setItem;
  const f = await failureFixture(false, 'B', false, '', { seed(scope) {
    expect(initializeCompositionDocument(scope).status).toBe('ready');
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
      if (key.endsWith(':composition-v2')) throw new Error('Fixture storage capacity reached');
      set.call(this, key, value);
    });
  } });
  await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); expect(f.view.textContent).toContain('Session composition needs synchronization'); });
  expect(f.requests.filter(item => item.url.endsWith('/attach'))).toEqual([]);
  expect(f.view.querySelector('[data-testid="prompt-input"]')?.textContent).toBe('A local draft');
  expect(new URL(window.location.href).searchParams.get('session')).toBe('B');
});

it('permanently retires primary image lifetimes across page resume and same-native recovery', async () => {
  const real = successionHooks.useSessionSuccession;
  let succession!: ReturnType<typeof real>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  const f = await failureFixture(false, 'B');
  await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); expect(succession.imageRecipient?.isCurrent()).toBe(true); });
  const beforePage = succession.imageRecipient!;
  await act(async () => window.dispatchEvent(new Event('pagehide')));
  expect(beforePage.isCurrent()).toBe(false);
  await act(async () => window.dispatchEvent(new Event('pageshow')));
  await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); expect(succession.imageRecipient?.isCurrent()).toBe(true); });
  const beforeNative = succession.imageRecipient!;
  expect(beforeNative.lifetime).not.toBe(beforePage.lifetime);
  await act(async () => f.updatesByAgent.get('agent-B')!('B', 'restoring'));
  await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); expect(beforeNative.isCurrent()).toBe(false); });
  await act(async () => f.updatesByAgent.get('agent-B')!('B'));
  await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); expect(succession.imageRecipient?.isCurrent()).toBe(true); });
  expect(beforePage.isCurrent()).toBe(false); expect(beforeNative.isCurrent()).toBe(false);
  expect(succession.imageRecipient!.lifetime).not.toBe(beforeNative.lifetime);
  expect(f.requests.filter(item => item.url.endsWith('/attach')).map(item => item.body?.nativeSessionId)).toEqual(['B']);
  expect(f.view.querySelector('.lab-has-agent')).not.toBeNull();
});

it('reconciles metadata on page resume without retrying an HTTP attachment failure', async () => {
  const f = await failureFixture();
  await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); expect(f.view.textContent).toContain('Fixture successor unavailable.'); });
  const reads = f.requests.filter(item => item.url.includes('/session-successions')).length;
  await act(async () => { window.dispatchEvent(new Event('pagehide')); window.dispatchEvent(new Event('pageshow')); });
  await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); }); expect(f.requests.filter(item => item.url.includes('/session-successions')).length).toBeGreaterThan(reads); });
  expect(f.requests.filter(item => item.url.endsWith('/attach')).map(item => item.body?.nativeSessionId)).toEqual(['B']);
  expect(f.view.textContent).toContain('Retry session');
});

it('opens retained B and the role through local view entries without sharing their owners or replacing the native connection', async () => {
  const real = successionHooks.useSessionSuccession, realAsk = askHooks.useAskConversations;
  let succession!: ReturnType<typeof real>, ask!: ReturnType<typeof realAsk>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  vi.spyOn(askHooks, 'useAskConversations').mockImplementation((...args) => { ask = realAsk(...args); return ask; });
  const f = await failureFixture(false, 'B', false, '', { async seed(scope, source) {
    const independent = { ...source, nativeSessionId: 'B', agentId: 'agent-B', title: 'Independent B' };
    localStorage.setItem(`agent-remote-opened:${scope}`, JSON.stringify([source, independent]));
    const text = new DraftStore(scope); text.set(independent.agentId, 'Independent B draft'); text.flush();
    const store = new ForkStore(`ask:${scope}`, sessionStorage), askText = new DraftStore(`${scope}:ask`);
    for (const [origin, target] of [[source, 'T'], [independent, 'U']] as const) {
      const record = store.prepare(referenceForkContext(origin), { sourceNativeSessionId: origin.nativeSessionId });
      store.bind(record.id, { ...origin, nativeSessionId: target, agentId: `agent-${target}` }); store.markConfigured(record.id); store.finishCreation(record.id);
      askText.set(sessionKey(origin), `Ask draft for ${target}`);
    }
    askText.flush();
  } });
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('B'));
  const originalSlot = succession.desired!.slot.id, originalClient = succession.binding!.client;
  const independent = succession.document.slots.find(slot => slot.owners.text.key === 'agent-B')!;
  const primary = () => f.view.querySelector('.lab-primary-conversation')!;
  const clickView = async (title: string) => {
    await act(async () => primary().querySelector<HTMLButtonElement>('.lab-chat-sessions-heading')!.click());
    const row = [...primary().querySelectorAll<HTMLButtonElement>('.lab-chat-session-row')].find(button => button.textContent?.includes(title));
    expect(row).toBeDefined(); expect(row!.disabled).toBe(false);
    await act(async () => row!.click());
  };
  const assertAsk = (target: string) => {
    const bound = succession.binding!.session, owner = succession.ownerFor(bound.viewId);
    expect(succession.document.asks.find(value => value.id === owner)?.sourceSlot).toBe(succession.desired!.slot.id);
    expect(ask.entryFor(bound, owner).record?.target?.nativeSessionId).toBe(target);
    const draft = ask.draftBinding(owner); expect(draft.store.get(draft.key)).toBe(`Ask draft for ${target}`);
  };
  assertAsk('T');
  await clickView('Independent B');
  await settleApp(() => { expect(succession.desired!.slot.id).toBe(independent.id); expect(succession.isCurrent()).toBe(true); });
  expect(primary().querySelector('[data-testid="prompt-input"]')?.textContent).toBe('Independent B draft'); assertAsk('U');
  expect(succession.document.address).toBe(independent.id); expect(succession.binding!.client).toBe(originalClient);
  await clickView('Retained primary');
  await settleApp(() => { expect(succession.desired!.slot.id).toBe(originalSlot); expect(succession.isCurrent()).toBe(true); });
  expect(primary().querySelector('[data-testid="prompt-input"]')?.textContent).toBe('A local draft'); assertAsk('T');
  expect(succession.binding!.client).toBe(originalClient);
  await clickView('Independent B');
  await settleApp(() => { expect(succession.desired!.slot.id).toBe(independent.id); expect(succession.isCurrent(), succession.error).toBe(true); });
  expect(f.requests.filter(item => item.url.endsWith('/attach')).map(item => item.body?.nativeSessionId)).toEqual(['B']);
  await act(async () => { f.chain.push(committed('B', 'C', 3)); f.notify(f.chain[1]!); });
  await settleApp(() => expect(succession.document.roles[0]?.appliedRevision).toBe(3));
  expect(succession.desired!.slot.id).toBe(independent.id); expect(succession.binding!.session.nativeSessionId).toBe('B'); assertAsk('U');
  await clickView('Retained primary');
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('C'));
  expect(succession.desired!.slot.id).toBe(originalSlot); assertAsk('T');
  expect(primary().querySelector('[data-testid="prompt-input"]')?.textContent).toBe('A local draft');
  expect(f.requests.filter(item => item.url.endsWith('/attach')).map(item => item.body?.nativeSessionId)).toEqual(['B', 'C']);
  expect(f.frames.filter(frame => frame.message && ['send_message', 'execute_command', 'image_upload_begin'].includes(frame.message.type))).toEqual([]);
});

it.each(['missing', 'mismatched'])('rejects an explicit %s view without a native fallback or retry attachment', async kind => {
  const real = successionHooks.useSessionSuccession;
  let succession!: ReturnType<typeof real>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  const f = await failureFixture(false, 'B');
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('B'));
  const id = kind === 'missing' ? 'missing-slot' : succession.desired!.slot.id;
  await act(async () => { expect(await succession.open({ hostId: 'host', providerId: 'recorded', nativeSessionId: kind === 'missing' ? 'B' : 'D', title: 'Rejected view' }, undefined, undefined, id)).toBe(true); });
  expect(succession.error).toContain('no longer matches'); expect(succession.binding).toBeUndefined();
  await act(async () => succession.retry());
  await settleApp(() => expect(succession.discovering).toBe(false));
  expect(succession.binding).toBeUndefined();
  expect(f.requests.filter(item => item.url.endsWith('/attach')).map(item => item.body?.nativeSessionId)).toEqual(['B']);
});

it('reselecting an explicitly failed view retains its error until Retry', async () => {
  const real = successionHooks.useSessionSuccession;
  let succession!: ReturnType<typeof real>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  const f = await failureFixture();
  await settleApp(() => expect(succession.error).toBe('Fixture successor unavailable.'));
  const id = succession.desired!.slot.id, target = succession.selected!;
  await act(async () => { expect(await succession.open(target, undefined, undefined, id)).toBe(true); });
  expect(succession.error).toBe('Fixture successor unavailable.');
  expect(f.requests.filter(item => item.url.endsWith('/attach'))).toHaveLength(1);
  f.setNativeIdentity('B');
  await act(async () => succession.retry());
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('B'));
  expect(f.requests.filter(item => item.url.endsWith('/attach'))).toHaveLength(2);
});

it.each([false, true])('restores the legacy Side primary without overriding explicit history intent %s', async history => {
  const real = successionHooks.useSessionSuccession;
  let succession!: ReturnType<typeof real>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  await failureFixture(false, 'B', false, history ? '&intent=history' : '', { selected: 'B', seed(scope, source) {
    const side = { ...source, nativeSessionId: 'B', agentId: 'agent-B', title: 'Side B' };
    localStorage.setItem(`agent-remote-opened:${scope}`, JSON.stringify([source, side]));
    saveSessionComposition(scope, { path: [source, side], focus: sessionKey(side), anchor: sessionKey(source), addressKey: sessionKey(side) });
  } });
  await settleApp(() => { expect(succession.binding?.session.nativeSessionId).toBe('B'); expect(succession.isCurrent()).toBe(true); });
  expect(succession.desired?.slot.intent.kind).toBe(history ? 'history' : 'role');
  if (!history) expect(succession.desired?.slot.owners.text.key).toBe('agent-A');
});

it.each(['B', 'D'])('restores the selected Window owner while a new %s Window keeps independent owners', async selected => {
  const real = successionHooks.useSessionSuccession, realManager = managerComponents.ChatSessionManager;
  let succession!: ReturnType<typeof real>, manager!: ComponentProps<typeof realManager>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  vi.spyOn(managerComponents, 'ChatSessionManager').mockImplementation(props => { manager = props; return realManager(props); });
  const f = await failureFixture(false, 'B', false, '', { seed(scope, source) {
    const independent = { ...source, nativeSessionId: 'B', agentId: 'agent-B', title: 'Independent B' };
    localStorage.setItem(`agent-remote-opened:${scope}`, JSON.stringify([source, independent]));
    saveSessionComposition(scope, { path: [source, independent], focus: sessionKey(independent), anchor: sessionKey(source), addressKey: sessionKey(independent) });
    const draft = new DraftStore(scope); draft.set(independent.agentId, 'Independent B draft'); draft.flush();
  } });
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('B'));
  const slot = succession.document.slots.find(value => value.owners.text.key === 'agent-B')!;
  const primarySlot = succession.desired!.slot.id, owners = structuredClone(slot.owners), askOwner = succession.ownerFor(slot.id);
  await act(async () => manager.onOpenView!({ slotId: slot.id, session: { hostId: 'host', providerId: 'recorded', nativeSessionId: 'B', title: 'Independent B' } }));
  await settleApp(() => expect(succession.document.focus).toBe(slot.id));
  const originalUrl = window.location.href, windowId = new URL(originalUrl).searchParams.get('window');
  const sideDraft = () => f.view.querySelector('.lab-side-conversation [data-testid="prompt-input"]')?.textContent;
  expect(sideDraft()).toBe('Independent B draft');
  expect(readCompositionDocument(f.scope)).toMatchObject({ status: 'ready', document: { address: slot.id } });
  await f.reload();
  await settleApp(() => { expect(succession.document.focus).toBe(slot.id); expect(sideDraft()).toBe('Independent B draft'); });
  expect(succession.document.slots.find(value => value.id === slot.id)?.owners).toEqual(owners);
  expect(succession.ownerFor(slot.id)).toBe(askOwner);
  await f.reload(selected);
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe(selected));
  expect(new URL(window.location.href).searchParams.get('window')).not.toBe(windowId);
  expect(succession.desired?.slot.id).not.toBe(slot.id); expect(succession.desired?.slot.id).not.toBe(primarySlot);
  expect(succession.desired?.slot.owners.text).not.toEqual(owners.text);
  window.history.replaceState(null, '', originalUrl);
  await f.reload();
  await settleApp(() => { expect(succession.document.focus).toBe(slot.id); expect(sideDraft()).toBe('Independent B draft'); });
  expect(succession.ownerFor(slot.id)).toBe(askOwner);
  await act(async () => manager.onOpen({ hostId: 'host', providerId: 'recorded', nativeSessionId: 'B', title: 'Ordinary B' }));
  await settleApp(() => expect(succession.document.focus).toBe(primarySlot));
  expect(f.view.querySelector('.lab-primary-conversation [data-testid="prompt-input"]')?.textContent).toBe('A local draft');
});


it('reattaches a restored Side to its new runtime binding while preserving the view and draft owners', async () => {
  const real = successionHooks.useSessionSuccession;
  let succession!: ReturnType<typeof real>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  const f = await failureFixture(false, 'B', false, '', { seed(scope, source) {
    const side = { ...source, nativeSessionId: 'S', agentId: 'agent-S', title: 'Independent Side' };
    localStorage.setItem(`agent-remote-opened:${scope}`, JSON.stringify([source, side]));
    saveSessionComposition(scope, { path: [source, side], focus: sessionKey(side), anchor: sessionKey(source), addressKey: sessionKey(source) });
    const drafts = new DraftStore(scope); drafts.set(side.agentId, 'Side draft before runtime restart'); drafts.flush();
  } });
  await settleApp(() => expect(succession.layoutView()?.sides[0]?.agentId).toBe('agent-S'));
  const slot = succession.document.slots.find(value => value.intent.target.native.nativeSessionId === 'S')!;
  const owners = structuredClone(slot.owners), askOwner = succession.ownerFor(slot.id);
  f.rebind('S', 'restarted-side-binding');
  await f.reload();
  await settleApp(() => expect(succession.layoutView()?.sides[0]?.agentId).toBe('restarted-side-binding'));
  const restored = succession.document.slots.find(value => value.id === slot.id)!;
  expect(restored.owners).toEqual(owners); expect(succession.ownerFor(slot.id)).toBe(askOwner);
  expect(restored.metadata?.agentId).toBe('restarted-side-binding');
  expect(f.view.querySelector('.lab-side-conversation [data-testid="prompt-input"]')?.textContent).toBe('Side draft before runtime restart');
  expect(f.frames.filter(frame => frame.type === 'subscribe').map(frame => frame.agentId)).toContain('restarted-side-binding');
  expect(f.frames.filter(frame => frame.message && ['send_message', 'execute_command', 'image_upload_begin'].includes(frame.message.type))).toEqual([]);
});

it.each(['ordinary', 'Track'] as const)('leaves a focused unlinked Side through %s navigation and keeps its independent view', async navigation => {
  const real = successionHooks.useSessionSuccession, realManager = managerComponents.ChatSessionManager, realAttention = attentionHooks.useSessionAttention;
  let succession!: ReturnType<typeof real>, manager!: ComponentProps<typeof realManager>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  vi.spyOn(managerComponents, 'ChatSessionManager').mockImplementation(props => { manager = props; return realManager(props); });
  vi.spyOn(attentionHooks, 'useSessionAttention').mockImplementation((...args) => ({ ...realAttention(...args), trackVisible: true }));
  let target!: OpenedSession, side!: OpenedSession, store!: ForkStore, recordId!: string;
  const f = await failureFixture(false, 'B', false, '', { chain: [], userScoped: navigation === 'Track', seed(scope, source) {
    target = { ...source, nativeSessionId: 'D', agentId: 'agent-D', title: 'New primary D' };
    side = { ...source, nativeSessionId: 'S', agentId: 'agent-S', title: 'Side S' };
    localStorage.setItem(`agent-remote-opened:${scope}`, JSON.stringify([source, target, side]));
    saveTrackedSessions(scope, [target, side].map((session, index) => ({ ...session, hostId: 'host', starredAt: index + 1 })));
    const drafts = new DraftStore(scope); drafts.set(side.agentId, 'Independent S draft'); drafts.flush();
    store = new ForkStore(scope);
    const record = store.prepare(referenceForkContext(source), { sourceNativeSessionId: source.nativeSessionId });
    recordId = record.id;
    store.bind(record.id, side); store.markConfigured(record.id); store.finishCreation(record.id);
  } });
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('A'));
  await act(async () => f.view.querySelector<HTMLButtonElement>('.lab-primary-conversation .lab-fork-entry > button')!.click());
  await settleApp(() => expect(new URL(window.location.href).searchParams.get('session')).toBe('S'));
  const slot = succession.document.slots.find(value => value.owners.text.key === side.agentId)!;
  const owners = structuredClone(slot.owners), askOwner = succession.ownerFor(slot.id);
  const sharedWindow = new URL(window.location.href).searchParams.has('window');
  const independent = () => f.view.querySelector('[aria-label="Session: Side S"]');
  await act(async () => {
    store.setLinked(recordId, false);
    window.dispatchEvent(new StorageEvent('storage', { key: `agent-remote-forks:${f.scope}:navigation:${recordId}` }));
  });
  await settleApp(() => {
    expect(f.view.querySelector('.lab-side-conversation:not([hidden]) .lab-side-close')).toBeNull();
    if (sharedWindow) expect(independent()?.querySelector('[data-testid="prompt-input"]')?.textContent).toBe('Independent S draft');
    else {
      expect(f.view.querySelector<HTMLElement>('.lab-primary-conversation')!.hidden).toBe(true);
      expect(f.view.querySelector('.lab-side-conversation:not([hidden]) [data-testid="prompt-input"]')?.textContent).toBe('Independent S draft');
    }
  });
  async function open(session: OpenedSession) {
    if (navigation === 'ordinary') await act(async () => manager.onOpen(session));
    else {
      await act(async () => f.view.querySelector<HTMLButtonElement>('[aria-label="Tracked sessions"]')!.click());
      await act(async () => [...f.view.querySelectorAll<HTMLButtonElement>('.lab-tracking-floating .lab-session-row')].find(row => row.textContent?.includes(session.title))!.click());
    }
    await settleApp(() => {
      expect(succession.binding?.session.nativeSessionId).toBe(session.nativeSessionId);
      expect(f.view.querySelector<HTMLElement>('.lab-primary-conversation')!.hidden).toBe(false);
      expect(new URL(window.location.href).searchParams.get('session')).toBe(session.nativeSessionId);
      expect(succession.document.primary).toBe(succession.binding!.session.viewId);
    });
  }
  await open(target);
  expect(f.view.querySelectorAll('.lab-side-conversation:not([hidden])')).toHaveLength(0);
  await open(side);
  if (sharedWindow) {
    expect(succession.binding?.session.viewId).not.toBe(slot.id);
    expect(succession.desired?.slot.owners).not.toEqual(owners);
    expect(independent()?.querySelector('[data-testid="prompt-input"]')?.textContent).toBe('Independent S draft');
    expect(succession.document.slots.find(value => value.id === slot.id)?.owners).toEqual(owners);
  } else {
    expect(succession.binding?.session.viewId).toBe(slot.id);
    expect(succession.desired?.slot.owners).toEqual(owners);
    expect(f.view.querySelector('.lab-primary-conversation [data-testid="prompt-input"]')?.textContent).toBe('Independent S draft');
  }
  expect(succession.ownerFor(slot.id)).toBe(askOwner);
  expect(store.get(recordId)?.linked).toBe(false);
  expect(f.frames.filter(frame => frame.message && ['send_message', 'execute_command', 'image_upload_begin'].includes(frame.message.type))).toEqual([]);
});

it('retries a transient composition import failure through the synchronization button and restores shared owners', async () => {
  const real = successionHooks.useSessionSuccession, realAsk = askHooks.useAskConversations;
  let succession!: ReturnType<typeof real>, askDocument!: Parameters<typeof realAsk>[0], rejectImport = true;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  vi.spyOn(askHooks, 'useAskConversations').mockImplementation((...args) => { askDocument = args[0]; return realAsk(...args); });
  const originalSet = Storage.prototype.setItem;
  let importWrites = 0;
  const f = await failureFixture(false, 'B', false, '', { chain: [], seed(scope, source) {
    saveTrackedSessions(scope, [{ ...source, hostId: 'host', starredAt: 1 }]);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function(this: Storage, key: string, value: string) {
      if (key === `agent-remote:recovery:${scope}:composition-v2`) {
        importWrites++;
        if (rejectImport) throw new Error('Temporary import storage failure');
      }
      originalSet.call(this, key, value);
    });
  } });
  await settleApp(() => expect(f.view.textContent).toContain('Saved session composition is unreadable or unsupported.'));
  const failedWrites = importWrites, fallback = succession.document;
  expect(f.requests.filter(request => request.url.endsWith('/attach'))).toHaveLength(0);
  rejectImport = false;
  await act(async () => [...f.view.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Retry synchronization')!.click());
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('A'));
  expect(importWrites).toBeGreaterThan(failedWrites);
  expect(succession.document).not.toBe(fallback);
  expect(askDocument).toBe(succession.document);
  expect(succession.error).toBeUndefined();
  expect(succession.desired?.slot.owners.text.key).toBe('agent-A');
  expect(succession.ownerFor(succession.binding!.session.viewId)).toBeDefined();
  expect(new TrackedSessionViews(succession.document, () => {}).entry(sessionKey(succession.binding!.session))?.slotId).toBe(succession.binding!.session.viewId);
  expect(readCompositionDocument(f.scope).status).toBe('ready');
  expect(new DraftStore(f.scope).get('agent-A')).toBe('A local draft');
  expect(f.view.querySelector('[data-testid="prompt-input"]')?.textContent).toBe('A local draft');
  expect(f.frames.filter(frame => frame.message && ['send_message', 'execute_command', 'image_upload_begin'].includes(frame.message.type))).toEqual([]);
  await f.reload();
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('A'));
  expect(succession.desired?.slot.owners.text.key).toBe('agent-A');
});

it('keeps post-upgrade view preferences and owners when opening the same Window in a new tab', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  const real = successionHooks.useSessionSuccession, realAsk = askHooks.useAskConversations, realManager = managerComponents.ChatSessionManager;
  let succession!: ReturnType<typeof real>, ask!: ReturnType<typeof realAsk>, manager!: ComponentProps<typeof realManager>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  vi.spyOn(askHooks, 'useAskConversations').mockImplementation((...args) => { ask = realAsk(...args); return ask; });
  vi.spyOn(managerComponents, 'ChatSessionManager').mockImplementation(props => { manager = props; return realManager(props); });
  const f = await failureFixture(false, 'B', false, '', { chain: [] });
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('A'));
  await act(async () => manager.onOpen({ hostId: 'host', providerId: 'recorded', nativeSessionId: 'D', title: 'Post-upgrade D' }));
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('D'));
  const windowId = new URL(window.location.href).searchParams.get('window')!;
  const original = structuredClone(succession.desired!.slot), owner = succession.ownerFor(original.id);
  await act(async () => ask.toggle(succession.binding!.session, owner));
  const primary = () => f.view.querySelector('.lab-primary-conversation')!;
  await act(async () => primary().querySelector<HTMLButtonElement>('[aria-label="Session view options"]')!.click());
  await act(async () => primary().querySelector<HTMLInputElement>('input[name^="session-display-"][value="content"]')!.click());
  await f.newTab('D', windowId);
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('D'));
  expect(succession.desired?.slot.id).toBe(original.id);
  expect(succession.desired?.slot.owners).toEqual(original.owners);
  expect(succession.ownerFor(original.id)).toBe(owner);
  expect(ask.isEnabled(succession.binding!.session, owner)).toBe(true);
  await act(async () => primary().querySelector<HTMLButtonElement>('[aria-label="Session view options"]')!.click());
  expect(primary().querySelector<HTMLInputElement>('input[name^="session-display-"][value="content"]')!.checked).toBe(true);
  expect(f.frames.filter(frame => frame.message && ['send_message', 'execute_command', 'image_upload_begin'].includes(frame.message.type))).toEqual([]);
});

it('keeps a synchronized native binding alive while composition replay is pending', async () => {
  const real = successionHooks.useSessionSuccession;
  let succession!: ReturnType<typeof real>, options!: Parameters<typeof real>[0];
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { options = args[0]; succession = real(...args); return succession; });
  const f = await failureFixture(false, 'B');
  const releaseAttach = f.holdAttach('B');
  let releaseCurrent = () => {};
  const nativeSetTimeout = globalThis.setTimeout;
  const deadlineSpy = vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) => {
    if (delay === 15000) return nativeSetTimeout(callback, 200, ...args);
    return nativeSetTimeout(callback, delay, ...args);
  });
  try {
    await settleApp(() => expect(f.requests.some(request => request.url.endsWith('/attach') && request.body?.nativeSessionId === 'B')).toBe(true));
    releaseCurrent = f.holdCurrent();
    const currentRequests = f.requests.filter(request => request.url.includes('/session-successions/current')).length;
    let outcome = 'pending', failure: unknown;
    await act(async () => { void succession.refreshCommitted('primary-op-2').then(() => { outcome = 'confirmed'; }, error => { outcome = 'failed'; failure = error; }); });
    await settleApp(() => expect(f.requests.filter(request => request.url.includes('/session-successions/current')).length).toBeGreaterThan(currentRequests));
    await act(async () => releaseAttach());
    const nativeConnection = () => options.connections.find({ hostId: 'host', providerId: 'recorded', nativeSessionId: 'B' });
    await settleApp(() => {
      expect(nativeConnection()?.replica.getState().agent?.runtimeInfo.sessionId).toBe('B');
      expect(nativeConnection()?.replica.getState().timeline.initialized).toBe(true);
      expect(nativeConnection()?.client.getSessionState().synchronized).toBe(true);
      expect(nativeConnection()?.client.getSessionState().runtime?.state).toBe('connected');
      expect(nativeConnection()?.client.getSessionState().controlChecking).toBe(false);
      expect(nativeConnection()?.client.getSessionState().recovering).toBe(false);
    });
    const synchronizedConnection = nativeConnection()!;
    deadlineSpy.mockRestore();
    expect(outcome).toBe('pending');
    expect(succession.binding).toBeUndefined();
    await act(async () => { await new Promise(resolve => nativeSetTimeout(resolve, 250)); });
    expect(succession.error).toBeUndefined();
    expect(outcome).toBe('pending');
    expect(nativeConnection()).toBe(synchronizedConnection);
    await act(async () => releaseCurrent());
    await settleApp(() => { expect(failure).toBeUndefined(); expect(outcome).toBe('confirmed'); });
    expect(succession.error).toBeUndefined();
    expect(succession.binding?.isCurrent()).toBe(true);
    expect(succession.binding?.client).toBe(synchronizedConnection.client);
    expect(succession.binding?.session.nativeSessionId).toBe('B');
    expect(succession.document.roles[0]?.appliedRevision).toBe(2);
    expect(f.requests.filter(request => request.url.endsWith('/attach') && request.body?.nativeSessionId === 'B')).toHaveLength(1);
  } finally { deadlineSpy.mockRestore(); releaseAttach(); releaseCurrent(); }
}, 10000);


it.each(['history', 'control', 'runtime'] as const)('keeps a matching session alive while %s is still recovering', async phase => {
  const real = successionHooks.useSessionSuccession;
  let succession!: ReturnType<typeof real>, options!: Parameters<typeof real>[0];
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { options = args[0]; succession = real(...args); return succession; });
  const nativeSetTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) =>
    nativeSetTimeout(callback, delay === 15000 ? 200 : delay, ...args));
  const f = await failureFixture(false, 'B', false, '', {
    holdTimelineInitially: phase === 'history', holdAccessInitially: phase === 'control',
    nativeConnection: phase === 'runtime' ? 'restoring' : 'connected',
  });
  const connection = () => options.connections.find({ hostId: 'host', providerId: 'recorded', nativeSessionId: 'B' });
  await settleApp(() => expect(connection()?.replica.getState().agent?.runtimeInfo.sessionId).toBe('B'));
  const initial = connection()!;
  await act(async () => { await new Promise(resolve => nativeSetTimeout(resolve, 300)); });
  expect(succession.error).toBeUndefined();
  expect(succession.binding).toBeUndefined();
  expect(succession.sessionState.synchronized).toBe(false);
  expect(succession.sessionState.operations.send_message.allowed).toBe(false);
  expect(succession.imageRecipient).toBeUndefined();
  expect(succession.sessionState.connection).toBe(initial.client.getSessionState().connection);
  if (phase === 'control') expect(succession.sessionState.controlChecking).toBe(true);
  if (phase === 'runtime') expect(succession.sessionState.runtime?.state).toBe('restoring');
  if (phase === 'history') expect(succession.sessionState.connection).toBe('catching_up');
  await editVisiblePrompt(f.view, 'Keep this draft while recovering');
  expect(f.frames.filter(frame => frame.message && ['send_message', 'interaction_response', 'image_upload_begin'].includes(frame.message.type))).toEqual([]);
  await act(async () => { f.releaseTimeline(); f.releaseAccess(); f.updatesByAgent.get('agent-B')?.('B'); });
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('B'));
  expect(succession.error).toBeUndefined();
  expect(succession.binding?.client).toBe(initial.client);
  expect(f.view.querySelector('[data-testid="prompt-input"]')?.textContent).toBe('Keep this draft while recovering');
  expect(f.requests.filter(request => request.url.endsWith('/attach'))).toHaveLength(1);
});

it('reconnects automatically when the initial snapshot does not arrive before the public deadline', async () => {
  const real = successionHooks.useSessionSuccession;
  let succession!: ReturnType<typeof real>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  const nativeSetTimeout = globalThis.setTimeout;
  vi.spyOn(globalThis, 'setTimeout').mockImplementation((callback, delay, ...args) =>
    nativeSetTimeout(callback, delay === 15000 ? 150 : delay === 20000 ? 500 : delay, ...args));
  const f = await failureFixture(false, 'B', false, '', { holdSnapshotInitially: true });
  await settleApp(() => expect(f.frames.some(frame => frame.type === 'subscribe' && frame.agentId === 'agent-B')).toBe(true));
  await settleApp(() => expect(succession.sessionState.connection).toBe('disconnected'));
  expect(succession.error).toBeUndefined();
  expect(succession.binding).toBeUndefined();
  expect(succession.sessionState.operations.send_message.allowed).toBe(false);
  await act(async () => f.releaseSnapshot());
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('B'));
  expect(succession.error).toBeUndefined();
  expect(f.frames.filter(frame => frame.type === 'subscribe' && frame.agentId === 'agent-B').length).toBeGreaterThanOrEqual(2);
  expect(f.requests.filter(request => request.url.endsWith('/attach'))).toHaveLength(1);
});

it('clears an identity error as soon as a matching snapshot arrives while history is still pending', async () => {
  const real = successionHooks.useSessionSuccession;
  let succession!: ReturnType<typeof real>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  const f = await failureFixture(false, 'wrong-native', false, '', { holdTimelineInitially: true });
  await settleApp(() => expect(succession.error).toBe('The native session identity could not be confirmed.'));
  expect(succession.binding).toBeUndefined();
  expect(succession.sessionState.operations.send_message.allowed).toBe(false);
  await act(async () => f.updatesByAgent.get('agent-B')?.('B'));
  await settleApp(() => expect(succession.error).toBeUndefined());
  expect(succession.binding).toBeUndefined();
  expect(succession.sessionState.operations.send_message.allowed).toBe(false);
  await act(async () => f.releaseTimeline());
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('B'));
  expect(f.requests.filter(request => request.url.endsWith('/attach'))).toHaveLength(1);
});

it('retires a slow attachment when navigating away and ignores its late identity updates', async () => {
  const real = successionHooks.useSessionSuccession;
  let succession!: ReturnType<typeof real>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  const f = await failureFixture(false, 'B', false, '', { holdTimelineInitially: true });
  await settleApp(() => expect(f.updatesByAgent.has('agent-B')).toBe(true));
  expect(succession.binding).toBeUndefined();
  await act(async () => succession.open({ hostId: 'host', providerId: 'recorded', nativeSessionId: 'D', title: 'Other session' }));
  await settleApp(() => expect(f.updatesByAgent.has('agent-D')).toBe(true));
  await act(async () => { f.updatesByAgent.get('agent-B')?.('wrong-native'); f.releaseTimeline(); });
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('D'));
  expect(succession.error).toBeUndefined();
  expect(succession.selected?.nativeSessionId).toBe('D');
  expect(f.frames.filter(frame => frame.message && ['send_message', 'interaction_response', 'image_upload_begin'].includes(frame.message.type))).toEqual([]);
});

it('follows an Ask native prefix with an execution recipient while preserving the association anchor', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  const realAsk = askHooks.useAskConversations, realSuccession = successionHooks.useSessionSuccession;
  let ask!: ReturnType<typeof realAsk>, succession!: ReturnType<typeof realSuccession>;
  vi.spyOn(askHooks, 'useAskConversations').mockImplementation((...args) => { ask = realAsk(...args); return ask; });
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = realSuccession(...args); return succession; });
  const prefix = committed('X', 'Y', 2, 'ask');
  const preparation = { kind: 'native_prefix' as const, turnId: 'turn', messageId: 'message' };
  prefix.projection.receipt.preparation = preparation; prefix.projection.receipt.prepared!.preparation = preparation;
  let anchor!: OpenedSession, original!: OpenedSession;
  const f = await failureFixture(false, 'B', false, '', { chain: [committed(), prefix], seed(scope, source) {
    original = source; anchor = { ...source, nativeSessionId: 'X', agentId: 'agent-X', title: 'Ask X' };
    const store = new ForkStore(`ask:${scope}`, sessionStorage);
    const record = store.prepare(referenceForkContext(source), { sourceNativeSessionId: source.nativeSessionId });
    store.bind(record.id, anchor); store.markConfigured(record.id); store.finishCreation(record.id);
  } });
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('B'));
  const owner = succession.ownerFor(succession.desired!.slot.id);
  await act(async () => { await ask.open(undefined, succession.binding!.session, '', false, { associationOwner: owner }); });
  await settleApp(() => expect(succession.recipientFor(anchor, owner)?.isCurrent()).toBe(true));
  expect(succession.recipientFor(anchor, owner)?.identity).toContain('agent-Y');
  expect(ask.entryFor(original, owner).record?.target).toEqual(anchor);
  expect(ask.entryFor(original, owner).record?.source).toEqual(original);
  expect(f.requests.filter(request => request.url.endsWith('/attach')).some(request => request.body?.nativeSessionId === 'X')).toBe(false);
  expect(succession.binding?.session.nativeSessionId).toBe('B');
  expect(f.frames.some(frame => frame.message?.type === 'send_message')).toBe(false);
}, 10000);

it('fences a warm Team main view immediately when its public execution locator disappears', async () => {
  const real = successionHooks.useSessionSuccession;
  let succession!: ReturnType<typeof real>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  const interval = globalThis.setInterval;
  vi.spyOn(globalThis, 'setInterval').mockImplementation(((callback: TimerHandler, delay?: number, ...args: unknown[]) => interval(callback, delay === 4000 ? 50 : delay, ...args)) as typeof setInterval);
  let team: Team = { id: 'team', operationId: 'create', revision: 1, title: 'Team', status: 'active', source: { hostId: 'host', providerId: 'recorded', nativeSessionId: 'main', title: 'Main' },
    members: [{ id: 'leader', hostId: 'host', providerId: 'recorded', nativeSessionId: 'A', role: 'leader', name: 'Leader', responsibility: '', creation: 'ready', activity: 'idle', summary: '', updatedAt: 1 }], messages: [], createdAt: 1, updatedAt: 1 };
  const f = await failureFixture(false, 'A', false, '', { chain: [], teams: () => [team] });
  await settleApp(() => expect(succession.binding?.isCurrent()).toBe(true));
  await act(async () => {
    succession.desired!.slot.metadata = { ...succession.desired!.slot.metadata!, teamId: 'team', teamMemberId: 'leader' };
    succession.save();
  });
  const recipient = succession.imageRecipient!;
  expect(recipient.isCurrent()).toBe(true);
  team = { ...team, revision: 2, members: [{ ...team.members[0]!, nativeSessionId: undefined }] };
  await settleApp(() => expect(recipient.isCurrent()).toBe(false));
  expect(succession.isCurrent()).toBe(false);
  expect(f.view.textContent).toContain('no current execution locator');
  expect(f.view.querySelector('.lab-primary-conversation [data-prompt-edit-action]')).toBeNull();
  expect(f.frames.some(frame => frame.message?.type === 'send_message')).toBe(false);
  team = { ...team, revision: 3, members: [{ ...team.members[0]!, nativeSessionId: 'A' }] };
  await settleApp(() => expect(succession.imageRecipient?.isCurrent()).toBe(true));
  expect(recipient.isCurrent()).toBe(false);
  expect(succession.imageRecipient).not.toBe(recipient);
}, 10000);

it.each(['A', 'B'].flatMap(initial => ['native preparation', 'selected resources'].map(stage => ({ initial, stage }))))
('fences shared prompt editing from $initial after awaiting $stage over HTTP and WebSocket', async ({ initial, stage }) => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  const real = successionHooks.useSessionSuccession;
  let succession!: ReturnType<typeof real>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  let entered = false, release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; }); cleanups.push(release);
  const prompt: ProjectedTimelineEntry = { providerId: 'recorded', seqStart: 1, seqEnd: 1, timestamp: '2026-10-15T00:00:00Z', turnId: 'selected-turn', collapsed: [], sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }],
    resources: stage === 'selected resources' ? [{ locator: '/selected.png', resourceId: 'selected-image', status: 'available' }] : [],
    item: { type: 'user_message', messageId: 'selected-message', text: 'Original selected prompt', ...(stage === 'selected resources' ? { content: [{ type: 'text', text: 'Original selected prompt' }, { type: 'image', locator: '/selected.png', label: 'image #1' }] } : {}) } };
  const description: SuccessionDescription = { role: { id: 'primary', revision: initial === 'A' ? 1 : 2, origin: native('A'), current: native(initial), workspace: { controllerId: 'installation', canonicalCwd: '/fixture' } },
    targets: [{ providerId: 'recorded', displayName: 'Recorded' }], eligibility: { status: 'ready' } };
  if (stage === 'selected resources') {
    const prepare = remoteReact.preparePromptDraft;
    vi.spyOn(remoteReact, 'preparePromptDraft').mockImplementation(async (...args) => { const value = await prepare(...args); entered = true; await gate; return value; });
  }
  const f = await failureFixture(false, 'B', false, '', { chain: initial === 'A' ? [] : [committed()], timeline: [prompt], persistPrompt: true,
    successionDescription: description, async successionPrepare(body) {
      entered = true; await gate;
      return { role: description.role, record: { operationId: String(body.operationId), roleId: 'primary', expectedRevision: description.role.revision,
        from: native(initial), to: native('S'), targetProviderId: 'recorded', preparation: body.preparation as any, phase: 'ready', startedAt: 'now', updatedAt: 'now' } };
    } });
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe(initial));
  await settleApp(() => expect(f.view.querySelector('.lab-primary-conversation [data-prompt-edit-action]')).not.toBeNull());
  await act(async () => f.view.querySelector<HTMLButtonElement>('.lab-primary-conversation [data-prompt-edit-action]')!.click());
  await settleApp(() => expect(entered, f.view.textContent ?? '').toBe(true));
  const next = committed(initial, initial === 'A' ? 'B' : 'C', initial === 'A' ? 2 : 3); f.chain.push(next);
  await act(async () => f.notify(next));
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe(next.to!.nativeSessionId));
  await act(async () => release());
  if (stage === 'native preparation') {
    await settleApp(() => expect(f.view.textContent).toContain('Details'));
    await act(async () => [...f.view.querySelectorAll<HTMLButtonElement>('button')].find(button => button.textContent === 'Details')!.click());
  }
  await settleApp(() => expect(f.view.textContent).toMatch(/no longer ready|connection changed/));
  const prepared = f.requests.filter(request => request.url.endsWith('/succession/prepare'));
  expect(prepared).toHaveLength(stage === 'native preparation' ? 1 : 0);
  if (prepared[0]) {
    expect(prepared[0].body).toMatchObject({ nativeSessionId: initial, preparation: { kind: 'native_prefix', turnId: 'selected-turn', messageId: 'selected-message' } });
    const retained = Object.keys(sessionStorage).filter(key => key.includes(':prefix-edit:')).map(key => JSON.parse(sessionStorage.getItem(key)!));
    expect(retained).toEqual([expect.objectContaining({ operation: expect.objectContaining({ operationId: prepared[0].body!.operationId, nativeSessionId: initial }) })]);
  }
  expect(f.requests.filter(request => request.url.endsWith('/succession/commit') || request.url.endsWith('/create'))).toEqual([]);
  expect(f.frames.filter(frame => frame.message?.type === 'resource_request').map(frame => frame.message?.payload?.agentId)).toEqual(stage === 'selected resources' ? [`agent-${initial}`] : []);
  expect(f.frames.some(frame => ['send_message', 'execute_command', 'session_setting_request'].includes(frame.message?.type ?? ''))).toBe(false);
  expect(new URL(window.location.href).searchParams.get('session')).toBe(next.to!.nativeSessionId);
});

it.each(['legacy exact', 'legacy missing', 'explicit successor'] as const)('restores a cold managed Team window only from public roster evidence: %s', async mode => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  const team: Team = { id: 'team', operationId: 'create', revision: 1, title: 'Team', status: 'active', source: { hostId: 'host', providerId: 'recorded', nativeSessionId: 'A', title: 'Main' },
    members: [{ id: 'leader', hostId: 'host', providerId: 'recorded', nativeSessionId: mode === 'legacy missing' ? undefined : mode === 'explicit successor' ? 'Y' : 'X', role: 'leader', name: 'Leader', responsibility: '', creation: 'ready', activity: 'idle', summary: '', updatedAt: 1 }], messages: [], createdAt: 1, updatedAt: 1 };
  const prefix = committed('X', 'Y', 2, 'team-role');
  const preparation = { kind: 'native_prefix' as const, turnId: 'turn', messageId: 'message' };
  prefix.projection.receipt.preparation = preparation; prefix.projection.receipt.prepared!.preparation = preparation;
  const f = await failureFixture(false, 'A', false, '', { chain: mode === 'explicit successor' ? [prefix] : [], teams: () => [team], seed(scope, source) {
    const main = createCompositionSlot('main-slot', source, scope);
    const target = { ...source, nativeSessionId: 'X', agentId: 'agent-X', title: 'Saved Leader', ...(mode === 'explicit successor' ? { teamId: 'team', teamMemberId: 'leader' } : {}) };
    const member = createCompositionSlot('member-slot', target, scope);
    const document = createCompositionDocument(scope, [main, member]);
    document.asks = document.slots.map(slot => createAskOwner(slot, scope));
    document.windows = [{ id: 'member-window', slotId: member.id, managed: true, groupId: 'team' }];
    saveCompositionDocument(document, () => true); flushRecoveryWrites();
    const drafts = new DraftStore(scope); drafts.set(`session:${sessionKey(target)}`, 'Retained member draft'); drafts.flush();
  } });
  await settleApp(() => expect(f.view.querySelector('[data-view-id="member-window"]'), f.view.textContent ?? '').not.toBeNull());
  const panel = () => f.view.querySelector('[data-view-id="member-window"]')!;
  if (mode === 'legacy missing') {
    await settleApp(() => expect(panel().textContent).toContain('saved Team member identity is unavailable'));
    expect(f.requests.filter(request => request.url.endsWith('/attach')).some(request => request.body?.nativeSessionId === 'X')).toBe(false);
  } else {
    const expected = mode === 'explicit successor' ? 'Y' : 'X';
    await settleApp(() => expect(f.requests.filter(request => request.url.endsWith('/attach')).some(request => request.body?.nativeSessionId === expected)).toBe(true));
    await settleApp(() => expect(panel().querySelector('[data-testid="prompt-input"]')?.textContent).toBe('Retained member draft'));
    if (mode === 'explicit successor') expect(f.requests.filter(request => request.url.endsWith('/attach')).some(request => request.body?.nativeSessionId === 'X')).toBe(false);
  }
  expect(new URL(window.location.href).searchParams.get('session')).toBe('A');
  expect(f.frames.some(frame => frame.message?.type === 'send_message')).toBe(false);
}, 10000);

it('edits a real App managed Team window into its retained origin owner and admits input only to the successor', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  let team: Team = { id: 'team', operationId: 'create', revision: 1, title: 'Team', status: 'active', source: { hostId: 'host', providerId: 'recorded', nativeSessionId: 'A', title: 'Main' },
    members: [{ id: 'leader', hostId: 'host', providerId: 'recorded', nativeSessionId: 'X', role: 'leader', name: 'Leader', responsibility: '', creation: 'ready', activity: 'idle', summary: '', updatedAt: 1 }], messages: [], createdAt: 1, updatedAt: 1 };
  const chain: SessionSuccessionReplay[] = [], prefix = committed('X', 'Y', 2, 'team-role');
  const preparation = { kind: 'native_prefix' as const, turnId: 'selected-turn', messageId: 'selected-message' };
  prefix.projection.receipt.preparation = preparation; prefix.projection.receipt.prepared!.preparation = preparation;
  const description: SuccessionDescription = { role: { ...prefix.projection.role, revision: 1, current: native('X') }, targets: [{ providerId: 'recorded', displayName: 'Recorded' }], eligibility: { status: 'ready' } };
  const prompt: ProjectedTimelineEntry = { providerId: 'recorded', seqStart: 1, seqEnd: 1, timestamp: '2026-10-15T00:00:00Z', turnId: preparation.turnId, collapsed: [], resources: [], sourceSeqRanges: [{ startSeq: 1, endSeq: 1 }], item: { type: 'user_message', messageId: preparation.messageId, text: 'Selected member prompt' } };
  const textKey = `session:${JSON.stringify(['host', 'recorded', 'X'])}`;
  const f = await failureFixture(false, 'A', false, '', { chain, teams: () => [team], timeline: [prompt], persistPrompt: true, successionDescription: description,
    async successionPrepare(body) {
      prefix.projection.receipt.operationId = String(body.operationId); prefix.projection.receipt.prepared!.operationId = String(body.operationId);
      return { role: description.role, record: { ...prefix.projection.receipt, phase: 'ready', committedRevision: undefined } };
    }, successionCommit() {
      chain.push(prefix); team = { ...team, revision: 2, members: [{ ...team.members[0]!, nativeSessionId: 'Y' }] };
      return { role: prefix.projection.role, record: prefix.projection.receipt, locator: prefix.to };
    }, seed(scope, source) {
      const main = createCompositionSlot('main-slot', source, scope);
      const target = { ...source, nativeSessionId: 'X', agentId: 'agent-X', title: 'Leader', teamId: 'team', teamMemberId: 'leader' };
      const member = createCompositionSlot('member-slot', target, scope), document = createCompositionDocument(scope, [main, member]);
      document.asks = document.slots.map(slot => createAskOwner(slot, scope));
      document.windows = [{ id: 'member-window', slotId: member.id, managed: true, groupId: 'team', teamMemberId: 'leader' }];
      saveCompositionDocument(document, () => true); flushRecoveryWrites();
      const drafts = new DraftStore(scope); drafts.set(textKey, 'Existing member draft'); drafts.flush();
    } });
  const panel = () => f.view.querySelector('[data-view-id="member-window"]')!;
  await settleApp(() => expect(panel()?.querySelector('[data-testid="prompt-input"]')?.textContent).toBe('Existing member draft'));
  await settleApp(() => expect(panel().querySelector('[data-prompt-edit-action]')).not.toBeNull());
  await act(async () => panel().querySelector<HTMLButtonElement>('[data-prompt-edit-action]')!.click());
  await settleApp(() => expect(f.requests.filter(request => request.url.endsWith('/succession/commit'))).toHaveLength(1));
  await act(async () => f.notify(prefix));
  await vi.waitFor(async () => { await act(async () => { await new Promise(resolve => setTimeout(resolve, 30)); }); expect(panel().querySelector('.lab-handoff-notice')?.textContent ?? '').toBe(''); }, { timeout: 6000 });
  expect(panel().querySelector('[data-testid="prompt-input"]')?.textContent).toBe('Selected member prompt');
  expect(new DraftStore(f.scope).get(textKey)).toBe('Selected member prompt');
  expect(new DraftStore(f.scope).get(`session:${JSON.stringify(['host', 'recorded', 'Y'])}`)).toBe('');
  expect(f.frames.filter(frame => frame.message?.type === 'send_message')).toEqual([]);
  expect(f.requests.filter(request => request.url.endsWith('/succession/prepare'))).toHaveLength(1);
  expect(new URL(window.location.href).searchParams.get('session')).toBe('A');
  const button = panel().querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!;
  await act(async () => { button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })); button.click(); });
  await settleApp(() => expect(f.frames.filter(frame => frame.message?.type === 'send_message').map(frame => frame.message?.payload?.agentId)).toEqual(['agent-Y']));
  await settleApp(() => expect(panel().querySelector('[data-testid="prompt-input"]')?.textContent).toBe(''));
  expect(new DraftStore(f.scope).get(textKey)).toBe('');
  expect(new URL(window.location.href).searchParams.get('session')).toBe('A');
}, 10000);

it('persists adopted Window mappings across reload without changing native owners or Ask references', async () => {
  const real = successionHooks.useSessionSuccession;
  let succession!: ReturnType<typeof real>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  const f = await failureFixture(false, 'B');
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('B'));
  const slotId = succession.desired!.slot.id;
  const owners = structuredClone(succession.desired!.slot.owners);
  const askOwnerId = succession.ownerFor(slotId);
  const windowId = new URL(window.location.href).searchParams.get('window')!;
  await settleApp(() => {
    const read = readCompositionDocument(f.scope);
    expect(read.status).toBe('ready');
    if (read.status === 'ready') expect(read.document.windowBindings).toEqual(expect.arrayContaining([expect.objectContaining({ windowId, viewId: 'main', slotId })]));
  });
  await f.reload();
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('B'));
  expect(succession.desired!.slot.id).toBe(slotId);
  expect(succession.desired!.slot.owners).toEqual(owners);
  expect(succession.ownerFor(slotId)).toBe(askOwnerId);
  expect(f.view.querySelector('[data-testid="prompt-input"]')?.textContent).toBe('A local draft');
}, 10000);

it('restores an open Ask with its original source after rebinding main and opening a fresh page', async () => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} unobserve() {} });
  const real = successionHooks.useSessionSuccession, realAsk = askHooks.useAskConversations, realManager = managerComponents.ChatSessionManager;
  let succession!: ReturnType<typeof real>, ask!: ReturnType<typeof realAsk>, manager!: ComponentProps<typeof realManager>;
  vi.spyOn(successionHooks, 'useSessionSuccession').mockImplementation((...args) => { succession = real(...args); return succession; });
  vi.spyOn(askHooks, 'useAskConversations').mockImplementation((...args) => { ask = realAsk(...args); return ask; });
  vi.spyOn(managerComponents, 'ChatSessionManager').mockImplementation(props => { manager = props; return realManager(props); });
  const f = await failureFixture(false, 'B', false, '', { chain: [], seed(scope, source) {
    const store = new ForkStore(`ask:${scope}`, sessionStorage);
    const record = store.prepare(referenceForkContext(source), { sourceNativeSessionId: source.nativeSessionId });
    store.bind(record.id, { ...source, nativeSessionId: 'T', agentId: 'agent-T', title: 'Ask for A' });
    store.markConfigured(record.id); store.finishCreation(record.id);
  } });
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('A'));
  const sourceA = succession.binding!.session, ownerA = succession.ownerFor(sourceA.viewId);
  await act(async () => ask.toggle(sourceA, ownerA));
  await act(async () => f.view.querySelector<HTMLButtonElement>('[aria-label="Ask about this session"]')!.click());
  await settleApp(() => expect(ask.isOpen(sourceA, ownerA)).toBe(true));
  await settleApp(() => expect(f.view.querySelector('[role="dialog"][aria-label="Ask"] [data-testid="prompt-input"]')).not.toBeNull());
  const windowId = new URL(window.location.href).searchParams.get('window')!;
  await act(async () => manager.onOpen({ hostId: 'host', providerId: 'recorded', nativeSessionId: 'B', title: 'Main B' }));
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('B'));
  const sourceB = succession.binding!.session, ownerB = succession.ownerFor(sourceB.viewId);
  expect(ask.sharedView(ownerB)).toBeUndefined();
  expect(ask.entryFor(sourceB, ownerB).record?.target?.nativeSessionId).not.toBe('T');
  expect(ask.entryFor(sourceA, ownerA).record?.source.nativeSessionId).toBe('A');
  expect(ask.entryFor(sourceA, ownerA).record?.target?.nativeSessionId).toBe('T');
  await f.newTab('B', windowId);
  await settleApp(() => expect(succession.binding?.session.nativeSessionId).toBe('B'));
  await settleApp(() => expect(f.view.querySelectorAll('[role="dialog"][aria-label="Ask"]')).toHaveLength(1));
  const restoredOwners = succession.document.asks.filter(owner => ask.sharedView(owner.id));
  expect(restoredOwners).toHaveLength(1);
  const restoredSlot = succession.document.slots.find(slot => slot.id === restoredOwners[0]!.sourceSlot)!;
  expect(restoredSlot.intent.target.native.nativeSessionId).toBe('A');
  const currentOwner = succession.ownerFor(succession.binding!.session.viewId);
  expect(ask.sharedView(currentOwner)).toBeUndefined();
  expect(ask.entryFor(succession.binding!.session, currentOwner).record?.target?.nativeSessionId).not.toBe('T');
  expect(() => parseComposition(succession.document, f.scope)).not.toThrow();
  await act(async () => ask.toggle(succession.binding!.session, currentOwner));
  expect(f.view.querySelector('.lab-primary-conversation [aria-label="Ask about this session"]')).not.toBeNull();
  await act(async () => f.view.querySelector<HTMLButtonElement>('.lab-primary-conversation [aria-label="Ask about this session"]')!.click());
  await settleApp(() => expect(ask.entryFor(succession.binding!.session, currentOwner).record?.target?.nativeSessionId).toBe('S'));
  expect(f.requests.filter(request => request.url.endsWith('/create')).map(request => request.body?.sourceNativeSessionId)).toEqual(['B']);
  expect(f.view.querySelectorAll('[role="dialog"][aria-label="Ask"]')).toHaveLength(2);
  expect(ask.entryFor(sourceA, restoredOwners[0]!.id).record?.target?.nativeSessionId).toBe('T');
});
