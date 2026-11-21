// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { render, rerender, unmount } from '../test/setup.js';
import { AgentComposer, type AgentComposerProps } from './AgentComposer.js';
import { PENDING_SEND_LIMIT, PENDING_SEND_TIMEOUT_MS } from './usePendingSend.js';
import { CONTROL } from '@orchardworks/agent-client/testing';
import { createReplicaState, remoteSessionState, type AgentReplicaState, type RemoteSessionState, type RemoteSessionStatus } from '@orchardworks/agent-client';

const state: AgentReplicaState = { ...createReplicaState(), timeline: { ...createReplicaState().timeline, initialized: true }, agent: {
  id: 'one', providerId: 'test', createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z', status: 'idle', activeTurn: null,
  capabilities: { history: true, sendMessage: true, queueMessage: true, steer: false, cancel: true, commands: true, readResource: false },
  pendingInteractions: [], runtimeInfo: { providerId: 'test', status: 'idle' },
} };
const running = { ...state, agent: { ...state.agent!, status: 'running' as const, activeTurn: { turnId: 'turn-one', startedAt: '2026-09-20T00:00:00Z' } } };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
/** Composer props with the session given as a connection over the replica, unless a test gives the session itself. */
type SetupProps = Partial<Omit<AgentComposerProps, 'sessionState'>> & { connection?: RemoteSessionStatus; sessionState?: RemoteSessionState };
const composer = ({ connection = 'ready', sessionState, ...props }: SetupProps) => <AgentComposer {...props} sessionState={sessionState ?? remoteSessionState(props.state, connection)} />;

async function setup(props: SetupProps = {}) {
  vi.useFakeTimers();
  const send = vi.fn(async () => {}), cancel = vi.fn(async () => {});
  let current: SetupProps = { state, connection: 'disconnected', onSendMessage: send, onCancel: cancel, ...props };
  const container = await render(composer(current));
  const update = async (patch: SetupProps) => { current = { ...current, ...patch }; await rerender(container, composer(current)); };
  const type = (text: string) => act(async () => {
    const input = container.querySelector('textarea')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const click = (selector = '[data-testid="prompt-submit"]') => act(async () => container.querySelector<HTMLButtonElement>(selector)!.click());
  const notice = () => container.querySelector('[data-testid="pending-send"]');
  return { container, update, send, cancel, type, click, notice };
}

it('allows draft-only text editing while stale native callbacks cannot send or enroll a queue', async () => {
  const command = vi.fn(), configure = vi.fn();
  const view = await setup({ state: undefined, draftOnly: true, onExecuteCommand: command, onSetSessionSetting: configure });
  expect(view.container.querySelector('textarea')!.disabled).toBe(false);
  await view.type('Retained draft'); await view.click(); await advance(1000);
  expect(view.container.querySelector('textarea')!.value).toBe('Retained draft');
  expect(view.notice()).toBeNull(); expect(view.send).not.toHaveBeenCalled();
  await view.update({ state: running, connection: 'ready' });
  await view.click(); await advance(1000);
  expect(view.send).not.toHaveBeenCalled(); expect(view.cancel).not.toHaveBeenCalled();
  expect(command).not.toHaveBeenCalled(); expect(configure).not.toHaveBeenCalled(); expect(view.notice()).toBeNull();
  await view.update({ readOnly: true });
  expect(view.container.querySelector('textarea')!.disabled).toBe(true);
});

it('keeps the opaque image editor and focus through draft-only and confirmed native identity', async () => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  const upload = vi.fn(async () => ({ attachmentId: 'confirmed', sha256: 'b'.repeat(64), mediaType: 'image/png' as const, byteLength: 1 }));
  const binding = { scope: 'draft-only-images', key: 'owner-K' };
  const view = await setup({ state: undefined, sessionKey: 'B', draftOnly: true, imageDraftBinding: binding, onUploadImage: upload });
  const editor = view.container.querySelector<HTMLElement>('[role="textbox"]');
  expect(editor).not.toBeNull(); expect(editor!.getAttribute('aria-disabled')).toBe('false');
  await act(async () => {
    editor!.focus();
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { files: [new File(['x'], 'x.png', { type: 'image/png' })], getData: () => 'New local text' } });
    editor!.dispatchEvent(event);
  });
  expect(view.container.querySelector('[data-image-id]')).not.toBeNull();
  await view.click(); await advance(1000);
  expect(upload).not.toHaveBeenCalled(); expect(view.send).not.toHaveBeenCalled(); expect(view.notice()).toBeNull();
  await view.update({ state, sessionKey: 'C', draftOnly: false, connection: 'ready' });
  expect(view.container.querySelector('[role="textbox"]')).toBe(editor);
  expect(document.activeElement).toBe(editor);
  expect(view.container.querySelector('[data-image-id]')).not.toBeNull();
  expect(upload).not.toHaveBeenCalled();
});

