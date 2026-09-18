import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { render, rerender } from '../test/setup.js';
import { FilePreview } from './FilePreview.js';
import type { FilePreviewRequest } from './FilePreviewContext.js';
import type { ResourceBinding, ResourceResponseState } from '@agent-remote-controller/agent-remote-protocol';

vi.mock('./usePreviewVisibility.js', () => ({ usePreviewVisibility: () => {} }));
vi.mock('./ReadOnlyCode.js', () => ({ default: ({ text }: { text: string }) => <pre>{text}</pre> }));
afterEach(() => { vi.useRealTimers(); });

function request(scopeKey: string, read: () => Promise<ResourceResponseState>): FilePreviewRequest {
  return { locator: './file.ts', context: { scopeKey, bindings: [], resources: {},
    resolveResource: async locator => ({ locator, resourceId: scopeKey, status: 'available' }), requestResource: read } };
}
function contents(text: string): ResourceResponseState {
  return { status: 'available', byteLength: text.length, mediaType: 'text/plain', sha256: 'digest', contentBase64: btoa(text) };
}

it('ignores a slow response after switching to another file', async () => {
  let finish!: (value: ResourceResponseState) => void;
  const first = request('slow-file', () => new Promise(resolve => { finish = resolve; }));
  const second = request('fast-file', async () => contents('current file'));
  const container = await render(<FilePreview request={first} onClose={() => {}} />);
  await rerender(container, <FilePreview request={second} onClose={() => {}} />);
  await expect.poll(() => container.textContent).toContain('current file');
  await act(async () => finish(contents('obsolete file')));
  expect(container.textContent).not.toContain('obsolete file');
});

it('times out without applying late bytes and retries with a fresh resolution', async () => {
  vi.useFakeTimers();
  let finish!: (value: ResourceResponseState) => void;
  let resolutions = 0;
  let read = () => new Promise<ResourceResponseState>(resolve => { finish = resolve; });
  const base = request('timeout-file', () => read());
  const input: FilePreviewRequest = { ...base, context: { ...base.context,
    resolveResource: async locator => ({ locator, resourceId: `timeout-${++resolutions}`, status: 'available' } as ResourceBinding) } };
  const container = await render(<FilePreview request={input} onClose={() => {}} />);
  await act(async () => vi.advanceTimersByTimeAsync(20_000));
  expect(container.textContent).toContain('timed out');
  await act(async () => finish(contents('late content')));
  expect(container.textContent).not.toContain('late content');
  read = async () => contents('retried content');
  await act(async () => Array.from(container.querySelectorAll('button')).find(button => button.textContent === 'Retry')!.click());
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(resolutions).toBe(2);
  expect(container.textContent).toContain('retried content');
});
