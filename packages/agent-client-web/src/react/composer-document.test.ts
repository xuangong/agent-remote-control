import { expect, it } from 'vitest';
import { normalizeDraftParts, draftText, draftHasContent, snapshotContent } from './composer-document.js';

it('merges adjacent text without interpreting typed image labels', () => {
  expect(normalizeDraftParts([{ type: 'text', text: '[image #1]' }, { type: 'text', text: '\nnext' }])).toEqual([{ type: 'text', text: '[image #1]\nnext' }]);
});
it('preserves image order and stable labels, including image-only content', () => {
  const parts = [{ type: 'image' as const, imageId: 'b', label: 'image #2' }];
  expect(draftHasContent(parts)).toBe(true);
  expect(draftText(parts)).toBe('');
  expect(snapshotContent(parts, { b: { attachmentId: 'attachment-b' } })).toEqual([{ type: 'image', attachmentId: 'attachment-b', label: 'image #2' }]);
});
it('refuses a snapshot when any image is unavailable', () => {
  expect(() => snapshotContent([{ type: 'image', imageId: 'missing', label: 'image #1' }], {})).toThrow('not ready');
});