it('queues multiple messages, keeps editing available and drains FIFO without changing the new draft', async () => {
  const view = await setup();
  await view.type('First'); await view.click();
  expect(view.container.querySelector('textarea')).toMatchObject({ value: '', disabled: false });
  await view.type('Second'); await view.click();
  await view.type('Still editing');
  await advance(PENDING_SEND_TIMEOUT_MS - 1);
  expect(view.container.querySelectorAll('[data-testid="pending-send"]')).toHaveLength(2);
  expect(view.send).not.toHaveBeenCalled();
  await view.update({ connection: 'ready' });
  expect(view.send.mock.calls).toEqual([['First'], ['Second']]);
  expect(view.notice()).toBeNull();
  expect(view.container.querySelector('textarea')!.value).toBe('Still editing');
  await view.update({ connection: 'disconnected' });
  await view.update({ connection: 'ready' });
  expect(view.send).toHaveBeenCalledTimes(2);
});

it('copies the full pending text and cancels only the selected message', async () => {
  const copy = vi.fn(async () => {});
  Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: copy } });
  const view = await setup();
  await view.type('First\nwith another line'); await view.click();
  await view.type('Second'); await view.click();
  await view.type('New draft');
  await view.click('[aria-label="Copy pending message"]');
  expect(copy).toHaveBeenCalledExactlyOnceWith('First\nwith another line');
  await view.click('[aria-label="Cancel pending send"]');
  await view.update({ connection: 'ready' });
  expect(view.send).toHaveBeenCalledExactlyOnceWith('Second');
  expect(view.container.querySelector('textarea')!.value).toBe('New draft');
});

