import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { render, rerender } from '../test/setup.js';
import { FilePreview } from './FilePreview.js';
import type { FilePreviewRequest } from './FilePreviewContext.js';
import type { ResourceBinding, ResourceResponseState } from '@orchardworks/agent-remote-protocol';

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

it('renders an HTML file in a sandboxed frame without scripts, and shows its source on request', async () => {
  const page = '<!doctype html><h1>Report</h1><img src="./chart.png" alt="Chart"><script>window.parent.fileExecuted = true</script>';
  const files: Record<string, ResourceResponseState> = {
    './report.html': { status: 'available', byteLength: page.length, mediaType: 'text/html', sha256: 'page', contentBase64: btoa(page) },
    './chart.png': { status: 'available', byteLength: 8, mediaType: 'image/png', sha256: 'chart', contentBase64: 'iVBORw0KGgo=' },
  };
  const resolved: Array<[string, string | undefined]> = [];
  const input: FilePreviewRequest = { locator: './report.html', context: { scopeKey: 'html-file', bindings: [], resources: {},
    resolveResource: async (locator, source) => { resolved.push([locator, source]); return { locator, resourceId: `html-${locator}`, status: 'available' } as ResourceBinding; },
    requestResource: async binding => files[binding.locator.replace(/^(?:\.\/)+/, './')]! } };
  const container = await render(<FilePreview request={input} onClose={() => {}} />);
  await expect.poll(() => container.querySelector('iframe')).not.toBeNull();
  const frame = container.querySelector('iframe')!;
  expect(frame.getAttribute('sandbox')).toBe('allow-popups allow-popups-to-escape-sandbox');
  expect(frame.getAttribute('title')).toBe('Rendered HTML: report.html');
  const document = frame.getAttribute('srcdoc')!;
  expect(document).toContain('<h1>Report</h1>');
  expect(document).toContain('src="data:image/png;base64,iVBORw0KGgo="');
  expect(document).not.toContain('<script');
  // Relative to the HTML file, as Markdown previews resolve their images.
  expect(resolved.map(([locator]) => locator)).toContain('././chart.png');
  expect((window as { fileExecuted?: boolean }).fileExecuted).toBeUndefined();
  expect(container.querySelector('[aria-label="Wrap lines"]')).toBeNull();
  await act(async () => (container.querySelector('[aria-label="Show HTML source"]') as HTMLButtonElement).click());
  expect(container.querySelector('iframe')).toBeNull();
  expect(container.querySelector('pre')!.textContent).toBe(page);
  expect(container.querySelector('[aria-label="Show rendered HTML"]')).not.toBeNull();
});
