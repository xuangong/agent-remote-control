import { act } from 'react';
import { beforeEach, expect, it, vi } from 'vitest';
import { render, rerender } from '../test/setup.js';
import { HttpPreviewClient } from '../client/preview-client.js';
import { PreviewProvider } from './PreviewContext.js';
import { PreviewWorkspace } from './PreviewWorkspace.js';
import { MarkdownContent } from './MarkdownContent.js';
import { FilePreviewScope } from './FilePreviewScope.js';

beforeEach(() => {
  Object.defineProperty(HTMLDialogElement.prototype, 'showModal', { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'show', { configurable: true, value(this: HTMLDialogElement) { this.open = true; } });
  Object.defineProperty(HTMLDialogElement.prototype, 'close', { configurable: true, value(this: HTMLDialogElement) { this.open = false; } });
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }) });
});

it.each(['replace', 'unmount'] as const)('retires only files belonging to a global conversation when it is changed by %s', async action => {
  const requested: string[] = [];
  const context = { scopeKey: `scope-lifetime-${action}`, bindings: [], resources: {},
    resolveResource: async (locator: string) => { requested.push(locator); return { locator, resourceId: locator, status: 'available' as const }; },
    requestResource: async () => ({ status: 'available' as const, mediaType: 'text/markdown', byteLength: 11, sha256: 'a', contentBase64: btoa('Source file') }) };
  const client = new HttpPreviewClient('http://preview.invalid');
  const content = (askScope: string, shown = true) => <PreviewProvider client={client} hostId="host" canManage={false} enabled={false}>
    {shown ? <FilePreviewScope resourceScope={askScope}><aside data-global-conversation>
      <MarkdownContent markdown="[Ask file](./ask.md)" resourceContext={context} />
    </aside></FilePreviewScope> : null}
    <PreviewWorkspace resourceScope="main"><MarkdownContent markdown="[Main file](./main.md)" resourceContext={context} /></PreviewWorkspace>
  </PreviewProvider>;
  const container = await render(content('ask-a'));
  await act(async () => container.querySelector<HTMLButtonElement>('[data-global-conversation] .agent-resource-link')!.click());
  await expect.poll(() => container.querySelector('.agent-file-body')?.textContent).toBe('Source file');
  await rerender(container, content('ask-b', action !== 'unmount'));
  expect(container.querySelector('.agent-file-preview')).toBeNull();
  await act(async () => container.querySelector<HTMLButtonElement>('.agent-preview-workspace-content .agent-resource-link')!.click());
  await expect.poll(() => container.querySelector('.agent-file-body')?.textContent).toBe('Source file');
  await rerender(container, content('ask-c', true));
  expect(container.querySelector('.agent-file-body')?.textContent).toBe('Source file');
  expect(requested).toEqual(['./ask.md', './main.md']);
});

it('opens a global conversation file in the shared preview workspace independently of the main scope', async () => {
  const requests: string[] = [];
  const context = { scopeKey: 'ask-a', bindings: [], resources: {},
    resolveResource: async (locator: string) => { requests.push(locator); return { locator, resourceId: locator, status: 'available' as const }; },
    requestResource: async () => ({ status: 'available' as const, mediaType: 'text/markdown', byteLength: 29, sha256: 'a', contentBase64: btoa('Ask source A [next](next.md)') }) };
  const client = new HttpPreviewClient('http://preview.invalid');
  const content = (main: string) => <PreviewProvider client={client} hostId="host" canManage={false} enabled={false}>
    <aside data-global-conversation><MarkdownContent markdown="[Read report](./report.md)" resourceContext={context} /></aside>
    <PreviewWorkspace resourceScope={main}><p>Main conversation</p></PreviewWorkspace>
  </PreviewProvider>;
  const container = await render(content('main-a'));
  const link = container.querySelector<HTMLButtonElement>('[data-global-conversation] .agent-resource-link');
  expect(link).not.toBeNull();
  await act(async () => link!.click());
  await expect.poll(() => container.querySelector('.agent-file-body')?.textContent).toContain('Ask source A');
  expect(container.querySelector('.agent-file-preview')?.parentElement?.classList.contains('agent-preview-workspace')).toBe(true);
  await rerender(container, content('main-b'));
  expect(container.querySelector('.agent-file-body')?.textContent).toContain('Ask source A');
  await act(async () => container.querySelector<HTMLButtonElement>('.agent-file-preview .agent-resource-link')!.click());
  await expect.poll(() => requests).toEqual(['./report.md', './next.md']);
  expect(container.querySelectorAll('.agent-file-preview')).toHaveLength(1);
});