it.each(['visibility', 'page'] as const)('waits in the background and sends on %s resume', async kind => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const view = await setup();
  await view.type('Foreground only'); await view.click();
  await act(async () => {
    if (kind === 'visibility') { visibility.mockReturnValue('hidden'); document.dispatchEvent(new Event('visibilitychange')); }
    else window.dispatchEvent(new Event('pagehide'));
  });
  await view.update({ connection: 'ready' });
  await advance(PENDING_SEND_TIMEOUT_MS - 1);
  expect(view.send).not.toHaveBeenCalled();
  await act(async () => {
    if (kind === 'visibility') { visibility.mockReturnValue('visible'); document.dispatchEvent(new Event('visibilitychange')); }
    else window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  expect(view.send).toHaveBeenCalledExactlyOnceWith('Foreground only');
});

it('retains a session queue while switching without sending to the other session', async () => {
  const view = await setup();
  await view.type('Only for one'); await view.click();
  const otherSend = vi.fn(async () => {});
  await view.update({ state: { ...state, agent: { ...state.agent!, id: 'two' } }, onSendMessage: otherSend, connection: 'ready' });
  expect(otherSend).not.toHaveBeenCalled();
  expect(view.notice()).toBeNull();
  await view.update({ state, onSendMessage: view.send });
  expect(view.send).toHaveBeenCalledExactlyOnceWith('Only for one');
  expect(otherSend).not.toHaveBeenCalled();
});

it('cancels deferred work on unmount', async () => {
  const view = await setup();
  await view.type('Do not send later'); await view.click();
  await unmount(view.container); await advance(20000);
  expect(view.send).not.toHaveBeenCalled();
});

it('keeps interrupt, queue and slash commands behind readiness', async () => {
  const execute = vi.fn(async () => ({}));
  const view = await setup({ state: running, consoleCommands: [{ id: 'side', name: 'side', kind: 'command', description: 'Side' }], onExecuteConsoleCommand: execute });
  await view.type('Next turn');
  expect(view.container.querySelector<HTMLButtonElement>('[data-testid="cancel-submit"]')!.disabled).toBe(true);
  expect(view.container.querySelector<HTMLButtonElement>('[data-testid="queue-submit"]')!.disabled).toBe(true);
  await view.type('/side'); await view.click();
  expect(view.notice()).toBeNull();
  expect(execute).not.toHaveBeenCalled();
  await view.update({ connection: 'ready' });
  expect(execute).not.toHaveBeenCalled();
});

it('does not automatically retry an operation whose delivery became uncertain', async () => {
  const send = vi.fn(async () => { throw Object.assign(new Error('Delivery is not confirmed.'), { code: 'connection_disconnected' }); });
  const view = await setup({ onSendMessage: send });
  await view.type('Only once'); await view.click();
  await view.update({ connection: 'ready' });
  expect(view.notice()?.getAttribute('data-state')).toBe('error');
  expect(view.notice()?.textContent).toContain('Check delivery');
  await view.update({ connection: 'disconnected' }); await advance(10000);
  await view.update({ connection: 'ready' });
  expect(send).toHaveBeenCalledTimes(1);
});

it('keeps an agent that takes no messages blocked, and lets a message wait while the runtime is unavailable', async () => {
  const view = await setup({ state: { ...state, agent: { ...state.agent!, capabilities: { ...state.agent!.capabilities, sendMessage: false } } } });
  expect(view.container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!.disabled).toBe(true);
  expect(view.container.querySelector('textarea')!.disabled).toBe(true);
  await view.update({ connection: 'ready', state: { ...state, agent: { ...state.agent!, runtimeInfo: { ...state.agent!.runtimeInfo, connection: { state: 'unavailable' } } } } });
  await view.type('Waits for the agent');
  expect(view.container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!.disabled).toBe(false);
  await view.click();
  expect(view.notice()?.textContent).toContain('Sending');
  expect(view.send).not.toHaveBeenCalled();
  await view.update({ state });
  expect(view.send).toHaveBeenCalledExactlyOnceWith('Waits for the agent');
});

it('waits for image revalidation after reconnect and preserves ordered content', async () => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  const imageState = { ...state, agent: { ...state.agent!, capabilities: { ...state.agent!.capabilities,
    imageInput: { mediaTypes: ['image/png' as const], maxImages: 8, maxImageBytes: 10485760, maxMessageBytes: 20971520 },
  } } };
  const attachment = { attachmentId: 'image-one', sha256: 'a'.repeat(64), mediaType: 'image/png' as const, byteLength: 1, imageDimensions: { width: 1, height: 1 } };
  let finishUpload!: (value: typeof attachment) => void;
  const upload = vi.fn(() => new Promise<typeof attachment>(resolve => { finishUpload = resolve; }));
  const send = vi.fn(async () => {});
  const view = await setup({ state: imageState, onUploadImage: upload, onSendMessageContent: send });
  const paste = (files: File[], text = '') => act(async () => {
    const event = new Event('paste', { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'clipboardData', { value: { files, getData: (type: string) => type === 'text/plain' ? text : '' } });
    view.container.querySelector('[role="textbox"]')!.dispatchEvent(event);
  });
  await paste([], 'Look at ');
  await paste([new File(['x'], 'x.png', { type: 'image/png' })]);
  await view.click();
  expect(view.notice()?.textContent).toContain('Look at');
  expect(upload).not.toHaveBeenCalled();
  await view.update({ connection: 'ready' });
  expect(upload).toHaveBeenCalledTimes(1);
  expect(send).not.toHaveBeenCalled();
  await act(async () => finishUpload(attachment));
  expect(send).toHaveBeenCalledExactlyOnceWith([{ type: 'text', text: 'Look at ' }, { type: 'image', attachmentId: 'image-one', label: 'image #1' }], { imageDigests: { 'image-one': 'a'.repeat(64) } });
  expect(view.notice()).toBeNull();
  expect(view.container.querySelector('[data-image-id]')).toBeNull();
});

it('cancels a queued image without restoring or locking the new draft', async () => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  const imageState = { ...state, agent: { ...state.agent!, capabilities: { ...state.agent!.capabilities,
    imageInput: { mediaTypes: ['image/png' as const], maxImages: 8, maxImageBytes: 10485760, maxMessageBytes: 20971520 },
  } } };
  const send = vi.fn(async () => {});
  const view = await setup({ state: imageState, onSendMessageContent: send });
  const paste = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(paste, 'clipboardData', { value: { files: [new File(['x'], 'x.png', { type: 'image/png' })], getData: () => '' } });
  await act(async () => view.container.querySelector('[role="textbox"]')!.dispatchEvent(paste));
  await view.click(); await advance(10000);
  await view.click('[aria-label="Cancel pending send"]');
  expect(view.container.querySelector('[data-image-id]')).toBeNull();
  expect(view.container.querySelector('[role="textbox"]')?.getAttribute('aria-disabled')).toBe('false');
  expect(view.notice()).toBeNull();
  expect(send).not.toHaveBeenCalled();
});

