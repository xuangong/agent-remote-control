import { act } from 'react';
import { expect, it, vi } from 'vitest';
import { createReplicaState } from '../replica/reducer.js';
import type { AgentReplicaState } from '../replica/types.js';
import { render, rerender } from '../test/setup.js';
import { AgentComposer } from './AgentComposer.js';

it('allows cached-session drafts while synchronizing but waits for readiness to send or execute commands', async () => {
  const state: AgentReplicaState = { ...createReplicaState(), agent: {
    id: 'cached', providerId: 'test', createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z', status: 'idle', activeTurn: null,
    capabilities: { history: true, sendMessage: true, steer: false, cancel: false, readResource: false },
    pendingInteractions: [], runtimeInfo: { providerId: 'test', status: 'idle' },
  } };
  let resolve!: () => void;
  const send = vi.fn(() => new Promise<void>(done => { resolve = done; }));
  const command = vi.fn(async () => ({}));
  const draft = vi.fn();
  const view = (disabled: boolean, current = state) => <AgentComposer state={current} disabled={disabled} onDraftChange={draft}
    onSendMessage={send} consoleCommands={[{ id: 'side', name: 'side', kind: 'command', description: 'Open a side conversation' }]} onExecuteConsoleCommand={command} />;
  const container = await render(view(true));
  const input = container.querySelector('textarea')!;
  const type = (value: string) => act(async () => {
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')!.set!.call(input, value);
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  const enter = () => act(async () => input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
  expect(input.disabled).toBe(false);
  expect(input.placeholder).toBe('Message…');
  expect(container.querySelector('[data-testid="agent-activity"]')?.getAttribute('data-active')).toBe('false');
  expect(container.querySelector('[data-testid="agent-activity-label"]')?.textContent).toBe('Waiting for session');
  await type('Draft during synchronization');
  expect(draft).toHaveBeenLastCalledWith('Draft during synchronization');
  expect(container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!.disabled).toBe(true);
  await enter();
  expect(send).not.toHaveBeenCalled();
  await type('/side');
  await enter();
  expect(command).not.toHaveBeenCalled();
  expect(container.querySelector<HTMLButtonElement>('[aria-label="Open chat commands"]')!.disabled).toBe(true);
  await type('Draft during synchronization');
  await rerender(container, view(false));
  expect(input.placeholder).toBe('Message…');
  expect(input.value).toBe('Draft during synchronization');
  await enter();
  expect(send).toHaveBeenCalledExactlyOnceWith('Draft during synchronization');
  expect(input.disabled).toBe(true);
  await act(async () => resolve());
  expect(input.disabled).toBe(false);
  await rerender(container, view(true, { ...state, agent: { ...state.agent!, capabilities: { ...state.agent!.capabilities, sendMessage: false } } }));
  expect(input.disabled).toBe(true);
  await rerender(container, view(true, createReplicaState()));
  expect(input.disabled).toBe(true);
});

it('keeps image atoms through reconnect and sends ordered image-only content with digest identity', async () => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  const state: AgentReplicaState = { ...createReplicaState(), agent: {
    id: 'images', providerId: 'test', createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z', status: 'idle', activeTurn: null,
    capabilities: { history: true, sendMessage: true, steer: false, cancel: false, readResource: true, imageInput: { mediaTypes: ['image/png'], maxImages: 8, maxImageBytes: 10485760, maxMessageBytes: 20971520 } },
    pendingInteractions: [], runtimeInfo: { providerId: 'test', status: 'idle' },
  } };
  const attachment = { attachmentId: 'image-a', sha256: 'a'.repeat(64), mediaType: 'image/png' as const, byteLength: 1, imageDimensions: { width: 1, height: 1 } };
  const upload = vi.fn(async () => attachment);
  const send = vi.fn(async () => {});
  const command = vi.fn(async () => ({}));
  const view = (disabled: boolean) => <AgentComposer state={state} disabled={disabled} onSendMessageContent={send} onUploadImage={disabled ? undefined : upload} consoleCommands={[{ id: 'side', name: 'side', kind: 'command', description: 'Side' }]} onExecuteConsoleCommand={command} />;
  const container = await render(view(true));
  const paste = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(paste, 'clipboardData', { value: { files: [new File(['x'], 'x.png', { type: 'image/png' })], getData: () => '' } });
  await act(async () => container.querySelector('[role="textbox"]')!.dispatchEvent(paste));
  expect(container.querySelector('[data-image-id]')?.textContent).toBe('[image #1]');
  expect(upload).not.toHaveBeenCalled();
  expect(container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!.disabled).toBe(true);
  await rerender(container, view(false));
  expect(upload).toHaveBeenCalledTimes(1);
  expect(container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!.disabled).toBe(false);
  await act(async () => container.querySelector('[role="textbox"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
  expect(send).toHaveBeenCalledWith([{ type: 'image', attachmentId: 'image-a', label: 'image #1' }], { imageDigests: { 'image-a': 'a'.repeat(64) } });
  expect(container.querySelector('[data-image-id]')).toBeNull();
  const commandPaste = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(commandPaste, 'clipboardData', { value: { files: [], getData: (type: string) => type === 'text/plain' ? '/side' : '' } });
  await act(async () => container.querySelector('[role="textbox"]')!.dispatchEvent(commandPaste));
  await act(async () => container.querySelector('[role="textbox"]')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
  expect(command).toHaveBeenCalledWith('side', '');
  expect(container.querySelector('[role="textbox"]')?.textContent).toBe('');
});

it('offers explicit upload retry after the Host rejects an expired attachment', async () => {
  Object.defineProperties(HTMLDialogElement.prototype, {
    showModal: { configurable: true, value() { this.open = true; } },
    close: { configurable: true, value() { this.open = false; } },
  });
  Object.defineProperties(URL, {
    createObjectURL: { configurable: true, value: () => 'blob:test-image' },
    revokeObjectURL: { configurable: true, value: () => {} },
  });
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  const state: AgentReplicaState = { ...createReplicaState(), agent: {
    id: 'expired-image', providerId: 'test', createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z', status: 'idle', activeTurn: null,
    capabilities: { history: true, sendMessage: true, steer: false, cancel: false, readResource: true, imageInput: { mediaTypes: ['image/png'], maxImages: 8, maxImageBytes: 10485760, maxMessageBytes: 20971520 } },
    pendingInteractions: [], runtimeInfo: { providerId: 'test', status: 'idle' },
  } };
  const attachment = { attachmentId: 'expired', sha256: 'a'.repeat(64), mediaType: 'image/png' as const, byteLength: 1, imageDimensions: { width: 1, height: 1 } };
  const upload = vi.fn(async (_blob: Blob, _uploadId: string) => attachment);
  const send = vi.fn().mockRejectedValueOnce(Object.assign(new Error('Attachment expired.'), { code: 'invalid_image_input' })).mockResolvedValue(undefined);
  const container = await render(<AgentComposer state={state} onSendMessageContent={send} onUploadImage={upload} />);
  const editor = container.querySelector('[role="textbox"]')!;
  const paste = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(paste, 'clipboardData', { value: { files: [new File(['x'], 'x.png', { type: 'image/png' })], getData: () => '' } });
  await act(async () => editor.dispatchEvent(paste));
  await act(async () => editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
  expect(container.querySelector('[data-image-id]')?.getAttribute('data-state')).toBe('failed');
  expect(container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!.disabled).toBe(true);
  expect(send).toHaveBeenCalledTimes(1);
  await act(async () => {
    (editor as HTMLElement).focus();
    document.getSelection()!.collapse(editor, 1);
    document.dispatchEvent(new Event('selectionchange'));
    await new Promise(resolve => setTimeout(resolve, 30));
  });
  await act(async () => editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', keyCode: 37, bubbles: true, cancelable: true })));
  await act(async () => editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })));
  const retry = Array.from(document.querySelectorAll('dialog button')).find(button => button.textContent === 'Retry')! as HTMLButtonElement;
  expect(retry).toBeDefined();
  upload.mockResolvedValue({ ...attachment, attachmentId: 'replacement' });
  await act(async () => retry.click());
  expect(upload.mock.calls[1]?.[1]).not.toBe(upload.mock.calls[0]?.[1]);
  expect(send).toHaveBeenCalledTimes(1);
  await act(async () => document.querySelector<HTMLButtonElement>('[aria-label="Close image preview"]')!.click());
  await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!.click());
  expect(send.mock.calls[1]?.[0]).toEqual([{ type: 'image', attachmentId: 'replacement', label: 'image #1' }]);
});
