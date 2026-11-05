import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { render, rerender } from '../test/setup.js';
import { FilePreview } from './FilePreview.js';
import { FilePreviewContext, type FilePreviewRequest } from './FilePreviewContext.js';
import { FILE_FRAME_MESSAGE, FILE_FRAME_PATH } from '@orchardworks/agent-remote-protocol';
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

function htmlRequest(page: string): { input: FilePreviewRequest; resolved: string[] } {
  const files: Record<string, ResourceResponseState> = {
    './report.html': { status: 'available', byteLength: page.length, mediaType: 'text/html', sha256: 'page', contentBase64: btoa(page) },
    './chart.png': { status: 'available', byteLength: 8, mediaType: 'image/png', sha256: 'chart', contentBase64: 'iVBORw0KGgo=' },
  };
  const resolved: string[] = [];
  return { resolved, input: { locator: './report.html', context: { scopeKey: `html-${page.length}`, bindings: [], resources: {},
    resolveResource: async locator => { resolved.push(locator); return { locator, resourceId: `html-${page.length}-${locator}`, status: 'available' } as ResourceBinding; },
    requestResource: async binding => files[binding.locator.replace(/^(?:\.\/)+/, './')]! } } };
}
const page = '<!doctype html><h1>Report</h1><img src="./chart.png" alt="Chart"><a href="./main.ts">Main</a><script>document.body.dataset.ran = "yes"</script>';

it('runs an HTML file with its scripts in the file frame, and opens its local links in the file preview', async () => {
  const { input, resolved } = htmlRequest(page);
  const opened: FilePreviewRequest[] = [];
  const container = await render(<FilePreviewContext.Provider value={{ open: request => opened.push(request) }}><FilePreview request={input} onClose={() => {}} /></FilePreviewContext.Provider>);
  await expect.poll(() => container.querySelector('iframe')).not.toBeNull();
  const frame = container.querySelector('iframe')!;
  expect(frame.getAttribute('src')).toBe(FILE_FRAME_PATH);
  expect(frame.getAttribute('sandbox')).toBe('allow-scripts allow-popups allow-popups-to-escape-sandbox');
  expect(frame.hidden).toBe(true);
  const sent: unknown[] = [];
  frame.contentWindow!.postMessage = (message: unknown) => { sent.push(message); };
  const fromFrame = (data: unknown, source: Window | null = frame.contentWindow) => act(async () => { window.dispatchEvent(new MessageEvent('message', { data, source })); });
  await fromFrame({ type: FILE_FRAME_MESSAGE, state: 'ready' }, window);
  expect(frame.hidden).toBe(true);
  await fromFrame({ type: FILE_FRAME_MESSAGE, state: 'ready' });
  await expect.poll(() => sent.length).toBe(1);
  expect(frame.hidden).toBe(false);
  const copy = (sent[0] as { type: string; html: string });
  expect(copy.type).toBe(FILE_FRAME_MESSAGE);
  expect(copy.html).toContain('document.body.dataset.ran = "yes"');
  expect(copy.html).toContain('src="data:image/png;base64,iVBORw0KGgo="');
  expect(copy.html).toContain('data-agent-file-link="./main.ts"');
  // Relative to the HTML file, as Markdown previews resolve their images.
  expect(resolved).toContain('././chart.png');
  await fromFrame({ type: FILE_FRAME_MESSAGE, state: 'ready' });
  expect(sent).toHaveLength(1);
  await fromFrame({ type: FILE_FRAME_MESSAGE, open: './main.ts' });
  expect(opened.map(request => [request.locator, request.sourceLocator])).toEqual([['./main.ts', './report.html']]);
  expect(container.querySelector('[aria-label="Wrap lines"]')).toBeNull();
  await act(async () => (container.querySelector('[aria-label="Show HTML source"]') as HTMLButtonElement).click());
  expect(container.querySelector('iframe')).toBeNull();
  expect(container.querySelector('pre')!.textContent).toBe(page);
  expect(container.querySelector('[aria-label="Show rendered HTML"]')).not.toBeNull();
});

it('shows a static copy without scripts where the website does not serve the file frame', async () => {
  vi.useFakeTimers();
  const { input } = htmlRequest(`${page}<!-- static -->`);
  const container = await render(<FilePreview request={input} onClose={() => {}} />);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  const frame = container.querySelector('iframe')!;
  expect(frame.getAttribute('src')).toBe(FILE_FRAME_PATH);
  await act(async () => { frame.dispatchEvent(new Event('load')); await vi.advanceTimersByTimeAsync(1_000); });
  const fallback = container.querySelector('iframe')!;
  expect(fallback.hasAttribute('src')).toBe(false);
  expect(fallback.getAttribute('sandbox')).toBe('allow-popups allow-popups-to-escape-sandbox');
  const copy = fallback.getAttribute('srcdoc')!;
  expect(copy).toContain('<h1>Report</h1>');
  expect(copy).not.toContain('<script');
  expect(copy).not.toContain('data-agent-file-link');
});