it('serializes pending sends while accepting more input during an outstanding send', async () => {
  let finish!: () => void;
  const send = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const view = await setup({ onSendMessage: send });
  await view.type('First'); await view.click();
  await view.update({ connection: 'ready' });
  // Dispatched, the message is the conversation's outgoing row: the composer's chip leaves, so Sending shows once.
  expect(view.notice()).toBeNull();
  await view.type('Second'); await view.click();
  expect(view.notice()?.textContent).toContain('Second');
  expect(send).toHaveBeenCalledTimes(1);
  await act(async () => finish());
  expect(send.mock.calls).toEqual([['First'], ['Second']]);
  await act(async () => finish());
  expect(view.notice()).toBeNull();
});

it('pauses FIFO behind an unknown outcome until the user checks and dismisses it', async () => {
  const send = vi.fn().mockRejectedValueOnce(new Error('Unknown delivery')).mockResolvedValue(undefined);
  const view = await setup({ onSendMessage: send });
  await view.type('Uncertain'); await view.click();
  await view.type('Later'); await view.click();
  await view.update({ connection: 'ready' });
  expect(send).toHaveBeenCalledTimes(1);
  expect(view.container.querySelector('[aria-label="Retry pending send"]')).toBeNull();
  await view.click('[aria-label="Dismiss message after checking delivery"]');
  expect(send.mock.calls).toEqual([['Uncertain'], ['Later']]);
});

it.each([
  ['arrived and waits for its echo', 'awaiting_echo'],
  ['never arrived and is Not sent in the conversation', 'failed'],
  ['arrived and its echo delivered it', undefined],
] as const)('drops Check delivery once the Host settles the send (it %s), and the message behind it goes (gap 5)', async (_name, settled) => {
  const { RemoteOperationError } = await import('@orchardworks/agent-client');
  const operationId = '55555555-5555-4555-8555-555555555555';
  const lost = Object.assign(new RemoteOperationError('connection_disconnected', 'Remote session connection disconnected.', true), { operationId });
  const send = vi.fn().mockRejectedValueOnce(lost).mockResolvedValue(undefined);
  const view = await setup({ onSendMessage: send });
  await view.type('Uncertain'); await view.click();
  await view.type('Later'); await view.click();
  const ledger = (status?: 'unconfirmed' | 'awaiting_echo' | 'failed') => ({ ...state, outgoingMessages: status ? [{ id: 'outgoing-1', operationId, agentId: 'one', text: 'Uncertain', status }] : [] });
  await view.update({ connection: 'ready', state: ledger('unconfirmed') });
  expect(send).toHaveBeenCalledTimes(1);
  expect(view.notice()?.textContent).toContain('Check delivery');
  await view.update({ state: ledger(settled) });
  expect(send.mock.calls).toEqual([['Uncertain'], ['Later']]);
  expect(view.container.textContent).not.toContain('Check delivery');
});

it('keeps Check delivery for a send whose operation the ledger never held, until the person dismisses it', async () => {
  const send = vi.fn().mockRejectedValueOnce(new Error('Unknown delivery')).mockResolvedValue(undefined);
  const view = await setup({ onSendMessage: send });
  await view.type('Uncertain'); await view.click();
  await view.update({ connection: 'ready', state: { ...state, outgoingMessages: [] } });
  expect(view.notice()?.textContent).toContain('Check delivery');
});

it('waits for confirmed control, and holds a waiting message as Not sent when a terminal takes the session, sending it only on Retry', async () => {
  const view = await setup();
  await view.type('After control'); await view.click();
  expect(view.notice()?.textContent).toContain('Sending');
  await view.update({ connection: 'ready', state: { ...state, sessionControl: CONTROL.checking } });
  expect(view.send).not.toHaveBeenCalled();
  await view.update({ state: { ...state, sessionControl: CONTROL.nativeCli } });
  expect(view.send).not.toHaveBeenCalled();
  expect(view.notice()?.textContent).toContain('After control');
  expect(view.notice()?.textContent).toContain('Not sent');
  expect(view.notice()?.textContent).not.toContain('Sending');
  expect(view.container.querySelector('textarea')!.disabled).toBe(true);
  await view.update({ state: { ...state, sessionControl: CONTROL.granted } });
  await advance(1000);
  expect(view.send).not.toHaveBeenCalled();
  await view.click('[aria-label="Retry pending send"]');
  expect(view.send).toHaveBeenCalledExactlyOnceWith('After control');
});

