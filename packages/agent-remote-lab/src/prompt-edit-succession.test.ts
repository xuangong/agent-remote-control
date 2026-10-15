import 'fake-indexeddb/auto';
import { afterEach, expect, it, vi } from 'vitest';
import { readPromptEditReservation, retainPromptEditReservation } from './prompt-edit-intent.js';
import { retainPrefixEdit, readPrefixEdit, finishPrefixEdit } from './prompt-edit-succession.js';
import { readImageDraft } from '@orchardworks/agent-remote-web/browser';
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
  finishPrefixEdit(scope, 'window-one', 'other-operation');
  expect(readPrefixEdit(scope, 'window-one')).toBeDefined();
  finishPrefixEdit(scope, 'window-one', 'prefix-operation');
  expect(readPrefixEdit(scope, 'window-one')).toBeUndefined();
  expect(readPromptEditReservation(scope)?.key).toBe('legacy');
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
