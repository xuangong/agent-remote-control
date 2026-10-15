import 'fake-indexeddb/auto';
import { act, useRef, useState } from 'react';
import { Blob as NativeBlob } from 'node:buffer';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { AgentReplica, type RemoteAgentTransport, type RemoteTransportListener } from '@orchardworks/agent-remote-web';
import type { AgentSnapshot, ClientMessage, HistoryPage } from '@orchardworks/agent-remote-protocol';
import { inspectImageDraft, readImageDraft, type ImageDraftRecipient } from '@orchardworks/agent-remote-web/browser';
import { ConversationConnections, ConversationConnectionScope } from '../conversation-connections.js';
import { DraftStore } from '../draft-store.js';
import { readDrafts } from '../conversation-recovery.js';
import { ForkStore } from '../session-forks.js';
import { replicaState } from '../test/fixtures.js';
import { promptText, render, unmount } from '../test/setup.js';
import { SideConversation } from './SideConversation.js';
import { SessionWindow } from './SessionWindow.js';
import { SessionFamily } from './SessionFamily.js';
import { AskConversation } from './AskConversation.js';
import { TpmWorkspace } from './TpmWorkspace.js';
import { askParticipantKey } from '../hooks/useAskConversations.js';
import type { SessionFork } from '../session-forks.js';
import type { TpmItem } from '../hooks/useTpmWork.js';
import { SessionDirectoryClient, type OpenedSession, type SuccessionActionResult } from '../directory-client.js';
import { SessionViewOperationsContext } from '../session-view-operations.js';
import { LabWorkbench } from './LabWorkbench.js';
import { useConversationSession } from '../hooks/useConversationSession.js';
import { sessionViewNavigation } from '../session-view-navigation.js';

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