it.each([
  ['the session ended', { status: 'closed' as const }],
  ['the agent failed', { status: 'failed' as const }],
])('says Not sent, with Retry and Cancel, for a waiting message when %s', async (_name, agent) => {
  const view = await setup();
  await view.type('Too late'); await view.click();
  await view.update({ connection: 'ready', state: { ...state, agent: { ...state.agent!, ...agent } } });
  expect(view.notice()?.textContent).toContain('Not sent');
  expect(view.container.querySelector('[aria-label="Retry pending send"]')).not.toBeNull();
  expect(view.container.querySelector('[aria-label="Cancel pending send"]')).not.toBeNull();
  await advance(1000);
  expect(view.send).not.toHaveBeenCalled();
});

it('accepts messages during native recovery even without the outer recovery hint', async () => {
  const view = await setup({ connection: 'ready', state: { ...state, agent: { ...state.agent!, runtimeInfo: { ...state.agent!.runtimeInfo, connection: { state: 'restoring' } } } } });
  await view.type('After restore'); await view.click();
  expect(view.notice()).not.toBeNull();
  expect(view.send).not.toHaveBeenCalled();
  await view.update({ state });
  expect(view.send).toHaveBeenCalledExactlyOnceWith('After restore');
});

it('aborts a queued image upload on reconnect and never dispatches its stale completion', async () => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  const imageState = { ...state, agent: { ...state.agent!, capabilities: { ...state.agent!.capabilities,
    imageInput: { mediaTypes: ['image/png' as const], maxImages: 8, maxImageBytes: 10485760, maxMessageBytes: 20971520 },
  } } };
  const attachment = { attachmentId: 'fresh', sha256: 'b'.repeat(64), mediaType: 'image/png' as const, byteLength: 1, imageDimensions: { width: 1, height: 1 } };
  let finish!: (value: typeof attachment) => void;
  const upload = vi.fn((_file: Blob, _id: string, _options?: { signal?: AbortSignal }) => new Promise<typeof attachment>(resolve => { finish = resolve; }));
  const send = vi.fn(async () => {});
  const view = await setup({ state: imageState, onUploadImage: upload, onSendMessageContent: send });
  const paste = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(paste, 'clipboardData', { value: { files: [new File(['x'], 'x.png', { type: 'image/png' })], getData: () => '' } });
  await act(async () => view.container.querySelector('[role="textbox"]')!.dispatchEvent(paste));
  await view.click();
  await view.update({ connection: 'ready' });
  expect(upload).toHaveBeenCalledTimes(1);
  await view.update({ connection: 'disconnected' });
  expect(upload.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
  await act(async () => finish({ ...attachment, attachmentId: 'stale' }));
  expect(send).not.toHaveBeenCalled();
  await view.update({ connection: 'ready' });
  expect(upload).toHaveBeenCalledTimes(2);
  await act(async () => finish(attachment));
  expect(send).toHaveBeenCalledExactlyOnceWith([{ type: 'image', attachmentId: 'fresh', label: 'image #1' }], { imageDigests: { fresh: 'b'.repeat(64) } });
});

it('queues input when control is checking even if the transport reports ready', async () => {
  const view = await setup({ connection: 'ready', state: { ...state, sessionControl: { access: 'checking', available: false } } });
  await view.type('Wait for control'); await view.click();
  expect(view.send).not.toHaveBeenCalled();
  expect(view.container.querySelector('textarea')!.value).toBe('');
  await view.update({ state });
  expect(view.send).toHaveBeenCalledExactlyOnceWith('Wait for control');
});

it('uses public synchronization and operation admission without legacy disabled props', async () => {
  const { remoteSessionState } = await import("@orchardworks/agent-client");
  const view = await setup({ connection: 'ready', sessionState: remoteSessionState(state, 'connecting') });
  expect(view.container.querySelector('[data-testid="agent-activity-label"]')!.textContent).toBe('Ready');
  await view.type('Wait for synchronization');
  await view.click();
  expect(view.send).not.toHaveBeenCalled();
  expect(view.notice()?.textContent).toContain('Wait for synchronization');
  const ready = remoteSessionState(state, 'ready');
  await view.update({ sessionState: { ...ready, operations: { ...ready.operations, send_message: { allowed: false, code: 'blocked', reason: 'Input unavailable' } } } });
  await advance(1000);
  expect(view.send).not.toHaveBeenCalled();
  await view.type('Another draft');
  // The send is refused for now, not for good: another message may wait behind the first.
  expect(view.container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!.disabled).toBe(false);
  await view.update({ sessionState: ready });
  expect(view.send).toHaveBeenCalledExactlyOnceWith('Wait for synchronization');
  expect(view.container.querySelector('textarea')!.value).toBe('Another draft');
});

