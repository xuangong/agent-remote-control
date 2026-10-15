import 'fake-indexeddb/auto';
import { Blob as NativeBlob } from 'node:buffer';
import { afterEach, expect, it, vi } from 'vitest';
import { readPromptEditReservation, retainPromptEditReservation } from './prompt-edit-intent.js';
import { retainPrefixEdit, readPrefixEdit, finishPrefixEdit } from './prompt-edit-succession.js';
import { readImageDraft, writeImageDraft } from '@orchardworks/agent-remote-web/browser';
import { conversationSessionStorage } from './conversation-storage.js';

import { persistedPrompt } from './test/image-draft-storage.js';

const intent = {
  version: 1 as const, source: { hostId: 'host', agentId: 'agent-A', providerId: 'opencode', nativeSessionId: 'A', title: 'A' },
  operation: { operationId: 'prefix-operation', providerId: 'opencode', nativeSessionId: 'A', expectedRevision: 1,
    targetProviderId: 'opencode', preparation: { kind: 'native_prefix' as const, turnId: 'turn-2', messageId: 'prompt-2' } },
  owner: { textKey: 'draft', image: { scope: 'prefix-storage', key: 'image-owner' } },
  baseline: { text: '', textRevision: 0, imageRevision: 0, imageParts: '[]' },
};
const draft = { version: 1 as const, parts: [{ type: 'text' as const, text: 'Selected prompt' }], images: {}, nextLabel: 1 };
afterEach(() => vi.restoreAllMocks());
it('retains separate exact per-view native prefix intents and selected draft before reporting success', async () => {
  const scope = `prefix-storage-${crypto.randomUUID()}`;
  retainPromptEditReservation(scope, { key: 'legacy', operationId: '11111111-1111-4111-8111-111111111111' });
  await retainPrefixEdit(scope, 'window-one', intent, draft);
  await retainPrefixEdit(scope, 'window-two', { ...intent, operation: { ...intent.operation, operationId: 'other-operation' } }, draft);
  expect(readPrefixEdit(scope, 'window-one')?.operation).toEqual(intent.operation);
  const saved = readPrefixEdit(scope, 'window-one')!;
  expect((await readImageDraft(saved.prompt.key))?.parts).toEqual(draft.parts);
  expect(readPrefixEdit(scope, 'window-two')?.operation.operationId).toBe('other-operation');
  await finishPrefixEdit(scope, 'window-one', 'other-operation');
  expect(readPrefixEdit(scope, 'window-one')).toBeDefined();
  await finishPrefixEdit(scope, 'window-one', 'prefix-operation');
  expect(readPrefixEdit(scope, 'window-one')).toBeUndefined();
  expect(readPromptEditReservation(scope)?.key).toBe('legacy');
}, 5000);

it('releases completed snapshot metadata and image bytes while preserving another operation and restored draft', async () => {
  const scope = `prefix-release-${crypto.randomUUID()}`, imageId = 'selected-image';
  const imageDraft = { ...draft, parts: [...draft.parts, { type: 'image' as const, imageId, label: 'image #1' }],
    images: { [imageId]: { imageId, uploadId: 'upload', status: 'pending' as const, progress: 0, blob: new NativeBlob(['selected bytes'], { type: 'image/png' }) as Blob } } };
  const first = await retainPrefixEdit(scope, 'view', intent, imageDraft);
  const second = await retainPrefixEdit(scope, 'another-view', { ...intent, operation: { ...intent.operation, operationId: 'another-operation' } }, imageDraft);
  await writeImageDraft({ ...imageDraft, scope, key: 'restored-composer' });
  await finishPrefixEdit(scope, 'view', intent.operation.operationId);
  expect(await persistedPrompt(first.prompt.key)).toEqual({ draft: undefined, images: [] });
  expect(readPrefixEdit(scope, 'view')).toBeUndefined();
  expect((await persistedPrompt(second.prompt.key)).images).toHaveLength(1);
  expect((await persistedPrompt('restored-composer')).images).toHaveLength(1);
}, 5000);

it('compensates an unpublished snapshot after identity storage fails', async () => {
  const scope = `prefix-publish-failure-${crypto.randomUUID()}`;
  const write = Storage.prototype.setItem;
  let promptKey = '';
  const fail = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    if (key.includes(scope) && key.includes('prefix-edit')) { promptKey = JSON.parse(value).prompt.key; throw new Error('Intent publication denied'); }
    return write.call(this, key, value);
  });
  try { await expect(retainPrefixEdit(scope, 'view', intent, draft)).rejects.toThrow(/publication denied/); }
  finally { fail.mockRestore(); }
  expect(promptKey).not.toBe('');
  expect(await persistedPrompt(promptKey)).toEqual({ draft: undefined, images: [] });
  expect(readPrefixEdit(scope, 'view')).toBeUndefined();
}, 5000);