function fixture(images = false, unavailableImage = false) {
  const listeners = new Map<string, RemoteTransportListener>();
  const resourceRequests: string[] = [];
  const sent: Extract<ClientMessage, { type: 'send_message' }>[] = [];
  const snapshot = (id: string): AgentSnapshot => ({ protocolVersion: '1.8.0', type: 'agent_snapshot', payload: {
    ...replicaState.agent!, id, capabilities: { ...replicaState.agent!.capabilities,
      ...(images ? { imageInput: { mediaTypes: ['image/png'], maxImages: 8, maxImageBytes: 10485760, maxMessageBytes: 20971520 } } : {}) },
    runtimeInfo: { ...replicaState.agent!.runtimeInfo, sessionId: id },
  } });
  const page = (id: string): HistoryPage => ({ protocolVersion: '1.8.0', type: 'timeline_page', payload: {
    agentId: id, requestId: 'history', direction: 'tail', epoch: `epoch-${id}`, reset: false, staleCursor: false, gap: false,
    window: { minSeq: 1, maxSeq: 2, nextSeq: 3 }, startCursor: null, endCursor: null,
    entries: [1, 2].map(index => ({ providerId: 'recorded', turnId: `turn-${index}`, item: { type: 'user_message' as const, text: `Selected ${id} prompt ${index}`, messageId: `message-${index}`, ...(images ? { content: [{ type: 'text' as const, text: `Selected ${id} prompt ${index}` }, { type: 'image' as const, locator: '/selected.png', label: 'image #1', mediaType: 'image/png', sha256: 'image-sha' }] } : {}) }, resources: images ? [{ locator: '/selected.png', resourceId: 'selected-image', status: 'available' as const }] : [], timestamp: '2026-10-15T00:00:00Z', seqStart: index, seqEnd: index, sourceSeqRanges: [{ startSeq: index, endSeq: index }], collapsed: [] })), hasOlder: false, hasNewer: false, error: null,
  } });
  const transport: RemoteAgentTransport = {
    fetchSnapshot: async id => snapshot(id), fetchTimeline: async id => page(id),
    onDiagnostic: () => () => {}, onProtocolMessage: () => () => {},
    connect(id, listener) {
      listeners.set(id, listener);
      queueMicrotask(() => { listener.onOpen(); listener.onMessage(snapshot(id)); });
      return { close() {}, send(message) {
        if (message.type === 'negotiate') {
          listener.onMessage({ protocolVersion: '1.8.0', type: 'negotiated', sessionControl: true });
          listener.onMessage({ protocolVersion: '1.8.0', type: 'session_control', payload: { agentId: id, revision: 'control', access: 'control', available: false, token: 'token' } });
        }
        if (message.type === 'session_control_request') listener.onMessage({ protocolVersion: '1.8.0', type: 'session_control', payload: { agentId: id, requestId: message.payload.requestId, revision: 'control', access: 'control', available: false, token: 'token' } });
        if (message.type === 'timeline_subscription') listener.onMessage({ protocolVersion: '1.8.0', type: 'timeline_subscribed', payload: { requestId: message.payload.requestId, agentIds: [id] } });
        if (message.type === 'send_message') sent.push(message);
        if (message.type === 'resource_request') {
          resourceRequests.push(id);
          listener.onMessage({ protocolVersion: '1.8.0', type: 'resource_response', payload: { agentId: id, requestId: message.payload.requestId, resourceId: message.payload.resourceId,
            state: unavailableImage ? { status: 'unavailable', reason: 'Removed' } : { status: 'available', mediaType: 'image/png', byteLength: 10, sha256: 'image-sha', contentBase64: btoa('test bytes') } } });
        }
        if (message.type === 'image_upload_begin') listener.onMessage({ protocolVersion: '1.8.0', type: 'image_upload_result', payload: {
          requestId: message.payload.requestId, agentId: id, uploadId: message.payload.uploadId, offset: message.payload.byteLength,
          attachment: { attachmentId: `image-${id}`, sha256: message.payload.sha256, byteLength: message.payload.byteLength, mediaType: message.payload.mediaType, imageDimensions: { width: 1, height: 1 } },
        } });
      } };
    },
  };
  return { transport, sent, listeners, snapshot, resourceRequests, acknowledge(message = sent.at(-1)!) {
    listeners.get(message.payload.agentId)!.onMessage({ protocolVersion: '1.8.0', type: 'command_acknowledged', payload: {
      agentId: message.payload.agentId, requestId: message.payload.requestId, command: 'send_message',
    } });
  }, reject(message = sent.at(-1)!) {
    listeners.get(message.payload.agentId)!.onMessage({ protocolVersion: '1.8.0', type: 'protocol_error', payload: {
      requestId: message.payload.requestId, code: 'agent_busy', message: 'The native session rejected this input.', recoverable: true,
    } });
  }, echo(message = sent.at(-1)!) {
    listeners.get(message.payload.agentId)!.onMessage({ protocolVersion: '1.8.0', type: 'agent_stream', payload: {
      agentId: message.payload.agentId, epoch: `epoch-${message.payload.agentId}`, seq: 1, timestamp: '2026-10-15T00:00:00Z',
      event: { type: 'timeline', providerId: 'recorded', item: { type: 'user_message', text: 'text' in message.payload ? message.payload.text : 'Image input' }, resources: [] },
    } });
  } };
}