const retainedImageState = { ...state, agent: { ...state.agent!, capabilities: { ...state.agent!.capabilities,
  imageInput: { mediaTypes: ['image/png' as const], maxImages: 8, maxImageBytes: 10485760, maxMessageBytes: 20971520 },
} } };
const retainedImageBinding = { scope: '', key: 'composer-retained-owner' };
const imageRecipient = (identity: string) => ({ identity, lifetime: {}, isCurrent: () => true });
const receipt = (attachmentId: string) => ({ attachmentId, sha256: 'a'.repeat(64), mediaType: 'image/png' as const, byteLength: 1, imageDimensions: { width: 1, height: 1 } });
async function pasteImage(container: HTMLElement, text = '') {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  const event = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'clipboardData', { value: { files: text ? [] : [new File(['x'], 'x.png', { type: 'image/png' })], getData: () => text } });
  await act(async () => container.querySelector('[role="textbox"]')!.dispatchEvent(event));
}
it.each(['success', 'failure'])('preserves B edits when an A rich send settles with %s under the same storage owner', async outcome => {
  let settle!: () => void;
  const send = vi.fn(() => new Promise<void>((resolve, reject) => { settle = () => outcome === 'success' ? resolve() : reject(Object.assign(new Error('Old rejection'), { code: 'invalid_image_input' })); }));
  const view = await setup({ state: retainedImageState, connection: 'ready', sessionKey: 'A', imageDraftBinding: retainedImageBinding,
    imageRecipient: imageRecipient('A'), onUploadImage: async () => receipt('A'), onSendMessageContent: send });
  await pasteImage(view.container); await view.click();
  expect(send).toHaveBeenCalledOnce();
  await view.update({ sessionKey: 'B', imageRecipient: imageRecipient('B'), onUploadImage: async () => receipt('B') });
  await pasteImage(view.container, 'B edit');
  await act(async () => settle());
  expect(view.container.querySelector('[data-image-id]')).not.toBeNull();
  expect(view.container.querySelector('[role="textbox"]')?.textContent).toContain('B edit');
  expect(view.container.textContent).not.toContain('The Host could not use this image');
});
it('uses only the current recipient receipt and digest after storage-owner-preserving navigation', async () => {
  const send = vi.fn(async () => {});
  const view = await setup({ state: retainedImageState, connection: 'ready', sessionKey: 'A', imageDraftBinding: retainedImageBinding,
    imageRecipient: imageRecipient('A'), onUploadImage: async () => receipt('A'), onSendMessageContent: send });
  await pasteImage(view.container);
  let finish!: (value: ReturnType<typeof receipt>) => void;
  await view.update({ sessionKey: 'B', imageRecipient: imageRecipient('B'), onUploadImage: () => new Promise(resolve => { finish = resolve; }) });
  await view.click(); expect(send).not.toHaveBeenCalled();
  await act(async () => finish(receipt('B')));
  expect(view.container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!.disabled, view.container.textContent ?? '').toBe(false);
  await act(async () => view.container.querySelector('[data-testid="prompt-submit"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
  await view.click();
  expect(send).toHaveBeenCalledExactlyOnceWith([{ type: 'image', attachmentId: 'B', label: 'image #1' }], { imageDigests: { B: 'a'.repeat(64) } });
});

it('keeps the concrete waiting queue visible and recoverable when only the native client lifetime changes', async () => {
  const a = imageRecipient('native-A');
  const view = await setup({ imageRecipient: a });
  await view.type('Retained pending message'); await view.click();
  expect(view.notice()?.textContent).toContain('Retained pending message');
  await view.update({ imageRecipient: imageRecipient('native-A') });
  expect(view.notice()?.textContent).toContain('Retained pending message');
  await view.update({ connection: 'ready' });
  expect(view.send).toHaveBeenCalledExactlyOnceWith('Retained pending message');
});

it('preserves B text when an A plain-text send settles in an image-capable composer sharing K', async () => {
  let finish!: () => void;
  const send = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const view = await setup({ state: retainedImageState, connection: 'ready', sessionKey: 'A', imageDraftBinding: retainedImageBinding,
    imageRecipient: imageRecipient('A'), onSendMessage: send });
  await pasteImage(view.container, 'A question'); await view.click();
  expect(send).toHaveBeenCalledExactlyOnceWith('A question');
  await view.update({ sessionKey: 'B', imageRecipient: imageRecipient('B') });
  await pasteImage(view.container, 'B draft');
  const edited = view.container.querySelector('[role="textbox"]')!.textContent;
  await act(async () => finish());
  expect(view.container.querySelector('[role="textbox"]')!.textContent).toBe(edited);
  expect(edited).toContain('B draft');
});

it('clears a successful plain-text send in the current fixed image-capable session', async () => {
  const view = await setup({ state: retainedImageState, connection: 'ready' });
  await pasteImage(view.container, 'Current question'); await view.click();
  expect(view.send).toHaveBeenCalledExactlyOnceWith('Current question');
  expect(view.container.querySelector('[role="textbox"]')!.textContent).toBe('');
});

it('keeps a waiting message Sending while its view cannot take messages yet, up to the timeout, and sends it once the session is ready', async () => {
  const view = await setup({ sessionKey: 'view' });
  await view.type('Typed while opening'); await view.click();
  // A view that is still opening its session (a Window pane whose locator is not confirmed yet) is draft-only: a wait, not a refusal.
  await view.update({ draftOnly: true });
  await advance(PENDING_SEND_TIMEOUT_MS - 1);
  expect(view.notice()?.textContent).toContain('Sending');
  expect(view.notice()?.textContent).not.toContain('Not sent');
  expect(view.send).not.toHaveBeenCalled();
  await view.update({ draftOnly: false, connection: 'ready' });
  expect(view.send).toHaveBeenCalledExactlyOnceWith('Typed while opening');
});

it('says Not sent for a waiting message when the view could not open its session, and sends it only on Retry', async () => {
  const view = await setup({ sessionKey: 'view' });
  await view.type('Typed while opening'); await view.click();
  await view.update({ draftOnly: true, openFailed: true });
  expect(view.notice()?.textContent).toContain('Not sent');
  expect(view.container.querySelector('[role="alert"]')?.textContent).toBe('This session could not be opened.');
  await view.update({ draftOnly: false, openFailed: false, connection: 'ready' });
  await advance(1000);
  expect(view.send).not.toHaveBeenCalled();
  await view.click('[aria-label="Retry pending send"]');
  expect(view.send).toHaveBeenCalledExactlyOnceWith('Typed while opening');
});

it('lets a message the session refused for certain be retried, and sends it again only on Retry', async () => {
  const { RemoteOperationError } = await import('@orchardworks/agent-client');
  const send = vi.fn().mockRejectedValueOnce(new RemoteOperationError('native_session_owned', 'A terminal has control.', false)).mockResolvedValue(undefined);
  const view = await setup({ connection: 'ready', onSendMessage: send });
  await view.type('Refused'); await view.click();
  await advance(0);
  expect(view.notice()?.textContent).toContain('Not sent');
  await advance(1000);
  expect(send).toHaveBeenCalledTimes(1);
  await view.click('[aria-label="Retry pending send"]');
  await advance(0);
  expect(send.mock.calls).toEqual([['Refused'], ['Refused']]);
});

it('holds at most 20 waiting messages and keeps the 21st in the composer, saying why, never dropping it', async () => {
  const view = await setup({ sessionKey: 'bounded' });
  const texts = Array.from({ length: PENDING_SEND_LIMIT }, (_, index) => `Message ${index + 1}`);
  for (const text of texts) { await view.type(text); await view.click(); }
  await view.type('One more'); await view.click();
  expect(view.container.querySelectorAll('[data-testid="pending-send"]')).toHaveLength(PENDING_SEND_LIMIT);
  expect(view.container.querySelector('textarea')!.value).toBe('One more');
  expect(view.container.textContent).toContain(`${PENDING_SEND_LIMIT} messages are already waiting for this session.`);
  await view.update({ connection: 'ready' });
  await advance(1000);
  expect(view.send.mock.calls).toEqual(texts.map(text => [text]));
  await view.click();
  expect(view.send).toHaveBeenLastCalledWith('One more');
});

it('says Not sent for a message that could not leave within a minute, keeps it with Retry, and sends it only then', async () => {
  const view = await setup({ sessionKey: 'timed-out' });
  await view.type('Waited too long'); await view.click();
  await advance(PENDING_SEND_TIMEOUT_MS - 1);
  expect(view.notice()?.textContent).toContain('Sending');
  await advance(1);
  expect(view.notice()?.textContent).toContain('Not sent');
  expect(view.notice()?.querySelector('[title]')?.getAttribute('title')).toContain('This message waited a minute and could not be sent.');
  await view.update({ connection: 'ready' });
  await advance(1000);
  expect(view.send).not.toHaveBeenCalled();
  await view.click('[aria-label="Retry pending send"]');
  expect(view.send).toHaveBeenCalledExactlyOnceWith('Waited too long');
});

it('says Check delivery for a message that left and had no answer within a minute, and keeps it until the person dismisses it', async () => {
  const send = vi.fn(() => new Promise<void>(() => {}));
  const view = await setup({ sessionKey: 'unanswered', connection: 'ready', onSendMessage: send });
  await view.type('Left, no answer'); await view.click();
  await view.type('Behind it'); await view.click();
  expect(send).toHaveBeenCalledOnce();
  await advance(PENDING_SEND_TIMEOUT_MS - 1);
  expect(view.container.querySelectorAll('[data-testid="pending-send"]')).toHaveLength(1);
  await advance(1);
  const [left, behind] = view.container.querySelectorAll('[data-testid="pending-send"]');
  expect(left!.textContent).toContain('Check delivery');
  expect(left!.querySelector('[aria-label="Retry pending send"]')).toBeNull();
  // The message behind it waited as long without leaving: it is Not sent, and Retry sends it.
  expect(behind!.textContent).toContain('Not sent');
  await view.click('[aria-label="Dismiss message after checking delivery"]');
  expect(send).toHaveBeenCalledTimes(1);
  expect(view.notice()?.textContent).toContain('Not sent');
});

it('delivers a waiting message once when two composers are mounted on one session key and can send at the same moment', async () => {
  vi.useFakeTimers();
  const firstSend = vi.fn(async () => {}), secondSend = vi.fn(async () => {});
  const both = (connection: RemoteSessionStatus) => <>
    {composer({ state, connection, sessionKey: 'shared', onSendMessage: firstSend, onCancel: vi.fn(async () => {}) })}
    {composer({ state, connection, sessionKey: 'shared', onSendMessage: secondSend, onCancel: vi.fn(async () => {}) })}
  </>;
  const container = await render(both('disconnected'));
  const input = container.querySelector('textarea')!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, 'Said once');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!.click());
  expect(container.querySelectorAll('[data-testid="pending-send"]')).toHaveLength(2);
  await rerender(container, both('ready'));
  await advance(1000);
  expect([...firstSend.mock.calls, ...secondSend.mock.calls]).toEqual([['Said once']]);
  expect(container.querySelector('[data-testid="pending-send"]')).toBeNull();
});

