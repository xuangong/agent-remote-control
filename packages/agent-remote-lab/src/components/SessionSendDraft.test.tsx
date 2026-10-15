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
import { promptText, render } from '../test/setup.js';
import { SideConversation } from './SideConversation.js';
import { SessionWindow } from './SessionWindow.js';
import { SessionFamily } from './SessionFamily.js';
import { AskConversation } from './AskConversation.js';
import { TpmWorkspace } from './TpmWorkspace.js';
import { askParticipantKey } from '../hooks/useAskConversations.js';
import type { SessionFork } from '../session-forks.js';
import type { TpmItem } from '../hooks/useTpmWork.js';
import type { OpenedSession } from '../directory-client.js';
import { sessionViewNavigation } from '../session-view-navigation.js';

beforeEach(() => {
  vi.stubGlobal('ResizeObserver', class { observe() {} disconnect() {} });
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
afterEach(() => vi.unstubAllGlobals());

function fixture(images = false) {
  const listeners = new Map<string, RemoteTransportListener>();
  const sent: Extract<ClientMessage, { type: 'send_message' }>[] = [];
  const snapshot = (id: string): AgentSnapshot => ({ protocolVersion: '1.8.0', type: 'agent_snapshot', payload: {
    ...replicaState.agent!, id, capabilities: { ...replicaState.agent!.capabilities,
      ...(images ? { imageInput: { mediaTypes: ['image/png'], maxImages: 8, maxImageBytes: 10485760, maxMessageBytes: 20971520 } } : {}) },
    runtimeInfo: { ...replicaState.agent!.runtimeInfo, sessionId: id },
  } });
  const page = (id: string): HistoryPage => ({ protocolVersion: '1.8.0', type: 'timeline_page', payload: {
    agentId: id, requestId: 'history', direction: 'tail', epoch: `epoch-${id}`, reset: false, staleCursor: false, gap: false,
    window: { minSeq: 0, maxSeq: 0, nextSeq: 1 }, startCursor: null, endCursor: null,
    entries: [], hasOlder: false, hasNewer: false, error: null,
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
        if (message.type === 'image_upload_begin') listener.onMessage({ protocolVersion: '1.8.0', type: 'image_upload_result', payload: {
          requestId: message.payload.requestId, agentId: id, uploadId: message.payload.uploadId, offset: message.payload.byteLength,
          attachment: { attachmentId: `image-${id}`, sha256: message.payload.sha256, byteLength: message.payload.byteLength, mediaType: message.payload.mediaType, imageDimensions: { width: 1, height: 1 } },
        } });
      } };
    },
  };
  return { transport, sent, listeners, snapshot, acknowledge(message = sent.at(-1)!) {
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

const editor = (view: ParentNode) => view.querySelector<HTMLElement>('[data-testid="prompt-input"]')!;
async function type(view: ParentNode, text: string) {
  await act(async () => {
    const input = editor(view);
    if (input instanceof HTMLTextAreaElement) {
      Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    } else {
      const event = new Event('paste', { bubbles: true, cancelable: true });
      Object.defineProperty(event, 'clipboardData', { value: { files: [], getData: (type: string) => type === 'text/plain' ? text : '' } });
      input.dispatchEvent(event);
    }
  });
}
async function submit({ view, sent }: { view: ParentNode; sent: unknown[] }, dispatch = true) {
  const count = sent.length;
  await act(async () => {
    const button = view.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!;
    button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    button.click();
  });
  if (dispatch) await act(async () => { await vi.waitFor(() => expect(sent).toHaveLength(count + 1)); });
  else expect(sent).toHaveLength(count);
}

type ViewKind = 'side' | 'window' | 'team-leader' | 'team-member' | 'compact-leader' | 'compact-member' | 'child' | 'ask' | 'tpm';
async function setup(kind: ViewKind, options: { images?: boolean; recipient?: ImageDraftRecipient } = {}) {
  const f = fixture(options.images);
  const scope = `confirmed-send-${kind}-${crypto.randomUUID()}`;
  const drafts = new DraftStore(scope);
  const binding = { store: drafts, key: 'owner-text' };
  const imageDraftBinding = { scope, key: `${scope}:owner-image` };
  const session: OpenedSession & { hostId: string } = { hostId: 'local', agentId: kind, providerId: 'recorded', nativeSessionId: kind, title: kind };
  const connections = new ConversationConnections(f.transport);
  const replica = new AgentReplica();
  const lease = connections.acquire(kind, replica, session);
  let switchSession!: () => void;
  const owner = kind === 'side' || kind === 'window' || kind === 'ask';
  const compact = kind.startsWith('compact-');
  const managed = kind.startsWith('team-');
  function Harness() {
    const [selected, setSelected] = useState(session);
    const trigger = useRef<HTMLButtonElement>(null);
    switchSession = () => setSelected({ ...session, agentId: 'replacement', nativeSessionId: 'replacement' });
    const family = { storageScope: scope, baseUrl: 'http://fixture', target: kind === 'child' ? { ...selected, parentNativeSessionId: 'parent' } : selected,
      transport: f.transport, draftStore: drafts, hostLabel: 'Local', offline: false, active: true, compact };
    const record: SessionFork = { id: 'ask-record', mode: 'reference', source: selected, target: selected, capturedAt: '2026-10-15T00:00:00Z',
      delivery: 'sent', configured: true, options: {}, settings: [] };
    const item: TpmItem = { key: 'tpm-work', hostId: 'local', hostName: 'Local', online: true, unread: false, work: {
      id: 'work', revision: 1, title: 'Work', providerId: 'recorded', mainNativeSessionId: 'main', phase: 'implementing', waiting: 'none', paused: false,
      summary: '', nextAction: '', document: '', acceptance: '', evidence: [], createdAt: '2026-10-15T00:00:00Z', updatedAt: '2026-10-15T00:00:00Z', nextCheckAt: 0, outbox: [],
    } };
    return <ConversationConnectionScope.Provider value={connections}>{kind === 'side'
    ? <SideConversation session={selected} transport={f.transport} store={new ForkStore(scope)} draftBinding={binding} imageDraftBinding={imageDraftBinding}
      onClose={() => {}} onOpenSource={() => {}} onOpenFork={() => {}} onFork={async () => ({})} />
    : kind === 'ask' ? <AskConversation entry={{ source: selected, record, attached: true, attachedParticipant: askParticipantKey(record) }} replica={replica}
      transport={f.transport} draftBinding={binding} imageDraftBinding={imageDraftBinding} imageRecipient={options.recipient} triggerRef={trigger} storageScope={scope}
      onClose={() => {}} onToggleEnabled={() => {}} onClean={() => {}} onRetry={() => {}} onSendInput={() => {}} onDiscardInput={() => {}} />
    : kind === 'tpm' ? <TpmWorkspace session={selected} item={item} visible storageScope={scope} triggerRef={trigger}
      transport={f.transport} draftBinding={binding} onClose={() => {}} onShowList={() => {}} onOpenMain={() => {}} onAction={async () => {}} onResolve={async () => {}} onRetry={() => {}} />
    : compact || kind === 'child' ? <SessionFamily {...family} />
    : <SessionWindow entry={{ id: 'ordinary-view', slotId: 'slot', managed, ...(managed ? { groupId: 'team' } : {}), target: selected }} baseUrl="http://fixture" visible compact={false} hostLabel="Local" offline={false}
      transport={f.transport} draftStore={drafts} draftBinding={owner ? binding : undefined} imageDraftBinding={owner ? imageDraftBinding : undefined} navigation={(source, state) => sessionViewNavigation({ source, state, entries: [] })}
      onFocus={() => {}} onClose={() => {}} />}</ConversationConnectionScope.Provider>;
  }
  const view = await render(<Harness />);
  lease.release();
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
  const draftKey = owner || kind === 'tpm' ? binding.key : `session:${JSON.stringify(['local', 'recorded', kind])}`;
  return { ...f, view, drafts, scope, draftKey, imageDraftBinding, replica, connections, switchSession: () => switchSession() };
}

it.each(['side', 'window', 'team-leader', 'team-member', 'compact-leader', 'compact-member', 'child', 'ask', 'tpm'] as const)('clears the mounted %s editor and persisted text only after matching ACK', async kind => {
  const f = await setup(kind);
  await type(f.view, 'Confirmed input');
  expect(promptText(editor(f.view))).toBe('Confirmed input');
  expect(f.view.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!.disabled).toBe(false);
  await submit(f);
  expect(f.sent).toHaveLength(1);
  expect(promptText(editor(f.view))).toBe('Confirmed input');
  await act(async () => f.acknowledge());
  expect(promptText(editor(f.view))).toBe('');
  f.drafts.flush();
  expect(readDrafts(f.scope)[f.draftKey]).toBe('');
});

it.each(['side', 'window'] as const)('retains the %s draft after rejection and echo without ACK', async kind => {
  const f = await setup(kind);
  await type(f.view, 'Unconfirmed input'); await submit(f);
  await act(async () => f.echo());
  expect(f.view.querySelector('.agent-message-user')?.textContent).toContain('Unconfirmed input');
  expect(promptText(editor(f.view))).toBe('Unconfirmed input');
  expect(f.view.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!.disabled).toBe(true);
  await act(async () => f.reject());
  expect(promptText(editor(f.view))).toBe('Unconfirmed input');
  f.drafts.flush();
  expect(readDrafts(f.scope)[f.draftKey]).toBe('Unconfirmed input');
});

it.each(['side', 'window'] as const)('preserves a newer %s edit after an old matching ACK', async kind => {
  const f = await setup(kind);
  await type(f.view, 'First input'); await submit(f);
  await act(async () => f.drafts.set(f.draftKey, 'First input and newer draft'));
  const newer = promptText(editor(f.view));
  expect(newer).toBe('First input and newer draft');
  await act(async () => f.acknowledge());
  expect(promptText(editor(f.view))).toBe(newer);
  f.drafts.flush();
  expect(readDrafts(f.scope)[f.draftKey]).toBe(newer);
});

it('retains a changed revision even when its text returns to the submitted value', async () => {
  const f = await setup('side');
  await type(f.view, 'Same text'); await submit(f);
  await act(async () => f.drafts.set(f.draftKey, 'Changed revision'));
  await act(async () => f.drafts.set(f.draftKey, 'Same text'));
  await act(async () => f.acknowledge());
  expect(promptText(editor(f.view))).toBe('Same text');
});

it('ignores an ACK for another request and preserves the draft across a session switch', async () => {
  const f = await setup('side');
  await type(f.view, 'Old session input'); await submit(f);
  const original = f.sent[0]!;
  await act(async () => f.acknowledge({ ...original, payload: { ...original.payload, requestId: 'another-request' } }));
  expect(promptText(editor(f.view))).toBe('Old session input');
  await act(async () => f.switchSession());
  await act(async () => f.acknowledge(original));
  expect(promptText(editor(f.view))).toBe('Old session input');
  f.drafts.flush();
  expect(readDrafts(f.scope)[f.draftKey]).toBe('Old session input');
});

it('keeps an explicitly retired Ask recipient authoritative over its connected fallback', async () => {
  const f = await setup('ask', { recipient: { identity: 'succession-recipient', lifetime: {}, isCurrent: () => false } });
  await type(f.view, 'Retired owner input'); await submit(f, false);
  expect(f.view.querySelector('[aria-label="Live provider controls"]')?.getAttribute('aria-busy')).toBe('false');
  expect(f.sent).toHaveLength(0);
  expect(promptText(editor(f.view))).toBe('Retired owner input');
});

it('preserves the Ask draft when its explicit recipient retires after dispatch and before ACK', async () => {
  let current = true;
  const f = await setup('ask', { recipient: { identity: 'succession-recipient', lifetime: {}, isCurrent: () => current } });
  await type(f.view, 'Retired owner input'); await submit(f);
  current = false;
  await act(async () => f.acknowledge());
  expect(promptText(editor(f.view))).toBe('Retired owner input');
});

it.each(['ack', 'reject'] as const)('persists image bytes and clears the image document only for %s', async outcome => {
  const f = await setup('side', { images: true });
  await type(f.view, 'Image input');
  await act(async () => {
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { files: [new NativeBlob(['image'], { type: 'image/png' })], getData: () => '' } });
    editor(f.view).dispatchEvent(event);
  });
  await vi.waitFor(async () => {
    await act(async () => {});
    expect(f.view.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!.disabled).toBe(false);
  });
  const image = f.view.querySelector('[data-image-id]')!.getAttribute('data-image-id')!;
  let persisted = await inspectImageDraft(f.imageDraftBinding);
  await act(async () => { await persisted.flush(persisted.snapshot().revision, () => true); });
  expect((await readImageDraft(f.imageDraftBinding.key))?.images[image]?.blob?.size).toBe(5);
  await submit(f);
  const payload = f.sent[0]!.payload;
  expect('content' in payload ? payload.content : undefined).toEqual([{ type: 'text', text: 'Image input' }, { type: 'image', attachmentId: 'image-side', label: 'image #1' }]);
  await act(async () => outcome === 'ack' ? f.acknowledge() : f.reject());
  persisted = await inspectImageDraft(f.imageDraftBinding);
  await act(async () => { await persisted.flush(persisted.snapshot().revision, () => true); });
  const draft = await readImageDraft(f.imageDraftBinding.key);
  if (outcome === 'ack') {
    expect(promptText(editor(f.view))).toBe('');
    expect(draft?.parts).toEqual([]);
  } else {
    expect(draft?.parts).toEqual([{ type: 'text', text: 'Image input' }, { type: 'image', imageId: image, label: 'image #1' }]);
    expect(draft?.images[image]?.blob?.size).toBe(5);
    expect(f.view.querySelector('[data-image-id]')).not.toBeNull();
  }
});