const promptEditor = (view: ParentNode) => view.querySelector<HTMLElement>('[data-testid="prompt-input"]')!;
type Placement = 'main' | 'side' | 'window' | 'team-leader' | 'team-member' | 'compact-leader' | 'compact-member' | 'child' | 'ask' | 'tpm';
async function setupEdit(kind: Placement, options: { outcome?: 'ready' | 'unknown' | 'rejected' | 'cancelled'; holdCommit?: boolean; holdPrepare?: boolean; commitBoundaryChanged?: boolean; explicitRecipient?: boolean; unavailable?: boolean; historical?: boolean; images?: boolean; unavailableImage?: boolean } = {}) {
  const f = fixture(options.images, options.unavailableImage);
  let recipientCurrent = true;
  const explicitRecipient: ImageDraftRecipient = { identity: 'explicit-A', lifetime: {}, isCurrent: () => recipientCurrent };
  const scope = `http://fixture/${crypto.randomUUID()}/`;
  const drafts = new DraftStore(scope), draftBinding = { store: drafts, key: 'selected-owner' };
  const imageDraftBinding = { scope, key: `${scope}selected-images` };
  const session: OpenedSession & { hostId: string } = { hostId: 'local', agentId: 'A', providerId: 'recorded', nativeSessionId: 'A', title: 'Supporting A' };
  const connections = new ConversationConnections(f.transport);
  const lease = connections.acquire('A', new AgentReplica(), session);
  const unrelated = connections.acquire('unrelated-main', new AgentReplica(), { ...session, nativeSessionId: 'unrelated-main' });
  const requests: Array<{ path: string; body: any }> = [];
  let outcome = options.outcome ?? 'ready';
  let releaseCommit: () => void = () => {};
  let releasePrepare: () => void = () => {};
  const prepareGate = options.holdPrepare ? new Promise<void>(resolve => { releasePrepare = resolve; }) : undefined;
  const commitGate = options.holdCommit ? new Promise<void>(resolve => { releaseCommit = resolve; }) : undefined;
  let native = 'A';
  let setEnabled!: (enabled: boolean) => void;
  let operation: any, setCurrent!: (value: string) => void;
  const ref = (id: string) => ({ controllerId: 'controller', providerId: 'recorded', nativeSessionId: id });
  const role = { id: 'role', revision: 1, origin: ref('A'), current: ref('A'), workspace: { controllerId: 'controller', canonicalCwd: '/fixture' } };
  const result = (phase: 'ready' | 'committed' | 'unknown' | 'rejected' | 'cancelled'): SuccessionActionResult => ({ role: phase === 'committed' ? { ...role, revision: operation.expectedRevision + 1, current: ref(operation.nativeSessionId === 'A' ? 'B' : 'C') } : role,
    record: { operationId: operation.operationId, expectedRevision: operation.expectedRevision, targetProviderId: operation.targetProviderId, preparation: operation.preparation, roleId: 'role', from: ref(operation.nativeSessionId), phase, to: ref(operation.nativeSessionId === 'A' ? 'B' : 'C'), startedAt: 'now', updatedAt: 'now', ...(phase === 'committed' ? { committedRevision: operation.expectedRevision + 1 } : {}) },
    ...(phase === 'committed' ? { locator: { hostId: 'local', providerId: 'recorded', nativeSessionId: operation.nativeSessionId === 'A' ? 'B' : 'C' } } : {}) });
  const fetcher: typeof fetch = async (input, init) => {
    const path = new URL(String(input)).pathname, body = JSON.parse(String(init?.body ?? '{}')); requests.push({ path, body });
    if (path.endsWith('/commit')) {
      await commitGate;
      if (options.commitBoundaryChanged) return new Response(JSON.stringify({ code: 'succession_boundary_changed', error: 'succession_boundary_changed: The Host timeline epoch changed.' }), { status: 409 });
    }
    if (path.endsWith('/prepare')) await prepareGate;
    const data = path.endsWith('/describe') ? { role: { ...role, current: ref(native), revision: native === 'A' ? 1 : 2 }, targets: [{ providerId: 'recorded', displayName: 'Recorded' }], eligibility: options.unavailable ? { status: 'unavailable', code: 'unsupported', reason: 'This provider does not support native prefix editing.' } : { status: 'ready' } }
      : path.endsWith('/prepare') ? (operation = body, result(outcome))
      : path.endsWith('/commit') ? result('committed') : path.endsWith('/status') ? result(outcome)
      : path.endsWith('/cancel') ? result('cancelled') : path.endsWith('/reconcile') ? result(outcome)
      : path.endsWith('/attach') ? { agentId: body.nativeSessionId, nativeSessionId: body.nativeSessionId } : {};
    return new Response(JSON.stringify(data), { status: 200, headers: { 'content-type': 'application/json' } });
  };
  vi.stubGlobal('fetch', fetcher);
  function Main() {
    const view = useConversationSession(session, f.transport);
    return <LabWorkbench state={view.state} sessionState={view.sessionState} sessionStatus={view.status} actions={view.actions} operationBinding={view.operationBinding}
      draftBinding={draftBinding} imageDraftBinding={imageDraftBinding} imageRecipient={options.explicitRecipient ? explicitRecipient : view.imageRecipient} draftSessionKey="main-draft" />;
  }
  function Harness() {
    const [current, update] = useState(native); setCurrent = update;
    const [enabled, updateEnabled] = useState(true); setEnabled = updateEnabled;
    const trigger = useRef<HTMLButtonElement>(null);
    const family = { storageScope: scope, baseUrl: scope, target: kind === 'child' ? { ...session, parentNativeSessionId: 'parent' } : session,
      transport: f.transport, draftStore: drafts, draftBinding, imageDraftBinding, hostLabel: 'Local', offline: false, active: true, compact: kind.startsWith('compact-') };
    const record: SessionFork = { id: 'ask-record', mode: 'reference', source: { ...session, nativeSessionId: 'unrelated-main' }, target: session,
      capturedAt: 'now', delivery: 'sent', configured: true, options: {}, settings: [] };
    const item: TpmItem = { key: 'work', hostId: 'local', hostName: 'Local', online: true, unread: false, work: { id: 'work', revision: 1, title: 'Work', providerId: 'recorded', mainNativeSessionId: 'unrelated-main', tpmNativeSessionId: 'A', phase: 'implementing', waiting: 'none', paused: false, summary: '', nextAction: '', document: '', acceptance: '', evidence: [], createdAt: 'now', updatedAt: 'now', nextCheckAt: 0, outbox: [] } };
    return <SessionViewOperationsContext.Provider value={{ storageScope: scope, transport: f.transport, enabled,
      resolveTarget: source => ({ target: 'parentNativeSessionId' in source && source.parentNativeSessionId ? source : { ...source, nativeSessionId: current }, ...(options.historical ? { historyRoleId: 'history-role' } : {}) }),
      directory: () => new SessionDirectoryClient(scope, fetcher), refreshSettled: async result => { if (result.record.phase === 'committed') { native = result.record.to!.nativeSessionId; update(native); } } }}><ConversationConnectionScope.Provider value={connections}>
      {kind === 'main' ? <Main /> : kind === 'side' ? <SideConversation session={session} transport={f.transport} store={new ForkStore(scope)} draftBinding={draftBinding} imageDraftBinding={imageDraftBinding}
        onClose={() => {}} onOpenSource={() => {}} onOpenFork={() => {}} onFork={async () => ({})} />
      : kind === 'ask' ? <AskConversation entry={{ source: record.source, record, attached: true, attachedParticipant: askParticipantKey(record) }} transport={f.transport}
        draftBinding={draftBinding} imageDraftBinding={imageDraftBinding} triggerRef={trigger} storageScope={scope} onClose={() => {}} onToggleEnabled={() => {}} onClean={() => {}} onRetry={() => {}} onSendInput={() => {}} onDiscardInput={() => {}} />
      : kind === 'tpm' ? <TpmWorkspace session={session} item={item} visible storageScope={scope} triggerRef={trigger} transport={f.transport} draftBinding={draftBinding}
        onClose={() => {}} onShowList={() => {}} onOpenMain={() => {}} onAction={async () => {}} onResolve={async () => {}} onRetry={() => {}} />
      : kind.startsWith('compact-') || kind === 'child' ? <SessionFamily {...family} />
      : <SessionWindow entry={{ id: 'window', slotId: 'slot', managed: kind.startsWith('team-'), target: session }} baseUrl={scope} visible compact={false} hostLabel="Local" offline={false}
        transport={f.transport} draftStore={drafts} draftBinding={draftBinding} imageDraftBinding={imageDraftBinding} navigation={(source, state) => sessionViewNavigation({ source, state, entries: [] })} onFocus={() => {}} onClose={() => {}} />}
    </ConversationConnectionScope.Provider></SessionViewOperationsContext.Provider>;
  }
  const view = await render(<Harness />); lease.release(); unrelated.release();
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  return { ...f, view, requests, drafts, draftBinding, imageDraftBinding, connections, retireRecipient() { recipientCurrent = false; }, setCurrent, setEnabled, releaseCommit, releasePrepare, setOutcome(value: typeof outcome) { outcome = value; }, async reload() { await unmount(view); return render(<Harness />); } };
}

