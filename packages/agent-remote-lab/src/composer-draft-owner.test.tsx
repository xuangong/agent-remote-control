import 'fake-indexeddb/auto';
import { Blob as NativeBlob } from 'node:buffer';
import { act } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { inspectImageDraft, type ImageDraft } from '@orchardworks/agent-remote-web/browser';
import { useImageDraft } from '../../agent-remote-web/dist/react/useImageDraft.js';
import { DraftStore, useBoundDraft } from './draft-store.js';
import { ComposerDraftOwner } from './composer-draft-owner.js';
import { readDrafts } from './conversation-recovery.js';
import { render } from './test/setup.js';
import { persistedPrompt } from './test/image-draft-storage.js';

afterEach(() => vi.restoreAllMocks());

async function setupOwner() {
  const scope = `composer-owner-${crypto.randomUUID()}`;
  const text = { store: new DraftStore(scope), key: 'composer' };
  const binding = { scope, key: `${scope}:images` };
  let current = true;
  const recipient = { identity: scope, lifetime: {}, isCurrent: () => current };
  function Harness() {
    const bound = useBoundDraft(text);
    useImageDraft({ binding, recipient, sessionKey: 'session', text: bound.text ?? '', onTextChange: bound.set, enabled: true, active: false });
    return null;
  }
  await render(<Harness />);
  const image = await inspectImageDraft(binding);
  await act(async () => { await image.flush(image.snapshot().revision, () => true); });
  const owner = new ComposerDraftOwner(text, image);
  return { owner, image, text, scope, binding, isCurrent: () => current, retire: () => { current = false; } };
}
const replacement = (): Omit<ImageDraft, 'key' | 'scope'> => ({ version: 1,
  parts: [{ type: 'text', text: 'Selected prompt' }], images: {}, nextLabel: 1 });

it.each(['text', 'image'] as const)('reports a partial %s save failure and retries the exact application', async boundary => {
  const f = await setupOwner();
  let fail = true;
  const write = Storage.prototype.setItem, put = IDBObjectStore.prototype.put;
  if (boundary === 'text') vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function(this: Storage, key, value) {
    if (fail && key.endsWith(':drafts')) throw new Error('Full');
    return write.call(this, key, value);
  });
  else vi.spyOn(IDBObjectStore.prototype, 'put').mockImplementation(function(this: IDBObjectStore, value, key) {
    if (fail && value.key === f.binding.key) throw new DOMException('Full', 'AbortError');
    return put.call(this, value, key);
  });
  let receipt!: Awaited<ReturnType<typeof f.owner.restore>>;
  await act(async () => { receipt = await f.owner.restore(f.owner.capture().token, replacement(), f.isCurrent); });
  expect(receipt.persistence).toMatchObject({ text: boundary === 'text' ? 'failed' : 'saved', image: boundary === 'image' ? 'failed' : 'saved' });
  expect(receipt.application.status).toBe('applied');
  if (receipt.application.status !== 'applied') throw new Error('Expected a local application');
  const token = receipt.application.token;
  expect(f.owner.matches(token)).toBe(true);
  const imageRevision = f.image.snapshot().revision, textRevision = f.text.store.snapshot(f.text.key).revision;
  fail = false;
  await act(async () => { receipt = await f.owner.retain(token, f.isCurrent); });
  expect(receipt.persistence).toMatchObject({ text: 'saved', image: 'saved', imageRetention: 'local' });
  expect(f.image.snapshot().revision).toBe(imageRevision);
  expect(f.text.store.snapshot(f.text.key).revision).toBe(textRevision);
  expect(readDrafts(f.scope).composer).toBe('Selected prompt');
  expect((await persistedPrompt(f.binding.key)).draft?.parts).toEqual([{ type: 'text', text: 'Selected prompt' }]);
});

