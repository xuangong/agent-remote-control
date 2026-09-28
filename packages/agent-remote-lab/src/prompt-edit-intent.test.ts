import { afterEach, expect, it } from 'vitest';
import { beginPromptEditReservation, finishPromptEditReservation, readPromptEditReservation, retainPromptEditReservation } from './prompt-edit-intent.js';
afterEach(() => sessionStorage.clear());
it('retains only the pending operation identity across reload and isolates account scopes', () => {
  const intent = { key: 'source-turn-message', operationId: crypto.randomUUID(), restored: true };
  retainPromptEditReservation('alice', intent);
  expect(readPromptEditReservation('alice')).toEqual({ key: intent.key, operationId: intent.operationId });
  expect(readPromptEditReservation('bob')).toBeUndefined();
  finishPromptEditReservation('alice', crypto.randomUUID());
  expect(readPromptEditReservation('alice')).toBeDefined();
  finishPromptEditReservation('alice', intent.operationId);
  expect(readPromptEditReservation('alice')).toBeUndefined();
});

it('reuses an unfinished edit but creates a fresh operation after completion at the same prompt', () => {
  const first = beginPromptEditReservation('alice', 'source-turn-message');
  expect(beginPromptEditReservation('alice', first.key)).toEqual(first);
  finishPromptEditReservation('alice', first.operationId);
  const next = beginPromptEditReservation('alice', first.key);
  expect(next.operationId).not.toBe(first.operationId);
  expect(readPromptEditReservation('alice')).toEqual(next);
});
it('does not reuse the legacy per-message operation id for a new edit', () => {
  const old = crypto.randomUUID();
  sessionStorage.setItem('arc:prompt-edit-intent:alice:prompt', old);
  expect(beginPromptEditReservation('alice', 'prompt').operationId).not.toBe(old);
});