it.each(['main', 'side', 'window', 'team-leader', 'team-member', 'compact-leader', 'compact-member', 'ask', 'tpm'] as const)('edits the clicked %s prefix through its own client, follows B and restores without input', async kind => {
  const f = await setupEdit(kind);
  await vi.waitFor(() => expect(f.view.querySelectorAll('[data-prompt-editable]')).toHaveLength(2));
  await act(async () => (f.view.querySelectorAll('[data-prompt-editable]')[1]!.querySelector('[data-prompt-edit-action]') as HTMLButtonElement).click());
  await vi.waitFor(() => expect(f.requests.filter(item => item.path.endsWith('/commit')), JSON.stringify({ requests: f.requests, notice: f.view.querySelector('.lab-handoff-notice')?.textContent })).toHaveLength(1));
  await vi.waitFor(() => expect(promptText(promptEditor(f.view))).toBe('Selected A prompt 2'));
  expect(f.drafts.get('selected-owner')).toBe('Selected A prompt 2');
  expect(f.requests.filter(item => item.path.endsWith('/prepare'))).toHaveLength(1);
  expect(f.requests.find(item => item.path.endsWith('/prepare'))?.body).toMatchObject({ nativeSessionId: 'A', preparation: { kind: 'native_prefix', turnId: 'turn-2', messageId: 'message-2' } });
  expect(f.sent).toHaveLength(0);
  expect(f.requests.filter(item => item.path.endsWith('/create'))).toHaveLength(0);
  f.connections.clear();
}, 10000);

