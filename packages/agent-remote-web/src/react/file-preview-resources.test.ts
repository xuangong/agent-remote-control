import { expect, it } from 'vitest';
import { createFilePreviewResourceContext } from './file-preview-resources.js';
import type { MarkdownResourceContext } from './local-resource.js';

function resolver() {
  const reads: [string, string | undefined][] = [];
  const context: MarkdownResourceContext = {
    scopeKey: 'session', bindings: [], resources: {},
    resolveResource: async (locator, source) => {
      reads.push([locator, source]);
      return { locator, resourceId: 'resource', status: 'available' };
    },
    requestResource: async () => undefined,
  };
  return { context, reads };
}

it('preserves nested relative document origins without resolving against the browser location', async () => {
  const { context, reads } = resolver();
  const document = createFilePreviewResourceContext(context, './docs/report.md', undefined, 'report');
  await document.resolveResource('./chapters/next.md', './docs/report.md');
  const nested = createFilePreviewResourceContext(document, './chapters/next.md', './docs/report.md', 'chapter');
  await nested.resolveResource('../images/a%20b.png', './chapters/next.md');
  expect(reads).toEqual([
    ['./docs/./chapters/next.md', undefined],
    ['./docs/./chapters/../images/a%20b.png', undefined],
  ]);
});

it.each(['/workspace/docs/report.md', 'file:///workspace/docs/report.md'])('retains the absolute source %s across nested previews', async source => {
  const { context, reads } = resolver();
  const document = createFilePreviewResourceContext(context, source, undefined, 'report');
  const nested = createFilePreviewResourceContext(document, '../notes/chapter.md', source, 'chapter');
  await nested.resolveResource('./images/%E4%B8%AD%E6%96%87.png', '../notes/chapter.md');
  expect(reads).toEqual([['../notes/./images/%E4%B8%AD%E6%96%87.png', source]]);
});

it('decodes ordinary absolute document sources without decoding URI path separators or file URLs', async () => {
  const { context, reads } = resolver();
  const source = '/workspace/docs%20name/literal%2Fname/report.md';
  const document = createFilePreviewResourceContext(context, source, undefined, 'report');
  await document.resolveResource('./image%20one.png', source);
  const fileSource = `file://${source}`;
  const fileDocument = createFilePreviewResourceContext(context, fileSource, undefined, 'file-report');
  await fileDocument.resolveResource('./image%20one.png', fileSource);
  await document.resolveResource('./image.png', '/workspace/other%20document/report.md');
  expect(reads).toEqual([
    ['./image%20one.png', '/workspace/docs name/literal%2Fname/report.md'],
    ['./image%20one.png', fileSource],
    ['./image.png', '/workspace/other%20document/report.md'],
  ]);
});

it('delegates absolute resources and unrelated source contexts without rebasing them', async () => {
  const { context, reads } = resolver();
  const document = createFilePreviewResourceContext(context, './docs/report.md', '/workspace/entry.md', 'report');
  await document.resolveResource('/workspace/image.png', './docs/report.md');
  await document.resolveResource('file:///workspace/image.png', './docs/report.md');
  await document.resolveResource('native-image:one', './docs/report.md');
  await document.resolveResource('./image.png', '/workspace/other.md');
  expect(reads).toEqual([
    ['/workspace/image.png', './docs/report.md'],
    ['file:///workspace/image.png', './docs/report.md'],
    ['native-image:one', './docs/report.md'],
    ['./image.png', '/workspace/other.md'],
  ]);
});