it('holds waiting messages until a usage limit resets, never times them out meanwhile, then sends them once, in order (gap 3)', async () => {
  const view = await setup({ sessionKey: 'limited', connection: 'ready' });
  const resetsAt = Date.now() + 2 * 60 * 60_000;
  await view.update({ state: { ...state, agent: { ...state.agent!, runtimeInfo: { ...state.agent!.runtimeInfo, usageLimit: { resetsAt } } } } });
  await view.type('First'); await view.click();
  await view.type('Second'); await view.click();
  await advance(resetsAt - Date.now() - 1);
  expect(view.send).not.toHaveBeenCalled();
  const notices = [...view.container.querySelectorAll('[data-testid="pending-send"]')];
  expect(notices.map(notice => notice.textContent?.includes('Sending') && !notice.textContent.includes('Not sent'))).toEqual([true, true]);
  await advance(1);
  expect(view.send.mock.calls).toEqual([['First'], ['Second']]);
  await advance(60 * 60_000);
  expect(view.send).toHaveBeenCalledTimes(2);
  expect(view.notice()).toBeNull();
});

it('sends at once when the usage limit the runtime reported has already reset', async () => {
  const view = await setup({ sessionKey: 'reset', connection: 'ready' });
  await view.update({ state: { ...state, agent: { ...state.agent!, runtimeInfo: { ...state.agent!.runtimeInfo, usageLimit: { resetsAt: Date.now() - 1 } } } } });
  await view.type('Now'); await view.click();
  expect(view.send).toHaveBeenCalledExactlyOnceWith('Now');
});
