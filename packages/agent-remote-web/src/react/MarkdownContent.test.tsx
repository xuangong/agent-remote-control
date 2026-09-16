import { describe, expect, it, vi } from 'vitest';

import { render, rerender } from '../test/setup.js';
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
      '/docs/guide', '#result', 'mailto:hello@example.com',
    ]);
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
      scopeKey: 'replica-reset-session', bindings: [binding], resources: {}, resolveResource, requestResource,
    }} />);
    await expect.poll(() => requestResource.mock.calls.length).toBe(2);
  });
});
