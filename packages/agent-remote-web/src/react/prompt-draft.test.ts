import 'fake-indexeddb/auto';
import { Blob as NativeBlob } from 'node:buffer';
import { afterEach, expect, it, vi } from 'vitest';
import { readImageDraft } from '../image-drafts.js';
import { preparePromptDraft, savePromptDraft } from './prompt-draft.js';
import type { MarkdownResourceContext } from './local-resource.js';

afterEach(() => vi.unstubAllGlobals());
function context(): MarkdownResourceContext {
  return { scopeKey: crypto.randomUUID(), bindings: [{ locator: '/test.png', resourceId: 'image', status: 'available' }],
    resources: { image: { status: 'available', mediaType: 'image/png', contentBase64: btoa('test bytes'), byteLength: 10, sha256: 'hash' } },
    resolveResource: async () => { throw new Error('Unexpected resolution'); }, requestResource: async () => { throw new Error('Unexpected request'); } };
}
it('restores text and ordered image tags into the target draft without uploading or sending', async () => {
  vi.stubGlobal('Blob', NativeBlob);
  const draft = await preparePromptDraft({ type: 'user_message', text: 'before after', content: [
    { type: 'text', text: 'before ' }, { type: 'image', locator: '/test.png', label: 'image #4', mediaType: 'image/png', sha256: 'hash' }, { type: 'text', text: ' after' },
  ] }, context());
  expect(draft.parts.map(part => part.type)).toEqual(['text', 'image', 'text']);
  expect(draft.nextLabel).toBe(5);
  const scope = 'prompt-draft'; const target = 'new-session';
  expect(await savePromptDraft(scope, target, draft)).toBe('before  after');
  const saved = await readImageDraft(JSON.stringify([scope, target]));
  expect(saved?.parts).toEqual(draft.parts);
  expect(Object.values(saved!.images)[0]).toMatchObject({ status: 'pending', progress: 0 });
  expect(await readImageDraft(JSON.stringify([scope, 'original-session']))).toBeUndefined();
});
it('refuses to silently drop an unavailable image before a fork is requested', async () => {
  const resources = context(); resources.resources.image = { status: 'unavailable', reason: 'Removed' };
  await expect(preparePromptDraft({ type: 'user_message', text: '', content: [
    { type: 'image', locator: '/test.png', label: 'image #1', mediaType: 'image/png', sha256: 'hash' },
  ] }, resources)).rejects.toThrow(/unavailable/);
});