it.each(['newer text', 'retired recipient'] as const)('keeps the actual application token when %s arrives during image retention', async boundary => {
  const f = await setupOwner(), selected = replacement();
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const blob = new NativeBlob(['image'], { type: 'image/png' }) as unknown as Blob;
  const read = blob.arrayBuffer.bind(blob);
  Object.defineProperty(blob, 'arrayBuffer', { value: async () => { await gate; return read(); } });
  selected.parts.push({ type: 'image', imageId: 'selected-image', label: 'image #1' });
  selected.images['selected-image'] = { imageId: 'selected-image', uploadId: 'selected-upload', blob, status: 'pending', progress: 0 };
  let pending!: ReturnType<typeof f.owner.restore>;
  await act(async () => { pending = f.owner.restore(f.owner.capture().token, selected, f.isCurrent); });
  expect(f.text.store.get(f.text.key)).toBe('Selected prompt');
  const applied = f.owner.capture();
  await act(async () => {
    if (boundary === 'newer text') { f.text.store.set(f.text.key, 'newer'); f.text.store.set(f.text.key, 'Selected prompt'); }
    else f.retire();
    release();
  });
  const receipt = await pending;
  expect(receipt.application.status).toBe('applied');
  expect(receipt.persistence.image).toBe('cancelled');
  if (receipt.application.status !== 'applied') throw new Error('Expected the actual application receipt');
  if (boundary === 'newer text') {
    expect(f.owner.matches(applied.token)).toBe(false);
    expect(f.owner.matches(receipt.application.token)).toBe(false);
  }
  expect((await f.owner.retain(receipt.application.token, f.isCurrent)).application).toEqual({ status: 'not-applied', reason: boundary === 'newer text' ? 'changed' : 'retired' });
});

it('rejects another text owner even when its content and local revision match', async () => {
  const f = await setupOwner(), expected = f.owner.capture();
  const replacementOwner = new ComposerDraftOwner({ key: f.text.key, store: new DraftStore(f.scope) }, f.image);
  const receipt = await replacementOwner.restore(expected.token, replacement(), () => true);
  expect(receipt.application).toEqual({ status: 'not-applied', reason: 'changed' });
  expect(f.text.store.get(f.text.key)).toBe('');
  expect(f.image.snapshot().draft?.parts).toEqual([]);
});

it('does not certify replacement from an old saved snapshot when the writer declines application', async () => {
  const f = await setupOwner();
  const originalParts = [{ type: 'image' as const, imageId: 'original', label: 'image #1' }];
  await act(async () => { await f.image.replace!(f.image.snapshot().revision, { version: 1, parts: originalParts,
    images: { original: { imageId: 'original', uploadId: 'original-upload', status: 'pending', progress: 0,
      blob: new NativeBlob(['original'], { type: 'image/png' }) as unknown as Blob } }, nextLabel: 2 }, f.isCurrent); });
  let decline = true;
  const image = { ...f.image, apply: (...args: Parameters<NonNullable<typeof f.image.apply>>) => decline
    ? { application: { status: 'not-applied' as const, reason: 'unavailable' as const }, completion: Promise.resolve(f.image.snapshot()) }
    : f.image.apply!(...args) };
  const owner = new ComposerDraftOwner(f.text, image);
  let receipt!: Awaited<ReturnType<typeof owner.restore>>;
  await act(async () => { receipt = await owner.restore(owner.capture().token, replacement(), f.isCurrent); });
  expect(f.text.store.get(f.text.key)).toBe('Selected prompt');
  expect(f.image.snapshot().draft?.parts).toEqual(originalParts);
  expect(receipt.persistence).toMatchObject({ text: 'saved', image: 'cancelled' });
  if (receipt.application.status !== 'applied') throw new Error('Expected the actual partial text application');
  const token = receipt.application.token;
  decline = false;
  await act(async () => { receipt = await owner.restore(token, replacement(), f.isCurrent); });
  expect(receipt.persistence).toMatchObject({ text: 'saved', image: 'saved' });
  expect(f.image.snapshot().draft?.parts).toEqual([{ type: 'text', text: 'Selected prompt' }]);
});
