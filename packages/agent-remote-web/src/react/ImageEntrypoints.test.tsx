import { act } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { render, rerender } from '../test/setup.js';
import { FilePreview } from './FilePreview.js';
import { FilePreviewContext, type FilePreviewRequest } from './FilePreviewContext.js';
import { MarkdownContent } from './MarkdownContent.js';
import { ResourceCard } from './ResourceCard.js';
import { PreviewWorkspace } from './PreviewWorkspace.js';
import type { ResourceResponseState } from '@orchardworks/agent-remote-protocol';

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'show', { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.open = false; } });
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
});

function cachedImage(scopeKey: string) {
  const binding = { locator: './picture.png', resourceId: scopeKey, status: 'available' as const };
  const detail = { status: 'available' as const, mediaType: 'image/png', byteLength: 1, sha256: 'first', contentBase64: 'AA==' };
  return { binding, detail, context: { scopeKey, bindings: [binding], resources: { [scopeKey]: detail },
    resolveResource: vi.fn(async () => binding), requestResource: vi.fn(async () => detail) } };
}

it.each([false, true])('opens loaded Markdown images without another resource request (file workspace: %s)', async workspace => {
  const { context } = cachedImage(`markdown-viewer-${workspace}`);
  const openFile = vi.fn();
  const content = <MarkdownContent markdown="![Cached picture](./picture.png)" resourceContext={context} />;
  const container = await render(workspace ? <FilePreviewContext.Provider value={{ open: openFile }}>{content}</FilePreviewContext.Provider> : content);
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Open image: Cached picture"]');
  expect(trigger).not.toBeNull();
  trigger!.focus();
  await act(async () => trigger!.click());
  expect(document.querySelector('dialog[aria-label="Image preview"] img')?.getAttribute('src')).toBe('data:image/png;base64,AA==');
  expect(openFile).not.toHaveBeenCalled();
  expect(context.resolveResource).not.toHaveBeenCalled();
  expect(context.requestResource).not.toHaveBeenCalled();
  await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Close image preview"]')!.click());
  expect(document.querySelector('dialog[aria-label="Image preview"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
});

it('preserves linked Markdown image activation without nested interactive elements', async () => {
  const { context } = cachedImage('linked-image-viewer');
  const opened: string[] = [];
  const container = await render(<FilePreviewContext.Provider value={{ open: request => opened.push(request.locator) }}>
    <MarkdownContent markdown={'[![Local picture](./picture.png)](./report.md) [![Web picture](./picture.png)](https://example.com)'} resourceContext={context} />
  </FilePreviewContext.Provider>);
  expect(container.querySelector('button button, a button, button a')).toBeNull();
  expect(container.querySelectorAll('img')).toHaveLength(2);
  await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
  expect(opened).toEqual(['./report.md']);
  expect(container.querySelector('a')?.getAttribute('href')).toBe('https://example.com');
  expect(document.querySelector('dialog[aria-label="Image preview"]')).toBeNull();
});

it('closes a loaded image when its surrounding conversation changes scope', async () => {
  const { context } = cachedImage('retained-resource-cache');
  const content = <MarkdownContent markdown="![Cached picture](./picture.png)" resourceContext={context} />;
  const container = await render(<PreviewWorkspace resourceScope="conversation-one">{content}</PreviewWorkspace>);
  await act(async () => container.querySelector<HTMLButtonElement>('button[aria-label="Open image: Cached picture"]')!.click());
  expect(document.querySelector('dialog[aria-label="Image preview"]')).not.toBeNull();
  await rerender(container, <PreviewWorkspace resourceScope="conversation-two">{content}</PreviewWorkspace>);
  expect(document.querySelector('dialog[aria-label="Image preview"]')).toBeNull();
});

it('keeps the Markdown image frame mounted when loading bytes enables its viewer', async () => {
  const { binding, detail } = cachedImage('image-frame-viewer');
  const { contentBase64: _bytes, ...metadata } = detail;
  let finish!: (value: ResourceResponseState) => void;
  const context = { scopeKey: 'image-frame-viewer', bindings: [binding], resources: { [binding.resourceId]: metadata },
    resolveResource: async () => binding, requestResource: () => new Promise<ResourceResponseState>(resolve => { finish = resolve; }) };
  const container = await render(<MarkdownContent markdown="![Loading picture](./picture.png)" resourceContext={context} />);
  const frame = container.querySelector('.agent-markdown-image');
  await act(async () => finish(detail));
  await rerender(container, <MarkdownContent markdown="![Loading picture](./picture.png)" resourceContext={{ ...context, resources: { [binding.resourceId]: detail } }} />);
  expect(container.querySelector('.agent-markdown-image')).toBe(frame);
  expect(container.querySelector<HTMLButtonElement>('button[aria-label="Open image: Loading picture"]')?.disabled).toBe(false);
});

it('opens resource card image bytes in the viewer while preserving its download', async () => {
  const { binding, detail } = cachedImage('resource-card-viewer');
  const request = vi.fn(async () => {});
  const container = await render(<ul><ResourceCard binding={binding} detail={detail} pending={false} onRequest={request} /></ul>);
  const trigger = container.querySelector<HTMLButtonElement>('button[aria-label="Open image: picture.png"]');
  expect(trigger).not.toBeNull();
  await act(async () => trigger!.click());
  expect(document.querySelector('dialog[aria-label="Image preview"] img')?.getAttribute('src')).toBe('data:image/png;base64,AA==');
  expect(container.querySelector('a[download]')?.getAttribute('href')).toBe('data:image/png;base64,AA==');
  expect(request).not.toHaveBeenCalled();
});

it('opens resolved image files directly and refreshes through the existing resource path', async () => {
  let revision = 0;
  const onClose = vi.fn();
  const input: FilePreviewRequest = { locator: './picture.png', context: { scopeKey: 'file-image-viewer', bindings: [], resources: {},
    resolveResource: async locator => ({ locator, resourceId: `file-image-${++revision}`, status: 'available' }),
    requestResource: async () => ({ status: 'available', mediaType: 'image/png', byteLength: 1, sha256: String(revision), contentBase64: revision === 1 ? 'AA==' : 'AQ==' }) } };
  await render(<FilePreview request={input} onClose={onClose} />);
  await expect.poll(() => document.querySelector('dialog[aria-label="Image preview"] img')?.getAttribute('src')).toBe('data:image/png;base64,AA==');
  expect(document.querySelector('dialog[aria-label="File preview"]')).toBeNull();
  await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Refresh file"]')!.click());
  await expect.poll(() => document.querySelector('dialog[aria-label="Image preview"] img')?.getAttribute('src')).toBe('data:image/png;base64,AQ==');
  expect(revision).toBe(2);
  await act(async () => document.querySelector<HTMLButtonElement>('button[aria-label="Close image preview"]')!.click());
  expect(onClose).toHaveBeenCalledOnce();
});

it('hides the prior file image while another resource scope is loading', async () => {
  const first = cachedImage('file-image-scope-one');
  const input: FilePreviewRequest = { locator: './picture.png', context: first.context };
  const container = await render(<FilePreview request={input} onClose={() => {}} />);
  await expect.poll(() => document.querySelector('dialog[aria-label="Image preview"] img')).not.toBeNull();
  let finish!: (value: ResourceResponseState) => void;
  const next: FilePreviewRequest = { locator: './picture.png', context: { scopeKey: 'file-image-scope-two', bindings: [], resources: {},
    resolveResource: async locator => ({ locator, resourceId: 'other-file-image', status: 'available' }),
    requestResource: () => new Promise(resolve => { finish = resolve; }) } };
  await rerender(container, <FilePreview request={next} onClose={() => {}} />);
  expect(document.querySelector('dialog[aria-label="Image preview"]')).toBeNull();
  expect(container.textContent).toContain('Loading file');
  await act(async () => finish({ status: 'available', mediaType: 'image/png', byteLength: 1, sha256: 'second', contentBase64: 'AQ==' }));
  expect(document.querySelector('dialog[aria-label="Image preview"] img')?.getAttribute('src')).toBe('data:image/png;base64,AQ==');
});
