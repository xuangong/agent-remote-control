import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { render, rerender } from '../test/setup.js';
import { FilePreviewContext } from './FilePreviewContext.js';
import { MarkdownContent } from './MarkdownContent.js';

describe('MarkdownContent', () => {
  it('renders file tables with inline code, alignment, and escaped cell separators', async () => {
    const container = await render(<MarkdownContent markdown={[
      'The workspace contains these files:',
      '',
      '| File | Content |',
      '| :--- | ---: |',
      '| `live-fixture.txt` | `live-dsh-fixture-content` |',
      '| `joint-allowed-proof.txt` | left \\| right |',
    ].join('\n')} />);

    const table = container.querySelector('table');
    expect(table).not.toBeNull();
    expect(Array.from(table!.querySelectorAll('th'), (cell) => cell.textContent)).toEqual(['File', 'Content']);
    expect(table!.querySelectorAll('tbody tr')).toHaveLength(2);
    expect(table!.querySelector('td code')?.textContent).toBe('live-fixture.txt');
    expect(table!.querySelector('tbody tr:last-child td:last-child')?.textContent).toBe('left | right');
    expect(table!.querySelector<HTMLTableCellElement>('th:last-child')?.style.textAlign).toBe('right');
  });

  it('preserves nested formatting in lists and quoted paragraphs', async () => {
    const container = await render(<MarkdownContent markdown={[
      '> **Read** the [guide](https://example.com/guide).',
      '',
      '3. Inspect the workspace',
      '   - Keep `notes.md`',
      '   - ~~Remove everything~~',
      '4. Report the result',
    ].join('\n')} />);

    expect(container.querySelector('blockquote strong')?.textContent).toBe('Read');
    expect(container.querySelector('blockquote a')?.getAttribute('href')).toBe('https://example.com/guide');
    expect(container.querySelector('ol')?.getAttribute('start')).toBe('3');
    expect(container.querySelector('ol > li > ul code')?.textContent).toBe('notes.md');
    expect(container.querySelector('del')?.textContent).toBe('Remove everything');
  });

  it('keeps an unfinished streamed code fence readable until its closing fence arrives', async () => {
    const partial = '```bash\nprintf "hello"';
    const container = await render(<MarkdownContent markdown={partial} />);

    expect(container.querySelector('pre code')?.textContent?.trimEnd()).toBe('printf "hello"');
    await rerender(container, <MarkdownContent markdown={`${partial}\n\`\`\`\n\n**Done**`} />);
    expect(container.querySelector('pre code')?.textContent?.trimEnd()).toBe('printf "hello"');
    expect(container.querySelector('strong')?.textContent).toBe('Done');
  });

  it('represents soft and explicit line breaks as one break each', async () => {
    const container = await render(<MarkdownContent markdown={'First\nSecond  \nThird\\\nFourth'} />);

    expect(container.querySelectorAll('p br')).toHaveLength(3);
    expect(container.querySelector('p')?.textContent).toContain('Fourth');
  });

  it('keeps footnote references and back references navigable', async () => {
    const container = await render(<>
      <MarkdownContent markdown={'First note[^detail].\n\n[^detail]: First supporting detail.'} />
      <MarkdownContent markdown={'Second note[^detail].\n\n[^detail]: Second supporting detail.'} />
    </>);

    for (const markdown of container.querySelectorAll('.agent-markdown')) {
      const reference = markdown.querySelector<HTMLAnchorElement>('[data-footnote-ref]');
      const backReference = markdown.querySelector<HTMLAnchorElement>('[data-footnote-backref]');
      expect(reference).not.toBeNull();
      expect(backReference).not.toBeNull();
      expect(markdown.contains(document.getElementById(reference!.hash.slice(1)))).toBe(true);
      expect(document.getElementById(backReference!.hash.slice(1))).toBe(reference);
      expect(markdown.contains(document.getElementById(reference!.getAttribute('aria-describedby')!))).toBe(true);
      expect(backReference?.getAttribute('aria-label')).toBeTruthy();
    }
  });

  it('leaves HTML inert, rejects executable links, and represents images without loading them', async () => {
    const container = await render(<MarkdownContent markdown={[
      '<script>window.injected = true</script>',
      '',
      '<img src="https://example.com/raw.png" onerror="alert(1)">',
      '',
      '[unsafe](javascript:alert%281%29) [data](data:text/html,hello)',
      '',
      '[local](/docs/guide) [section](#result) [mail](mailto:hello@example.com)',
      '',
      '![Diagram](https://example.com/diagram.png)',
    ].join('\n')} />);

    expect(container.querySelector('script, img')).toBeNull();
    expect(container.textContent).toContain('<script>window.injected = true</script>');
    expect(container.textContent).toContain('unsafe');
    expect(container.textContent).toContain('Diagram');
    expect(Array.from(container.querySelectorAll('a'), (link) => link.getAttribute('href'))).toEqual([
      '#result', 'mailto:hello@example.com',
    ]);
  });

  it('reserves image dimensions before bytes arrive and retains the frame after a transfer failure', async () => {
    const binding = { locator: './slow.png', resourceId: 'slow-image', status: 'available' as const };
    let reject!: (error: Error) => void;
    const transfer = new Promise<void>((_, fail) => { reject = fail; });
    const container = await render(<MarkdownContent markdown="![Slow diagram](./slow.png)" resourceContext={{
      scopeKey: 'slow-image-session', bindings: [],
      resources: { 'slow-image': { status: 'available', mediaType: 'image/png', byteLength: 1024, sha256: 'slow', imageDimensions: { width: 800, height: 600 } } },
      resolveResource: async () => binding, requestResource: () => transfer,
    }} />);
    const frame = container.querySelector<HTMLElement>('[data-image-state="loading"]');
    expect(frame).not.toBeNull();
    expect(frame!.style.aspectRatio).toBe('800 / 600');
    expect(container.querySelector('img')).toBeNull();
    await act(async () => reject(new Error('The Remote Host disconnected.')));
    expect(container.querySelector('[data-image-state="failed"]')).toBe(frame);
    expect(frame!.style.aspectRatio).toBe('800 / 600');
    expect(frame!.getAttribute('aria-busy')).toBe('false');
    expect(frame!.textContent).toContain('Image unavailable');
  });

  it('keeps decoded images and their dimensions through success and decoding failure', async () => {
    const binding = { locator: './decode.png', resourceId: 'decode-image', status: 'available' as const };
    const container = await render(<MarkdownContent markdown="![Decoded](./decode.png)" resourceContext={{
      scopeKey: 'decode-image-session', bindings: [binding],
      resources: { 'decode-image': { status: 'available', mediaType: 'image/png', byteLength: 1, sha256: 'decode', contentBase64: 'AA==', imageDimensions: { width: 640, height: 480 } } },
      resolveResource: async () => binding, requestResource: async () => {},
    }} />);
    const frame = container.querySelector<HTMLElement>('[data-image-state="loading"]');
    const image = container.querySelector('img')!;
    expect(image.getAttribute('width')).toBe('640');
    expect(image.getAttribute('height')).toBe('480');
    await act(async () => image.dispatchEvent(new Event('load')));
    expect(container.querySelector('[data-image-state="loaded"]')).toBe(frame);
    await act(async () => image.dispatchEvent(new Event('error')));
    expect(container.querySelector('[data-image-state="failed"]')).toBe(frame);
    expect(frame!.style.aspectRatio).toBe('640 / 480');
  });

  it('loads inline and reference local images through the resource path with document context', async () => {
    const png = 'iVBORw0KGgoAAA==';
    const binding = { locator: './images/result.png', resourceId: 'image-one', status: 'available' as const };
    const resolveResource = vi.fn(async () => binding);
    const resources = { 'image-one': { status: 'available' as const, mediaType: 'image/png', byteLength: 10, sha256: 'digest' } } as Record<string, any>;
    const requestResource = vi.fn(async () => {
      resources['image-one'] = { ...resources['image-one'], contentBase64: png };
    });
    const container = await render(<MarkdownContent
      markdown={'![Inline](./images/result.png)\n\n![Reference][result]\n\n[result]: ./images/result.png'}
      sourceLocator="/workspace/docs/report.md"
      resourceContext={{
        scopeKey: 'session-one', bindings: [], resolveResource, requestResource,
        resources,
      }}
    />);

    await expect.poll(() => container.querySelectorAll('img').length).toBe(2);
    expect(resolveResource).toHaveBeenCalledTimes(1);
    expect(resolveResource).toHaveBeenCalledWith('./images/result.png', '/workspace/docs/report.md');
    expect(requestResource).toHaveBeenCalledTimes(1);
    expect(container.querySelector('img')?.getAttribute('src')).toBe(`data:image/png;base64,${png}`);
  });

  it('shows the protocol reason when a local image resource is unavailable', async () => {
    const binding = { locator: './images/missing.png', resourceId: 'image-missing', status: 'unavailable' as const };
    const requestResource = vi.fn(async () => undefined);
    const container = await render(<MarkdownContent
      markdown="![Missing diagram](./images/missing.png)"
      resourceContext={{
        scopeKey: 'session-unavailable', bindings: [binding],
        resources: { 'image-missing': { status: 'unavailable', reason: 'Provider stopped.' } },
        resolveResource: vi.fn(async () => binding), requestResource,
      }}
    />);

    await expect.poll(() => container.querySelector('[role="img"]')?.getAttribute('aria-label')).toBe('Missing diagram: Provider stopped.');
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(requestResource).not.toHaveBeenCalled();
  });

  it('resolves a relative image against its source document instead of reusing an unscoped binding', async () => {
    const existing = { locator: './image.png', resourceId: 'other-document-image', status: 'available' as const };
    const resolved = { locator: './image.png', resourceId: 'current-document-image', status: 'unavailable' as const };
    const resolveResource = vi.fn(async () => resolved);
    const container = await render(<MarkdownContent markdown="![Scoped](./image.png)" sourceLocator="/workspace/current/report.md"
      resourceContext={{
        scopeKey: 'source-scoping', bindings: [existing], resources: {
          'current-document-image': { status: 'unavailable', reason: 'Current document image is unavailable.' },
        }, resolveResource, requestResource: vi.fn(),
      }} />);

    await expect.poll(() => container.querySelector('[role="img"]')?.getAttribute('aria-label')).toContain('Current document image is unavailable.');
    expect(resolveResource).toHaveBeenCalledWith('./image.png', '/workspace/current/report.md');
  });

  it('does not resolve image syntax in code fences', async () => {
    const resolveResource = vi.fn();
    const container = await render(<MarkdownContent
      markdown={'```md\n![Hidden](./secret.png)\n```'}
      resourceContext={{ scopeKey: 'session-one', bindings: [], resources: {}, resolveResource, requestResource: vi.fn() }}
    />);

    expect(container.querySelector('pre code')?.textContent).toContain('![Hidden](./secret.png)');
    expect(resolveResource).not.toHaveBeenCalled();
  });

  it('requests image bytes again after the session replica loses its resource payload', async () => {
    const binding = { locator: './reset.png', resourceId: 'reset-image', status: 'available' as const };
    const resolveResource = vi.fn(async () => binding);
    const first: Record<string, any> = {};
    const requestResource = vi.fn(async () => { first['reset-image'] = { status: 'available', mediaType: 'image/png', byteLength: 1, sha256: 'one', contentBase64: 'AA==' }; });
    const container = await render(<MarkdownContent markdown="![Reset](./reset.png)" resourceContext={{
      scopeKey: 'replica-reset-session', bindings: [binding], resources: first, resolveResource, requestResource,
    }} />);
    await expect.poll(() => requestResource.mock.calls.length).toBe(1);

    await rerender(container, <MarkdownContent markdown="![Reset](./reset.png)" resourceContext={{
      scopeKey: 'replica-reset-session', bindings: [binding],
      resources: { 'reset-image': { status: 'unavailable', reason: 'Provider stopped.' } }, resolveResource, requestResource,
    }} />);
    await expect.poll(() => container.querySelector('[role="img"]')?.getAttribute('aria-label')).toContain('Provider stopped.');
    expect(requestResource).toHaveBeenCalledTimes(1);

    await rerender(container, <MarkdownContent markdown="![Reset](./reset.png)" resourceContext={{
      scopeKey: 'replica-reset-session', bindings: [binding], resources: {}, resolveResource, requestResource,
    }} />);
    await expect.poll(() => requestResource.mock.calls.length).toBe(2);
  });
  it('keeps a decoded image mounted when unrelated replica resources and callbacks change', async () => {
    const binding = { locator: './stable.png', resourceId: 'stable-image', status: 'available' as const };
    const detail = { status: 'available' as const, mediaType: 'image/png', byteLength: 1, sha256: 'one', contentBase64: 'AA==' };
    const resolveResource = vi.fn(async () => binding);
    const requestResource = vi.fn(async () => undefined);
    const context = { scopeKey: 'stable-image-session', bindings: [binding], resources: { 'stable-image': detail }, resolveResource, requestResource };
    const container = await render(<MarkdownContent markdown="![Stable](./stable.png)" resourceContext={context} />);
    const image = container.querySelector('img');
    expect(image).not.toBeNull();
    const removed: Node[] = [];
    const observer = new MutationObserver(records => records.forEach(record => removed.push(...Array.from(record.removedNodes))));
    observer.observe(container, { childList: true, subtree: true });
    try {
      for (let index = 0; index < 3; index++) {
        await rerender(container, <MarkdownContent markdown={`![Stable](./stable.png)\n\nStreaming ${index}`} resourceContext={{
          ...context, bindings: [...context.bindings], resources: { ...context.resources, other: detail },
          resolveResource: async () => resolveResource(), requestResource: async () => requestResource(),
        }} />);
        expect(container.querySelector('img')).toBe(image);
      }
      expect(removed).not.toContain(image);
      expect(requestResource).not.toHaveBeenCalled();
    } finally { observer.disconnect(); }
  });

  it('hides the previous image while a different session resolves the same locator', async () => {
    const binding = { locator: './scoped.png', resourceId: 'shared-id', status: 'available' as const };
    const resources = { 'shared-id': { status: 'available' as const, mediaType: 'image/png', byteLength: 1, sha256: 'one', contentBase64: 'AA==' } };
    const requestResource = vi.fn(async () => undefined);
    const container = await render(<MarkdownContent markdown="![Scoped](./scoped.png)" resourceContext={{
      scopeKey: 'image-source-one', bindings: [binding], resources, resolveResource: vi.fn(async () => binding), requestResource,
    }} />);
    expect(container.querySelector('img')).not.toBeNull();
    let resolve!: (value: typeof binding) => void;
    const resolution = new Promise<typeof binding>(accept => { resolve = accept; });
    await rerender(container, <MarkdownContent markdown="![Scoped](./scoped.png)" resourceContext={{
      scopeKey: 'image-source-two', bindings: [], resources, resolveResource: vi.fn(() => resolution), requestResource,
    }} />);
    expect(container.querySelector('img')).toBeNull();
    await act(async () => resolve(binding));
    expect(container.querySelector('img')).not.toBeNull();
  });

});

it('opens local file links through resource RPC without navigating the site', async () => {
  const opened: string[] = [];
  const resourceContext = { scopeKey: 'file-links', bindings: [], resources: {}, resolveResource: vi.fn(), requestResource: vi.fn() };
  const container = await render(<FilePreviewContext.Provider value={{ open: request => { opened.push(request.locator); } }}>
    <MarkdownContent markdown={'[Absolute](/workspace/report.md) [Relative](./src/main.ts) [File](file:///workspace/report.md) [Web](https://example.com) [Anchor](#details)'} resourceContext={resourceContext} />
  </FilePreviewContext.Provider>);
  const local = Array.from(container.querySelectorAll<HTMLButtonElement>('button'));
  expect(local.map(button => button.textContent)).toEqual(['Absolute', 'Relative', 'File']);
  for (const button of local) await act(async () => button.click());
  expect(opened).toEqual(['/workspace/report.md', './src/main.ts', 'file:///workspace/report.md']);
  expect(container.querySelector('a[href="https://example.com"]')).not.toBeNull();
  expect(container.querySelector('a[href="#details"]')).not.toBeNull();
  expect(resourceContext.resolveResource).not.toHaveBeenCalled();
});
