import { act } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { createReplicaState } from '../replica/reducer.js';
import type { AgentReplicaState } from '../replica/types.js';
import { render, rerender } from '../test/setup.js';
import { AgentComposer } from './AgentComposer.js';
import { ResourceDownload, ResourceDownloadContext } from './ResourceDownload.js';
const state: AgentReplicaState = { ...createReplicaState(), timeline: { ...createReplicaState().timeline, initialized: true }, agent: {
  id: 'resources', providerId: 'test', createdAt: '2026-09-20T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z', status: 'idle', activeTurn: null,
  capabilities: { history: true, sendMessage: true, steer: false, cancel: false, readResource: true,
    resourceInput: { maxResources: 8, maxResourceBytes: 52428800, maxMessageBytes: 104857600 } },
  pendingInteractions: [], runtimeInfo: { providerId: 'test', status: 'idle' },
} };
const receipt = { resourceId: 'resource-final', name: 'fixture.zip', mediaType: 'application/zip', byteLength: 3, sha256: 'a'.repeat(64) };
beforeEach(() => { Range.prototype.getClientRects = () => [] as unknown as DOMRectList; Range.prototype.getBoundingClientRect = () => new DOMRect(); });
async function pick(container: HTMLElement, files = [new File(['zip'], 'fixture.zip', { type: 'application/zip' })]) {
  await act(async () => {
    const more = container.querySelector<HTMLButtonElement>('[aria-label="More actions"]'); more?.click();
  });
  const button = Array.from(container.querySelectorAll('button')).find(button => button.getAttribute('aria-label') === 'Add resources')!;
  expect(button).toBeDefined();
  await act(async () => button.click());
  const input = container.querySelector<HTMLInputElement>('[aria-label="Choose resources"]')!;
  await act(async () => { Object.defineProperty(input, 'files', { configurable: true, value: files }); input.dispatchEvent(new Event('change', { bubbles: true })); });
}
it('uploads and sends a resource-only message with a stable reference then clears its draft', async () => {
  const send = vi.fn(async () => {}); const upload = vi.fn(async () => receipt);
  const container = await render(<AgentComposer state={state} onUploadResource={upload} onSendMessageContent={send} />);
  await pick(container);
  expect(container.querySelector('[data-resource-id]')?.textContent).toBe('[resource #1]');
  expect(container.textContent).toContain('fixture.zip'); expect(container.textContent).toContain('Ready');
  await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!.click());
  expect(send).toHaveBeenCalledWith([{ type: 'resource', resourceId: 'resource-final', label: 'resource #1' }], { imageDigests: {} });
  expect(container.querySelector('[data-resource-id]')).toBeNull();
});
it('keeps failed uploads with explicit retry and removes selected resource atoms', async () => {
  const upload = vi.fn().mockRejectedValueOnce(new Error('Offline')).mockResolvedValue(receipt);
  const container = await render(<AgentComposer state={state} onUploadResource={upload} onSendMessageContent={async () => {}} />);
  await pick(container);
  expect(container.textContent).toContain('Offline');
  expect(container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!.disabled).toBe(true);
  await act(async () => Array.from(container.querySelectorAll('button')).find(button => button.textContent === 'Retry resource #1')!.click());
  expect(upload).toHaveBeenCalledTimes(2); expect(upload.mock.calls[0]?.[2]).toBe(upload.mock.calls[1]?.[2]);
  await act(async () => container.querySelector<HTMLButtonElement>('[aria-label="Remove resource #1"]')!.click());
  expect(container.querySelector('[data-resource-id]')).toBeNull();
});
it('preserves resources during reconnect without queuing a text-only message', async () => {
  const send = vi.fn(async () => {}); const upload = vi.fn(async () => receipt);
  const view = (disabled: boolean) => <AgentComposer state={state} disabled={disabled} onUploadResource={upload} onSendMessageContent={send} />;
  const container = await render(view(false)); await pick(container);
  await rerender(container, view(true));
  expect(container.querySelector('[data-resource-id]')).not.toBeNull();
  expect(container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!.disabled).toBe(true);
  await rerender(container, view(false));
  expect(upload).toHaveBeenCalledTimes(2); expect(send).not.toHaveBeenCalled();
});
it('does not offer Resource for a provider without resource capability', async () => {
  const container = await render(<AgentComposer state={{ ...state, agent: { ...state.agent!, capabilities: { ...state.agent!.capabilities, resourceInput: undefined } } }} />);
  expect(container.querySelector('[aria-label="Choose resources"]')).toBeNull();
});
it('downloads a verified resource and displays hostile filenames as plain text', async () => {
  const download = vi.fn(async () => ({ blob: new Blob(['zip']), name: '<img src=x>.zip', sha256: receipt.sha256 }));
  const createURL = vi.fn(() => 'blob:fixture'); Object.defineProperty(URL, 'createObjectURL', { configurable: true, value: createURL });
  Object.defineProperty(URL, 'revokeObjectURL', { configurable: true, value: vi.fn() });
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
  const container = await render(<ResourceDownloadContext.Provider value={download}><ResourceDownload resourceId="r" label="resource #5" name="<img src=x>.zip" byteLength={3} sha256={receipt.sha256} /></ResourceDownloadContext.Provider>);
  expect(container.querySelector('img')).toBeNull();
  await act(async () => container.querySelector('button')!.click());
  expect(download).toHaveBeenCalledWith('r'); expect(createURL).toHaveBeenCalledOnce(); expect(click).toHaveBeenCalledOnce();
});
it('rejects an oversized file selection atomically without starting any uploads', async () => {
  const upload = vi.fn(async () => receipt);
  const container = await render(<AgentComposer state={state} onUploadResource={upload} onSendMessageContent={async () => {}} />);
  await pick(container, Array.from({ length: 9 }, (_, index) => new File(['x'], `${index}.txt`)));
  expect(container.textContent).toContain('at most 8 resources'); expect(upload).not.toHaveBeenCalled();
  expect(container.querySelector('[data-resource-id]')).toBeNull();
});
it('turns an expired resource receipt into an explicit upload retry', async () => {
  const send = vi.fn().mockRejectedValueOnce(Object.assign(new Error('Expired resource.'), { code: 'invalid_resource_input' })).mockResolvedValue(undefined);
  const upload = vi.fn(async () => receipt);
  const container = await render(<AgentComposer state={state} onUploadResource={upload} onSendMessageContent={send} />);
  await pick(container); await act(async () => container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!.click());
  expect(container.querySelector<HTMLButtonElement>('[data-testid="prompt-submit"]')!.disabled).toBe(true);
  await act(async () => Array.from(container.querySelectorAll('button')).find(button => button.textContent === 'Retry resource #1')!.click());
  expect(upload).toHaveBeenCalledTimes(2); expect(send).toHaveBeenCalledTimes(1);
});
