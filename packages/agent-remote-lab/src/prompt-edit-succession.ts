import { isNativePrefixSelection, isSessionExcerpt, type SessionExcerpt } from '@orchardworks/agent-remote-protocol';
import { releaseImageDraft, writeImageDraft, type ImageDraft, type ImageDraftBinding } from '@orchardworks/agent-remote-web/browser';
import type { OpenedSession, SuccessionPrepareInput } from './directory-client.js';
import { clearCacheOnClose, conversationSessionStorage } from './conversation-storage.js';

export interface PrefixEditIntent {
  version: 1; source: OpenedSession; operation: SuccessionPrepareInput;
  owner: { textKey: string; image: ImageDraftBinding };
  baseline: { text: string; textRevision: number; imageRevision: number; imageParts: string };
  prompt: ImageDraftBinding; cancelRequested?: boolean; restored?: boolean;
  restoration?: { text: string; imageParts: string };
  /** Quotes the edited prompt carried; they return to the composer with its text. */
  excerpts?: SessionExcerpt[];
}
const storageKey = (scope: string, view: string) => `agent-remote:recovery:${scope}:prefix-edit:${view}`;
const promptKey = (scope: string, view: string, operationId: string) => JSON.stringify([scope, 'prefix-edit-prompt', view, operationId]);
function assertPromptOwner(scope: string, view: string, intent: PrefixEditIntent): void {
  const legacy = JSON.stringify([scope, 'prefix-edit-prompt', intent.operation.operationId]);
  if (intent.prompt.scope !== scope || intent.prompt.key !== promptKey(scope, view, intent.operation.operationId) && intent.prompt.key !== legacy) {
    throw new Error('The prompt snapshot does not belong to this operation. Its recovery intent has been preserved.');
  }
}
interface PrefixEditWork { tail: Promise<void>; closing: Set<string> }
const pendingEdits = new Map<string, PrefixEditWork>();
function mutatePrefixEdit<T>(scope: string, view: string, action: () => Promise<T>, closing?: string): Promise<T> {
  const key = storageKey(scope, view), work = pendingEdits.get(key) ?? { tail: Promise.resolve(), closing: new Set<string>() };
  if (closing) work.closing.add(closing);
  const result = work.tail.then(action);
  const settled = result.then(() => {}, () => {}).finally(() => { if (work.tail === settled) pendingEdits.delete(key); });
  work.tail = settled; pendingEdits.set(key, work);
  return result;
}
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
    || value.excerpts !== undefined && (!Array.isArray(value.excerpts) || !value.excerpts.every(isSessionExcerpt))
    || ![value.baseline.textRevision, value.baseline.imageRevision].every(item => Number.isSafeInteger(item) && item >= 0)) {
    throw new Error('The original prompt edit could not be read. Its saved intent has been preserved.');
  }
  return value;
}
export function savePrefixEdit(scope: string, view: string, intent: PrefixEditIntent): void {
  if (clearCacheOnClose()) throw new Error('Prompt editing requires retained recovery storage.');
  assertPromptOwner(scope, view, intent);
  const existing = readPrefixEdit(scope, view);
  if (existing && existing.operation.operationId !== intent.operation.operationId) throw new Error('Resolve the original prompt edit before starting another.');
  const encoded = JSON.stringify(intent);
  conversationSessionStorage.setItem(storageKey(scope, view), encoded);
  if (conversationSessionStorage.getItem(storageKey(scope, view)) !== encoded) throw new Error('The prompt edit identity could not be retained.');
}
export async function retainPrefixEdit(scope: string, view: string, intent: Omit<PrefixEditIntent, 'prompt'>, draft: Omit<ImageDraft, 'scope' | 'key'>, isCurrent: () => boolean = () => true): Promise<PrefixEditIntent> {
  if (pendingEdits.get(storageKey(scope, view))?.closing.has(intent.operation.operationId)) throw new Error('The original prompt edit is closing.');
  return mutatePrefixEdit(scope, view, async () => {
    const existing = readPrefixEdit(scope, view);
    if (existing && existing.operation.operationId !== intent.operation.operationId) throw new Error('Resolve the original prompt edit before starting another.');
    if (!isCurrent()) throw new Error('The prompt edit owner changed.');
    if (existing) { assertPromptOwner(scope, view, existing); return existing; }
    const prompt = { scope, key: promptKey(scope, view, intent.operation.operationId) };
    const retained: PrefixEditIntent = { ...intent, prompt };
    try {
      // The operation is publishable only after its selected prompt can survive reload.
      const result = await writeImageDraft({ ...draft, ...prompt }).catch(() => {
        throw new Error('The selected prompt could not be retained in browser storage. No native preparation was requested.');
      });
      if (!isCurrent() || result.status !== 'saved' || result.retention !== 'local') {
        throw new Error('The selected prompt could not be retained for recovery. No native preparation was requested.');
      }
      savePrefixEdit(scope, view, retained);
      return retained;
    } catch (error) {
      // A failed readback can still have published the intent. Preserve that
      // recoverable operation; compensate only our unpublished private snapshot.
      let published: PrefixEditIntent | undefined;
      try { published = readPrefixEdit(scope, view); }
      catch (readError) {
        throw new AggregateError([error, readError], 'The prompt edit identity could not be verified. Its snapshot was preserved; restore browser storage before retrying recovery.');
      }
      if (published?.operation.operationId !== intent.operation.operationId || published.prompt.key !== prompt.key) {
        try { await releaseImageDraft(prompt); }
        catch (cleanupError) {
          // If identity storage recovered, retain the exact cancellation identity
          // so ordinary recovery can retry cleanup without preparing a candidate.
          try { savePrefixEdit(scope, view, { ...retained, cancelRequested: true }); }
          catch (identityError) {
            throw new AggregateError([error, cleanupError, identityError], 'The selected prompt cleanup failed, and its recovery identity could not be retained. Browser storage must recover before cleanup can be retried.');
          }
          throw new AggregateError([error, cleanupError], 'The selected prompt cleanup failed. Its snapshot has been preserved for recovery.');
        }
      }
      throw error;
    }
  });
}
export function finishPrefixEdit(scope: string, view: string, operationId: string, options: { unpublishedOnly?: boolean } = {}): Promise<void> {
  return mutatePrefixEdit(scope, view, async () => {
    const intent = readPrefixEdit(scope, view);
    if (options.unpublishedOnly && intent) throw new Error('Resolve the original prompt edit before starting another.');
    if (intent && intent.operation.operationId !== operationId) return;
    if (intent) assertPromptOwner(scope, view, intent);
    await releaseImageDraft(intent?.prompt ?? { scope, key: promptKey(scope, view, operationId) });
    if (readPrefixEdit(scope, view)?.operation.operationId === operationId) conversationSessionStorage.removeItem(storageKey(scope, view));
  }, operationId);
}