it('does not grant a native child a prompt edit operation on its parent', async () => {
  const f = await setupEdit('child');
  expect(f.view.querySelectorAll('[data-prompt-edit-action]')).toHaveLength(0);
  expect(f.requests.filter(item => item.path.includes('/succession/'))).toHaveLength(0);
  f.connections.clear();
}, 5000);

const clickPrompt = async (view: ParentNode, index = 0) => {
  await vi.waitFor(() => expect(view.querySelectorAll('[data-prompt-editable]').length).toBeGreaterThan(index));
  await act(async () => (view.querySelectorAll('[data-prompt-editable]')[index]!.querySelector('[data-prompt-edit-action]') as HTMLButtonElement).click());
};
const clickButton = async (view: ParentNode, label: string) => {
  await act(async () => [...view.querySelectorAll('button')].find(button => button.textContent === label)!.click());
};
it('edits the first prompt and repeats B to C with separate exact operations', async () => {
  const f = await setupEdit('side');
  await clickPrompt(f.view);
  await vi.waitFor(() => expect(promptText(promptEditor(f.view))).toBe('Selected A prompt 1'));
  await vi.waitFor(() => expect(f.view.querySelector('.lab-handoff-notice'), f.view.querySelector('.lab-handoff-notice')?.textContent ?? '').toBeNull());
  await clickPrompt(f.view, 1);
  await vi.waitFor(() => expect(promptText(promptEditor(f.view))).toBe('Selected B prompt 2'));
  const prepares = f.requests.filter(item => item.path.endsWith('/prepare'));
  expect(prepares.map(item => item.body.nativeSessionId)).toEqual(['A', 'B']);
  expect(new Set(prepares.map(item => item.body.operationId)).size).toBe(2);
  expect(f.sent).toHaveLength(0);
});
it.each(['browser storage', 'IndexedDB'] as const)('requests zero native preparation when %s cannot retain the selected prompt', async boundary => {
  const f = await setupEdit('side');
  if (boundary === 'browser storage') {
    const write = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function(this: Storage, key, value) {
      if (key.includes(':prefix-edit:')) throw new Error('Browser storage denied the intent.');
      return write.call(this, key, value);
    });
  } else {
    const put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, value, key) {
      if (String(value?.key).includes('prefix-edit-prompt')) throw new DOMException('Selected prompt transaction aborted.', 'AbortError');
      return put.call(this, value, key);
    });
  }
  await clickPrompt(f.view);
  await vi.waitFor(() => expect(f.view.querySelector('[role="alert"]')?.textContent).toMatch(/retained|denied/));
  expect(f.requests.filter(item => item.path.endsWith('/prepare'))).toHaveLength(0);
  expect(f.sent).toHaveLength(0);
});
it('preserves a newer source draft even when its text returns to the original value during commit', async () => {
  const f = await setupEdit('side', { holdCommit: true });
  await clickPrompt(f.view);
  await vi.waitFor(() => expect(f.requests.filter(item => item.path.endsWith('/commit'))).toHaveLength(1));
  await act(async () => { f.drafts.set('selected-owner', 'newer'); f.drafts.set('selected-owner', ''); f.releaseCommit(); });
  await vi.waitFor(() => expect(f.view.textContent).toContain('Retry refresh'));
  await clickButton(f.view, 'Details');
  expect(f.view.textContent).toContain('A newer draft is preserved');
  expect(f.drafts.get('selected-owner')).toBe('');
  await clickButton(f.view, 'Retry refresh');
  expect(f.requests.filter(item => item.path.endsWith('/prepare'))).toHaveLength(1);
});
it('resumes the same unknown operation after remount and never prepares a replacement', async () => {
  const f = await setupEdit('side', { outcome: 'unknown' });
  await clickPrompt(f.view);
  await vi.waitFor(() => expect(f.requests.filter(item => item.path.endsWith('/prepare'))).toHaveLength(1));
  f.setOutcome('ready');
  const view = await f.reload();
  await vi.waitFor(() => expect(view.textContent).toContain('Details'));
  await clickButton(view, 'Details');
  await vi.waitFor(() => expect(view.textContent).toContain('Commit Handoff'));
  await clickButton(view, 'Commit Handoff');
  await vi.waitFor(() => expect(promptText(promptEditor(view))).toBe('Selected A prompt 1'));
  expect(f.requests.filter(item => item.path.endsWith('/prepare'))).toHaveLength(1);
  expect(f.sent).toHaveLength(0);
});
it.each(['rejected', 'cancelled'] as const)('preserves the current draft after a %s prefix', async outcome => {
  const f = await setupEdit('side', { outcome });
  await clickPrompt(f.view);
  await vi.waitFor(() => expect(f.view.textContent).toContain(outcome === 'rejected' ? 'could not be completed' : 'cancelled'));
  expect(f.requests.filter(item => item.path.endsWith('/commit'))).toHaveLength(0);
  expect(f.drafts.get('selected-owner')).toBe('');
});
it('reports unsupported native capability and keeps separately opened history read-only', async () => {
  const f = await setupEdit('side', { unavailable: true });
  await clickPrompt(f.view);
  await vi.waitFor(() => expect(f.view.textContent).toContain('This provider does not support native prefix editing.'));
  expect(f.requests.filter(item => item.path.endsWith('/prepare'))).toHaveLength(0);
  await unmount(f.view);
  const history = await setupEdit('side', { historical: true });
  expect(history.view.querySelectorAll('[data-prompt-edit-action]')).toHaveLength(0);
});

