import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { createReplicaState } from '../replica/reducer.js';
import type { AgentReplicaState } from '../replica/types.js';
import { render, rerender, unmount } from '../test/setup.js';
import { AgentComposer, type AgentComposerProps } from './AgentComposer.js';

const state: AgentReplicaState = { ...createReplicaState(), agent: {
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

it('accepts a disconnected send and dispatches exactly once after readiness', async () => {
  const view = await setup();
  await view.type('Keep this message');
  expect(view.container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!.disabled).toBe(false);
  await view.click();
  expect(view.send).not.toHaveBeenCalled();
  expect(view.notice()?.textContent).toContain('10s');
  expect(view.container.querySelector('textarea')!.value).toBe('Keep this message');
  await view.click();
  await advance(4000);
  expect(view.notice()?.textContent).toContain('6s');
  await view.update({ disabled: false, recovering: false });
  expect(view.send).toHaveBeenCalledExactlyOnceWith('Keep this message');
  expect(view.notice()).toBeNull();
  expect(view.container.querySelector('textarea')!.value).toBe('');
  await view.update({ disabled: true, recovering: true });
  await view.update({ disabled: false, recovering: false });
  expect(view.send).toHaveBeenCalledTimes(1);
});

it('expires visibly and requires manual retry even after the connection recovers', async () => {
  const view = await setup();
  await view.type('Still here');
  await view.click();
  await advance(10000);
  expect(view.notice()?.getAttribute('data-state')).toBe('warning');
  expect(view.notice()?.textContent).toContain('Not sent');
  await view.update({ disabled: false, recovering: false });
  expect(view.send).not.toHaveBeenCalled();
  await view.click('[aria-label="Retry pending send"]');
  expect(view.send).toHaveBeenCalledExactlyOnceWith('Still here');
});

it('retries with a fresh deadline while disconnected and can cancel back to an editable draft', async () => {
  const view = await setup();
  await view.type('Editable after cancel');
  await view.click();
  await advance(10000);
  await view.click('[aria-label="Retry pending send"]');
  expect(view.notice()?.textContent).toContain('10s');
  await advance(9000);
  expect(view.notice()?.getAttribute('data-state')).toBe('waiting');
  await view.click('[aria-label="Cancel pending send"]');
  expect(view.notice()).toBeNull();
  expect(view.container.querySelector('textarea')).toMatchObject({ disabled: false, value: 'Editable after cancel' });
  await view.update({ disabled: false, recovering: false });
  expect(view.send).not.toHaveBeenCalled();
});

it.each(['visibility', 'page'] as const)('does not send in the background and restarts the deadline on %s resume', async kind => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const view = await setup();
  await view.type('Foreground only');
  await view.click();
  await advance(6000);
  await act(async () => {
    if (kind === 'visibility') { visibility.mockReturnValue('hidden'); document.dispatchEvent(new Event('visibilitychange')); }
    else window.dispatchEvent(new Event('pagehide'));
  });
  await view.update({ disabled: false, recovering: false });
  await advance(30000);
  expect(view.send).not.toHaveBeenCalled();
  await view.update({ disabled: true, recovering: true });
  await act(async () => {
    if (kind === 'visibility') { visibility.mockReturnValue('visible'); document.dispatchEvent(new Event('visibilitychange')); }
    else window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true }));
  });
  expect(view.notice()?.textContent).toContain('10s');
  await advance(9999);
  expect(view.notice()?.getAttribute('data-state')).toBe('waiting');
  await advance(1);
  expect(view.notice()?.getAttribute('data-state')).toBe('warning');
});

it('does not send an expired intent after backgrounding and resuming', async () => {
  const visibility = vi.spyOn(document, 'visibilityState', 'get').mockReturnValue('visible');
  const view = await setup();
  await view.type('Expired'); await view.click(); await advance(10000);
  await act(async () => { visibility.mockReturnValue('hidden'); document.dispatchEvent(new Event('visibilitychange')); });
  await view.update({ disabled: false, recovering: false });
  await act(async () => { visibility.mockReturnValue('visible'); document.dispatchEvent(new Event('visibilitychange')); });
  expect(view.send).not.toHaveBeenCalled();
  expect(view.notice()?.getAttribute('data-state')).toBe('warning');
});

it('cancels deferred work on session changes without losing the original draft', async () => {
  const view = await setup();
  await view.type('Only for one'); await view.click();
  await view.update({ state: { ...state, agent: { ...state.agent!, id: 'two' } }, disabled: false, recovering: false });
  expect(view.send).not.toHaveBeenCalled();
  expect(view.notice()).toBeNull();
  await view.update({ state });
  expect(view.container.querySelector('textarea')!.value).toBe('Only for one');
  expect(view.send).not.toHaveBeenCalled();
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
  expect(view.notice()).toBeNull();
  expect(view.container.textContent).toContain('Delivery is not confirmed.');
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
  expect(view.notice()?.textContent).toContain('10s');
  expect(upload).not.toHaveBeenCalled();
  await view.update({ disabled: false, recovering: false });
  expect(upload).toHaveBeenCalledTimes(1);
  expect(send).not.toHaveBeenCalled();
  await act(async () => finishUpload(attachment));
  expect(send).toHaveBeenCalledExactlyOnceWith([{ type: 'text', text: 'Look at ' }, { type: 'image', attachmentId: 'image-one', label: 'image #1' }], { imageDigests: { 'image-one': 'a'.repeat(64) } });
  expect(view.notice()).toBeNull();
  expect(view.container.querySelector('[data-image-id]')).toBeNull();
});

it('keeps image atoms editable when cancelling an expired pending send', async () => {
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
  expect(view.container.querySelector('[data-image-id]')?.textContent).toBe('[image #1]');
  expect(view.container.querySelector('[role="textbox"]')?.getAttribute('aria-disabled')).toBe('false');
  expect(view.notice()).toBeNull();
  expect(send).not.toHaveBeenCalled();
});
