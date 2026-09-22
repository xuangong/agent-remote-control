import { afterEach, expect, it } from 'vitest';
import { finishPromptEditReservation, readPromptEditReservation, retainPromptEditReservation } from './prompt-edit-intent.js';
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