it('retains cleanup identity after deletion fails and retries without removing another intent', async () => {
  const scope = `prefix-delete-failure-${crypto.randomUUID()}`;
  const retained = await retainPrefixEdit(scope, 'view', intent, draft);
  const remove = IDBObjectStore.prototype.delete;
  const fail = vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (this: IDBObjectStore, key) {
    if (key === retained.prompt.key) throw new Error('Cleanup unavailable');
    return remove.call(this, key);
  });
  try { await expect(finishPrefixEdit(scope, 'view', intent.operation.operationId)).rejects.toThrow(/Cleanup unavailable/); }
  finally { fail.mockRestore(); }
  expect(readPrefixEdit(scope, 'view')).toEqual(retained);
  expect((await persistedPrompt(retained.prompt.key)).draft).toBeDefined();
  await finishPrefixEdit(scope, 'view', intent.operation.operationId);
  expect(readPrefixEdit(scope, 'view')).toBeUndefined();
}, 5000);

it('does not overwrite an already-retained same-operation prompt or revive it during close', async () => {
  const scope = `prefix-same-operation-${crypto.randomUUID()}`;
  const first = await retainPrefixEdit(scope, 'view', intent, draft);
  await retainPrefixEdit(scope, 'view', intent, { ...draft, parts: [{ type: 'text', text: 'later retry' }] });
  expect((await persistedPrompt(first.prompt.key)).draft?.parts).toEqual(draft.parts);
  const closing = finishPrefixEdit(scope, 'view', intent.operation.operationId);
  await expect(retainPrefixEdit(scope, 'view', intent, draft)).rejects.toThrow(/closing/);
  await closing;
  expect(await persistedPrompt(first.prompt.key)).toEqual({ draft: undefined, images: [] });
}, 5000);

it('never releases a composer key substituted into an operation intent', async () => {
  const scope = `prefix-forged-owner-${crypto.randomUUID()}`;
  await writeImageDraft({ ...draft, scope, key: 'user-composer' });
  conversationSessionStorage.setItem(`agent-remote:recovery:${scope}:prefix-edit:view`, JSON.stringify({ ...intent, prompt: { scope, key: 'user-composer' } }));
  await expect(finishPrefixEdit(scope, 'view', intent.operation.operationId)).rejects.toThrow(/snapshot|prompt/);
  expect((await persistedPrompt('user-composer')).draft?.parts).toEqual(draft.parts);
}, 5000);

it('compensates a snapshot if the original owner retires while its image is being retained', async () => {
  const scope = `prefix-retired-owner-${crypto.randomUUID()}`;
  const blob = new NativeBlob(['selected bytes'], { type: 'image/png' }) as Blob;
  let release!: (bytes: ArrayBuffer) => void, current = true;
  vi.spyOn(blob, 'arrayBuffer').mockImplementation(() => new Promise(resolve => { release = resolve; }));
  const pending = retainPrefixEdit(scope, 'view', intent, { ...draft, parts: [{ type: 'image', imageId: 'image', label: 'image #1' }],
    images: { image: { imageId: 'image', uploadId: 'upload', status: 'pending', progress: 0, blob } } }, () => current);
  const rejected = expect(pending).rejects.toThrow(/retained for recovery/);
  await vi.waitFor(() => expect(release).toBeDefined());
  current = false; release(new ArrayBuffer(14)); await rejected;
  expect(await persistedPrompt(JSON.stringify([scope, 'prefix-edit-prompt', 'view', intent.operation.operationId]))).toEqual({ draft: undefined, images: [] });
}, 5000);

it('keeps a cancellation identity when both initial publication and compensation fail transiently', async () => {
  const scope = `prefix-double-failure-${crypto.randomUUID()}`;
  const write = Storage.prototype.setItem, remove = IDBObjectStore.prototype.delete;
  let publications = 0;
  const deny = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key, value) {
    if (key.includes(scope) && publications++ === 0) throw new Error('Publication interrupted');
    return write.call(this, key, value);
  });
  const fail = vi.spyOn(IDBObjectStore.prototype, 'delete').mockImplementation(function (this: IDBObjectStore, key) {
    if (String(key).includes(scope)) throw new Error('Cleanup interrupted');
    return remove.call(this, key);
  });
  try { await expect(retainPrefixEdit(scope, 'view', intent, draft)).rejects.toThrow(/cleanup failed/); }
  finally { deny.mockRestore(); fail.mockRestore(); }
  const saved = readPrefixEdit(scope, 'view')!;
  expect(saved.cancelRequested).toBe(true);
  expect((await persistedPrompt(saved.prompt.key)).draft?.parts).toEqual(draft.parts);
  await finishPrefixEdit(scope, 'view', intent.operation.operationId);
  expect(await persistedPrompt(saved.prompt.key)).toEqual({ draft: undefined, images: [] });
}, 5000);