it.each(['main', 'side', 'window', 'team-leader', 'team-member', 'compact-leader', 'compact-member', 'ask', 'tpm'] as const)('restores selected image bytes in the %s owner using only that view resources', async kind => {
  vi.stubGlobal('Blob', NativeBlob);
  const f = await setupEdit(kind, { images: true });
  await clickPrompt(f.view, 1);
  await vi.waitFor(() => expect(promptEditor(f.view).querySelector('[data-image-id]')).not.toBeNull());
  await vi.waitFor(() => expect(f.view.querySelector('.lab-handoff-notice')).toBeNull());
  const imageBinding = kind === 'tpm' ? { scope: f.imageDraftBinding.scope, key: JSON.stringify([f.imageDraftBinding.scope, JSON.stringify(['local', 'recorded', 'A'])]) } : f.imageDraftBinding;
  const saved = await inspectImageDraft(imageBinding);
  expect(Object.values(saved.snapshot().draft!.images)[0]!.blob?.size).toBe(10);
  expect(f.resourceRequests.length).toBeGreaterThan(0);
  expect(f.resourceRequests.every(id => id === 'A' || id === 'B')).toBe(true);
  expect(f.sent).toHaveLength(0);
}, 10000);
it('does not prepare when the selected source image is unavailable', async () => {
  const f = await setupEdit('side', { images: true, unavailableImage: true });
  await clickPrompt(f.view);
  await vi.waitFor(() => expect(f.view.textContent).toContain('An image from this prompt is unavailable'));
  expect(f.requests.filter(item => item.path.endsWith('/prepare'))).toHaveLength(0);
});

