import { isNativePrefixSelection } from '@orchardworks/agent-remote-protocol';
import { writeImageDraft, type ImageDraft, type ImageDraftBinding } from '@orchardworks/agent-remote-web/browser';
import type { OpenedSession, SuccessionPrepareInput } from './directory-client.js';
import { clearCacheOnClose, conversationSessionStorage } from './conversation-storage.js';

export interface PrefixEditIntent {
  version: 1; source: OpenedSession; operation: SuccessionPrepareInput;
  owner: { textKey: string; image: ImageDraftBinding };
  baseline: { text: string; textRevision: number; imageRevision: number; imageParts: string };
  prompt: ImageDraftBinding; cancelRequested?: boolean; restored?: boolean;
  restoration?: { text: string; imageParts: string };
}
const storageKey = (scope: string, view: string) => `agent-remote:recovery:${scope}:prefix-edit:${view}`;
/** Prefix intents never reinterpret legacy /create reservations. */
export function readPrefixEdit(scope: string, view: string): PrefixEditIntent | undefined {
  const raw = conversationSessionStorage.getItem(storageKey(scope, view));
  if (raw === null) return;
  const value = JSON.parse(raw) as PrefixEditIntent;
  if (value?.version !== 1 || !value.source || !value.operation || !value.owner || !value.baseline || !value.prompt
    || !isNativePrefixSelection(value.operation.preparation)
    || ![value.source.agentId, value.source.providerId, value.source.nativeSessionId, value.operation.operationId,
      value.owner.textKey, value.owner.image?.scope, value.owner.image?.key, value.prompt.scope, value.prompt.key].every(item => typeof item === 'string' && item.length > 0)
    || value.operation.providerId !== value.source.providerId || value.operation.nativeSessionId !== value.source.nativeSessionId
    || !Number.isSafeInteger(value.operation.expectedRevision) || value.operation.expectedRevision < 1
    || typeof value.baseline.text !== 'string' || typeof value.baseline.imageParts !== 'string'
    || value.restoration !== undefined && (typeof value.restoration?.text !== 'string' || typeof value.restoration?.imageParts !== 'string')
    || ![value.baseline.textRevision, value.baseline.imageRevision].every(item => Number.isSafeInteger(item) && item >= 0)) {
    throw new Error('The original prompt edit could not be read. Its saved intent has been preserved.');
  }
  return value;
}
export function savePrefixEdit(scope: string, view: string, intent: PrefixEditIntent): void {
  if (clearCacheOnClose()) throw new Error('Prompt editing requires retained recovery storage.');
  const existing = readPrefixEdit(scope, view);
  if (existing && existing.operation.operationId !== intent.operation.operationId) throw new Error('Resolve the original prompt edit before starting another.');
  const encoded = JSON.stringify(intent);
  conversationSessionStorage.setItem(storageKey(scope, view), encoded);
  if (conversationSessionStorage.getItem(storageKey(scope, view)) !== encoded) throw new Error('The prompt edit identity could not be retained.');
}
export async function retainPrefixEdit(scope: string, view: string, intent: Omit<PrefixEditIntent, 'prompt'>, draft: Omit<ImageDraft, 'scope' | 'key'>, isCurrent: () => boolean = () => true): Promise<PrefixEditIntent> {
  const existing = readPrefixEdit(scope, view);
  if (existing && existing.operation.operationId !== intent.operation.operationId) throw new Error('Resolve the original prompt edit before starting another.');
  if (!isCurrent()) throw new Error('The prompt edit owner changed.');
  const prompt = { scope, key: JSON.stringify([scope, 'prefix-edit-prompt', intent.operation.operationId]) };
  const retained: PrefixEditIntent = { ...intent, prompt };
  // The operation is publishable only after its selected prompt can survive reload.
  const result = await writeImageDraft({ ...draft, ...prompt }).catch(() => {
    throw new Error('The selected prompt could not be retained in browser storage. No native preparation was requested.');
  });
  if (!isCurrent() || result.status !== 'saved' || result.retention !== 'local') {
    throw new Error('The selected prompt could not be retained for recovery. No native preparation was requested.');
  }
  savePrefixEdit(scope, view, retained);
  return retained;
}
export function finishPrefixEdit(scope: string, view: string, operationId: string): void {
  if (readPrefixEdit(scope, view)?.operation.operationId === operationId) conversationSessionStorage.removeItem(storageKey(scope, view));
}
