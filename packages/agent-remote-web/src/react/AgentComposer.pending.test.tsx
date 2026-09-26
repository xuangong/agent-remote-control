import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { createReplicaState } from '../replica/reducer.js';
import type { AgentReplicaState } from '../replica/types.js';
import { render, rerender, unmount } from '../test/setup.js';
import { AgentComposer, type AgentComposerProps } from './AgentComposer.js';

const state: AgentReplicaState = { ...createReplicaState(), timeline: { ...createReplicaState().timeline, initialized: true }, agent: {
  id: 'one', providerId: 'test', createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z', status: 'idle', activeTurn: null,
  capabilities: { history: true, sendMessage: true, queueMessage: true, steer: false, cancel: true, commands: true, readResource: false },
  pendingInteractions: [], runtimeInfo: { providerId: 'test', status: 'idle' },
} };
const running = { ...state, agent: { ...state.agent!, status: 'running' as const, activeTurn: { turnId: 'turn-one', startedAt: '2026-09-20T00:00:00Z' } } };
afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });
const advance = (ms: number) => act(async () => { await vi.advanceTimersByTimeAsync(ms); });
async function setup(props: Partial<AgentComposerProps> = {}) {
  vi.useFakeTimers();
  const send = vi.fn(async () => {}), cancel = vi.fn(async () => {});
  let current: AgentComposerProps = { state, disabled: true, recovering: true, onSendMessage: send, onCancel: cancel, ...props };
  const container = await render(<AgentComposer {...current} />);
  const update = async (patch: Partial<AgentComposerProps>) => { current = { ...current, ...patch }; await rerender(container, <AgentComposer {...current} />); };
  const type = (text: string) => act(async () => {
    const input = container.querySelector('textarea')!;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const click = (selector = '[data-testid="prompt-submit"]') => act(async () => container.querySelector<HTMLButtonElement>(selector)!.click());
  const notice = () => container.querySelector('[data-testid="pending-send"]');
  return { container, update, send, cancel, type, click, notice };
}

it('queues multiple messages, keeps editing available and drains FIFO without changing the new draft', async () => {
  const view = await setup();
  await view.type('First'); await view.click();
  expect(view.container.querySelector('textarea')).toMatchObject({ value: '', disabled: false });
  await view.type('Second'); await view.click();
  await view.type('Still editing');
  await advance(120000);
  expect(view.container.querySelectorAll('[data-testid="pending-send"]')).toHaveLength(2);
  expect(view.send).not.toHaveBeenCalled();
  await view.update({ disabled: false, recovering: false });
  expect(view.send.mock.calls).toEqual([['First'], ['Second']]);
  expect(view.notice()).toBeNull();
  expect(view.container.querySelector('textarea')!.value).toBe('Still editing');
  await view.update({ disabled: true, recovering: true });
  await view.update({ disabled: false, recovering: false });
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
  await view.update({ disabled: false, recovering: false });
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
  await view.update({ disabled: false, recovering: false });
  await advance(120000);
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
  await view.update({ state: { ...state, agent: { ...state.agent!, id: 'two' } }, onSendMessage: otherSend, disabled: false, recovering: false });
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
  await view.update({ disabled: false, recovering: false });
  expect(execute).not.toHaveBeenCalled();
});

it('does not automatically retry an operation whose delivery became uncertain', async () => {
  const send = vi.fn(async () => { throw Object.assign(new Error('Delivery is not confirmed.'), { code: 'connection_disconnected' }); });
  const view = await setup({ onSendMessage: send });
  await view.type('Only once'); await view.click();
  await view.update({ disabled: false, recovering: false });
  expect(view.notice()?.getAttribute('data-state')).toBe('error');
  expect(view.notice()?.textContent).toContain('Check delivery');
  await view.update({ disabled: true, recovering: true }); await advance(10000);
  await view.update({ disabled: false, recovering: false });
  expect(send).toHaveBeenCalledTimes(1);
});

it('preserves read-only and unavailable restrictions during recovery', async () => {
  const view = await setup({ state: { ...state, agent: { ...state.agent!, capabilities: { ...state.agent!.capabilities, sendMessage: false } } } });
  expect(view.container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!.disabled).toBe(true);
  await view.update({ state: { ...state, agent: { ...state.agent!, runtimeInfo: { ...state.agent!.runtimeInfo, connection: { state: 'unavailable' } } } } });
  await view.type('Cannot send');
  expect(view.container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!.disabled).toBe(true);
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
  await view.update({ disabled: false, recovering: false });
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
  await view.update({ disabled: false, recovering: false });
  expect(view.notice()?.getAttribute('data-state')).toBe('sending');
  expect(view.container.querySelector<HTMLButtonElement>('[aria-label="Dismiss message after checking delivery"]')!.disabled).toBe(true);
  await view.type('Second'); await view.click();
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
  await view.update({ disabled: false, recovering: false });
  expect(send).toHaveBeenCalledTimes(1);
  expect(view.container.querySelector('[aria-label="Retry pending send"]')).toBeNull();
  await view.click('[aria-label="Dismiss message after checking delivery"]');
  expect(send.mock.calls).toEqual([['Uncertain'], ['Later']]);
});

it('waits for confirmed control and preserves the queue when another browser owns the session', async () => {
  const view = await setup();
  await view.type('After control'); await view.click();
  await view.update({ disabled: false, recovering: false, state: { ...state, sessionControl: { access: 'checking', available: false } } });
  expect(view.send).not.toHaveBeenCalled();
  await view.update({ readOnly: true, state: { ...state, sessionControl: { access: 'read_only', available: true } } });
  expect(view.send).not.toHaveBeenCalled();
  expect(view.notice()).not.toBeNull();
  await view.update({ readOnly: false, state });
  expect(view.send).toHaveBeenCalledExactlyOnceWith('After control');
});

it('accepts messages during native recovery even without the outer recovery hint', async () => {
  const view = await setup({ disabled: false, recovering: false, state: { ...state, agent: { ...state.agent!, runtimeInfo: { ...state.agent!.runtimeInfo, connection: { state: 'restoring' } } } } });
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
  await view.update({ disabled: false, recovering: false });
  expect(upload).toHaveBeenCalledTimes(1);
  await view.update({ disabled: true, recovering: true });
  expect(upload.mock.calls[0]?.[2]?.signal?.aborted).toBe(true);
  await act(async () => finish({ ...attachment, attachmentId: 'stale' }));
  expect(send).not.toHaveBeenCalled();
  await view.update({ disabled: false, recovering: false });
  expect(upload).toHaveBeenCalledTimes(2);
  await act(async () => finish(attachment));
  expect(send).toHaveBeenCalledExactlyOnceWith([{ type: 'image', attachmentId: 'fresh', label: 'image #1' }], { imageDigests: { fresh: 'b'.repeat(64) } });
});

it('queues input when control is checking even if the transport reports ready', async () => {
  const view = await setup({ disabled: false, recovering: false, state: { ...state, sessionControl: { access: 'checking', available: false } } });
  await view.type('Wait for control'); await view.click();
  expect(view.send).not.toHaveBeenCalled();
  expect(view.container.querySelector('textarea')!.value).toBe('');
  await view.update({ state });
  expect(view.send).toHaveBeenCalledExactlyOnceWith('Wait for control');
});

it('uses public synchronization and operation admission without legacy disabled props', async () => {
  const { remoteSessionState } = await import('../client/session-state.js');
  const view = await setup({ disabled: false, recovering: false, sessionState: remoteSessionState(state, 'connecting') });
  expect(view.container.querySelector('[data-testid="agent-activity-label"]')!.textContent).toBe('Waiting for session');
  await view.type('Wait for synchronization');
  await view.click();
  expect(view.send).not.toHaveBeenCalled();
  expect(view.notice()?.textContent).toContain('Wait for synchronization');
  const ready = remoteSessionState(state, 'ready');
  await view.update({ sessionState: { ...ready, operations: { ...ready.operations, send_message: { allowed: false, code: 'blocked', reason: 'Input unavailable' } } } });
  await advance(1000);
  expect(view.send).not.toHaveBeenCalled();
  await view.type('Another draft');
  expect(view.container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!.disabled).toBe(true);
  await view.update({ sessionState: ready });
  expect(view.send).toHaveBeenCalledExactlyOnceWith('Wait for synchronization');
  expect(view.container.querySelector('textarea')!.value).toBe('Another draft');
});