it.each(['text storage', 'image storage'] as const)('recovers a committed partial restoration after %s fails without preparing again', async boundary => {
  const f = await setupEdit('side');
  let fail = true;
  if (boundary === 'text storage') {
    const write = Storage.prototype.setItem;
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function(this: Storage, key, value) {
      if (fail && key.endsWith(':drafts') && value.includes('Selected A prompt 1')) throw new Error('Target text storage failed.');
      return write.call(this, key, value);
    });
  } else {
    const put = IDBObjectStore.prototype.put;
    vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, value, key) {
      if (fail && value?.key === f.imageDraftBinding.key && JSON.stringify(value.parts).includes('Selected A prompt 1')) throw new DOMException('Target image storage failed.', 'AbortError');
      return put.call(this, value, key);
    });
  }
  await clickPrompt(f.view);
  await vi.waitFor(() => expect(f.view.textContent).toContain('Retry refresh'));
  expect(f.drafts.get('selected-owner')).toBe('Selected A prompt 1');
  fail = false;
  await clickButton(f.view, 'Retry refresh');
  await vi.waitFor(() => expect(f.view.querySelector('.lab-handoff-notice')).toBeNull());
  expect(f.drafts.get('selected-owner')).toBe('Selected A prompt 1');
  expect(readDrafts(f.imageDraftBinding.scope)['selected-owner']).toBe('Selected A prompt 1');
  expect(f.requests.filter(item => item.path.endsWith('/prepare'))).toHaveLength(1);
  expect(f.requests.filter(item => item.path.endsWith('/commit'))).toHaveLength(1);
  expect(f.sent).toHaveLength(0);
});
it('preserves a newer same-content draft revision after partial restoration', async () => {
  const f = await setupEdit('side');
  const write = Storage.prototype.setItem;
  let fail = true;
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function(this: Storage, key, value) {
    if (fail && key.endsWith(':drafts') && value.includes('Selected A prompt 1')) throw new Error('Target text storage failed.');
    return write.call(this, key, value);
  });
  await clickPrompt(f.view);
  await vi.waitFor(() => expect(f.view.textContent).toContain('Retry refresh'));
  await act(async () => { f.drafts.set('selected-owner', 'newer'); f.drafts.set('selected-owner', 'Selected A prompt 1'); });
  fail = false;
  await clickButton(f.view, 'Retry refresh');
  await clickButton(f.view, 'Details');
  expect(f.view.textContent).toContain('A newer draft is preserved');
  expect(f.requests.filter(item => item.path.endsWith('/prepare'))).toHaveLength(1);
});
it.each(['retired source', 'disabled connection', 'connection ABA'] as const)('retains the original candidate without committing after a held preparation encounters %s', async boundary => {
  const f = await setupEdit('side', { holdPrepare: true });
  await clickPrompt(f.view);
  await vi.waitFor(() => expect(f.requests.filter(item => item.path.endsWith('/prepare'))).toHaveLength(1));
  await act(async () => { if (boundary === 'retired source') f.setCurrent('B'); else f.setEnabled(false); });
  if (boundary === 'connection ABA') await act(async () => f.setEnabled(true));
  await act(async () => f.releasePrepare());
  await vi.waitFor(() => expect(f.view.textContent).toContain('Details'));
  await clickButton(f.view, 'Details');
  expect(f.view.textContent).toMatch(/no longer ready|connection changed/);
  expect(f.requests.filter(item => item.path.endsWith('/commit'))).toHaveLength(0);
  expect(f.requests.filter(item => item.path.endsWith('/prepare'))).toHaveLength(1);
  expect(f.drafts.get('selected-owner')).toBe('');
});