it('separates same-operation snapshots in two initiating views', async () => {
  const scope = `prefix-two-views-${crypto.randomUUID()}`;
  const first = await retainPrefixEdit(scope, 'first', intent, draft);
  const second = await retainPrefixEdit(scope, 'second', intent, { ...draft, parts: [{ type: 'text', text: 'other view prompt' }] });
  await finishPrefixEdit(scope, 'first', intent.operation.operationId);
  expect(await persistedPrompt(first.prompt.key)).toEqual({ draft: undefined, images: [] });
  expect((await persistedPrompt(second.prompt.key)).draft?.parts).toEqual([{ type: 'text', text: 'other view prompt' }]);
}, 5000);

it('preserves a snapshot with an explicit uncertainty error when publication readback becomes unavailable', async () => {
  const scope = `prefix-unreadable-${crypto.randomUUID()}`;
  const read = conversationSessionStorage.getItem.bind(conversationSessionStorage);
  let published = false;
  const write = conversationSessionStorage.setItem.bind(conversationSessionStorage);
  const publish = vi.spyOn(conversationSessionStorage, 'setItem').mockImplementation((key, value) => { write(key, value); published = true; });
  const unavailable = vi.spyOn(conversationSessionStorage, 'getItem').mockImplementation(key => {
    if (published && key.includes(scope)) throw new Error('Storage read unavailable');
    return read(key);
  });
  try { await expect(retainPrefixEdit(scope, 'view', intent, draft)).rejects.toThrow(/identity could not be verified.*snapshot.*preserved/i); }
  finally { publish.mockRestore(); unavailable.mockRestore(); }
  const saved = readPrefixEdit(scope, 'view')!;
  expect((await persistedPrompt(saved.prompt.key)).draft?.parts).toEqual(draft.parts);
  await finishPrefixEdit(scope, 'view', intent.operation.operationId);
  expect(await persistedPrompt(saved.prompt.key)).toEqual({ draft: undefined, images: [] });
}, 5000);

it('releases a known unpublished operation after its compensation can be retried', async () => {
  const scope = `prefix-unpublished-cleanup-${crypto.randomUUID()}`;
  const key = JSON.stringify([scope, 'prefix-edit-prompt', 'view', intent.operation.operationId]);
  await writeImageDraft({ ...draft, scope, key });
  await finishPrefixEdit(scope, 'view', intent.operation.operationId);
  expect(await persistedPrompt(key)).toEqual({ draft: undefined, images: [] });
}, 5000);

it('refuses unpublished-only cleanup when the original operation has a retained intent', async () => {
  const scope = `prefix-published-cleanup-${crypto.randomUUID()}`;
  const saved = await retainPrefixEdit(scope, 'view', intent, draft);
  await expect(finishPrefixEdit(scope, 'view', intent.operation.operationId, { unpublishedOnly: true })).rejects.toThrow(/original prompt edit/);
  expect(readPrefixEdit(scope, 'view')).toEqual(saved);
  expect((await persistedPrompt(saved.prompt.key)).draft?.parts).toEqual(draft.parts);
}, 5000);
it('fails closed when required browser storage cannot retain the operation identity', async () => {
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('storage denied'); });
  await expect(retainPrefixEdit('denied-prefix', 'view', intent, draft)).rejects.toThrow(/storage denied/);
  expect(readPrefixEdit('denied-prefix', 'view')).toBeUndefined();
}, 5000);
it('does not replace an unresolved original operation with a new prefix edit', async () => {
  const scope = `prefix-conflict-${crypto.randomUUID()}`;
  await retainPrefixEdit(scope, 'view', intent, draft);
  await expect(retainPrefixEdit(scope, 'view', { ...intent, operation: { ...intent.operation, operationId: 'replacement' } }, draft)).rejects.toThrow(/original/);
  expect(readPrefixEdit(scope, 'view')?.operation.operationId).toBe('prefix-operation');
}, 5000);
