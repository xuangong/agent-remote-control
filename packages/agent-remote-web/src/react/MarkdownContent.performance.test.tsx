import { expect, it, vi } from 'vitest';
import { render, rerender } from '../test/setup.js';
import { MarkdownContent } from './MarkdownContent.js';
import { act } from 'react';
import { FilePreviewContext } from './FilePreviewContext.js';
const { parses } = vi.hoisted(() => ({ parses: vi.fn() }));
vi.mock('remark-breaks', async original => {
  const actual = await original<typeof import('remark-breaks')>();
  return { default: function () { parses(); return actual.default(); } };
});
it('reuses parsed Markdown across parent and resource-context updates while keeping links current', async () => {
  const resolveResource = vi.fn(); const requestResource = vi.fn();
  const open = vi.fn();
  const context = { scopeKey: 'one', resources: {}, bindings: [], resolveResource, requestResource };
  const markdown = '**History** [File](./report.md)';
  const view = (resourceContext: typeof context) => <FilePreviewContext.Provider value={{ open }}>
    <MarkdownContent markdown={markdown} resourceContext={resourceContext} />
  </FilePreviewContext.Provider>;
  const container = await render(view(context));
  parses.mockClear();
  const nextContext = { ...context, requestResource: vi.fn() };
  await rerender(container, view(nextContext));
  expect(container.querySelector('strong')?.textContent).toBe('History');
  expect(parses).not.toHaveBeenCalled();
  await act(async () => container.querySelector<HTMLButtonElement>('button')!.click());
  expect(open).toHaveBeenCalledWith(expect.objectContaining({ locator: './report.md', context: nextContext }));
  await rerender(container, <FilePreviewContext.Provider value={{ open }}>
    <MarkdownContent markdown="**New reply**" resourceContext={context} />
  </FilePreviewContext.Provider>);
  expect(parses).toHaveBeenCalledTimes(1);
  expect(container.querySelector('strong')?.textContent).toBe('New reply');
});
