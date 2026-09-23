import { conversationSessionStorage } from './conversation-storage.js';
import type { OpenedSession } from './directory-client.js';

export interface PromptEditReservation { key: string; operationId: string; target?: OpenedSession; restored?: boolean }
const storageKey = (scope: string) => 'arc:prompt-edit-pending:' + scope;
/** An interrupted initiating tab must restore the prompt before following its broadcast. */
export function readPromptEditReservation(scope: string): PromptEditReservation | undefined {
  try {
    const value = JSON.parse(conversationSessionStorage.getItem(storageKey(scope)) ?? 'null');
    if (value && typeof value.key === 'string' && /^[a-f0-9-]{36}$/i.test(value.operationId)) return { key: value.key, operationId: value.operationId };
  } catch { /* A tab can still preserve an intent in memory without storage. */ }
  return undefined;
}
export function retainPromptEditReservation(scope: string, value: PromptEditReservation): void {
  try { conversationSessionStorage.setItem(storageKey(scope), JSON.stringify({ key: value.key, operationId: value.operationId })); } catch { /* The caller retains the live intent. */ }
}
export function finishPromptEditReservation(scope: string, operationId: string): void {
  try { if (readPromptEditReservation(scope)?.operationId === operationId) conversationSessionStorage.removeItem(storageKey(scope)); } catch { /* The live draft remains usable. */ }
}