it('keeps the original candidate and recovery controls when a restarted Host rejects its capture boundary', async () => {
  const f = await setupEdit('side', { commitBoundaryChanged: true });
  await clickPrompt(f.view);
  await vi.waitFor(() => expect(f.requests.some(item => item.path.endsWith('/commit'))).toBe(true));
  await clickButton(f.view, 'Details');
  expect(f.view.textContent).toContain('succession_boundary_changed');
  const original = f.requests.find(item => item.path.endsWith('/prepare'))!.body;
  await clickButton(f.view, 'Check status');
  await clickButton(f.view, 'Reconcile');
  expect(f.requests.filter(item => item.path.endsWith('/prepare'))).toHaveLength(1);
  expect(f.requests.filter(item => /status|reconcile/.test(item.path)).every(item => item.body.operationId === original.operationId)).toBe(true);
  expect(f.drafts.get('selected-owner')).toBe('');
  await clickButton(f.view, 'Cancel Handoff');
  expect(f.requests.find(item => item.path.endsWith('/cancel'))!.body).toMatchObject(original);
  expect(f.view.textContent).toContain('A created or late candidate remains available for inspection.');
  expect(f.sent).toHaveLength(0);
});

it('refuses automatic commit when the explicitly supplied recipient retires during preparation', async () => {
  const f = await setupEdit('main', { holdPrepare: true, explicitRecipient: true });
  await clickPrompt(f.view);
  await vi.waitFor(() => expect(f.requests.filter(item => item.path.endsWith('/prepare'))).toHaveLength(1));
  await act(async () => { f.retireRecipient(); f.releasePrepare(); });
  await clickButton(f.view, 'Details');
  expect(f.view.textContent).toContain('no longer ready');
  expect(f.requests.filter(item => item.path.endsWith('/commit'))).toHaveLength(0);
  expect(f.sent).toHaveLength(0);
});

it.each(['transport', 'storage scope'] as const)('reattaches a followed view when its %s changes', async boundary => {
  const first = fixture(), second = fixture();
  const origin: OpenedSession = { hostId: 'local', agentId: 'A', providerId: 'recorded', nativeSessionId: 'A', title: 'Original' };
  const attached: string[] = [];
  let change!: () => void;
  const fetcher: typeof fetch = async input => { attached.push(String(input)); return Response.json({ agentId: 'B', nativeSessionId: 'B' }); };
  vi.stubGlobal('fetch', fetcher);
  function View({ transport }: { transport: RemoteAgentTransport }) {
    const view = useConversationSession(origin, transport);
    return <output>{view.operationBinding.scope?.isCurrent() ? view.boundSession.nativeSessionId : 'waiting'}</output>;
  }
  function Harness() {
    const [changed, setChanged] = useState(false); change = () => setChanged(true);
    const transport = changed && boundary === 'transport' ? second.transport : first.transport;
    const storageScope = changed && boundary === 'storage scope' ? 'http://second/' : 'http://first/';
    return <SessionViewOperationsContext.Provider value={{ storageScope, transport, enabled: true,
      resolveTarget: source => ({ target: { ...source, nativeSessionId: 'B' } }), directory: () => new SessionDirectoryClient(storageScope), refreshSettled: async () => {} }}>
      <View transport={transport} />
    </SessionViewOperationsContext.Provider>;
  }
  const view = await render(<Harness />);
  await vi.waitFor(() => expect(view.textContent).toBe('B'));
  expect(attached).toHaveLength(1);
  await act(async () => change());
  await vi.waitFor(() => expect(attached).toHaveLength(2));
  await vi.waitFor(() => expect(view.textContent).toBe('B'));
});
