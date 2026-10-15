import type { ImageDraft, ImageDraftStorageHandle, ImageDraftStorageSnapshot } from '@orchardworks/agent-remote-web/browser';
import type { DraftBinding, DraftTextSnapshot } from './draft-store.js';

declare const draftOwnerToken: unique symbol;
/** Mount-local identity. Persisted revision numbers never reconstruct this token. */
export interface DraftOwnerToken { readonly [draftOwnerToken]: true }
export interface DraftOwnerCapture {
  token: DraftOwnerToken;
  text: string; textRevision: number; imageRevision: number; imageParts: string;
}
type PersistenceStatus = 'pending' | 'saved' | 'failed' | 'cancelled';
export interface DraftRestoreReceipt {
  application: { status: 'not-applied'; reason: 'changed' | 'unavailable' | 'retired' } | { status: 'applied'; token: DraftOwnerToken };
  persistence: { text: PersistenceStatus; image: PersistenceStatus; imageRetention: 'page' | 'local' };
}
interface Ownership { text: DraftBinding; image: ImageDraftStorageHandle; textRevision: number; imageRevision: number }
const ownership = new WeakMap<DraftOwnerToken, Ownership>();
function tokenFor(value: Ownership): DraftOwnerToken {
  const token = {} as DraftOwnerToken;
  ownership.set(token, value);
  return token;
}
const imagePersistence = (snapshot: ImageDraftStorageSnapshot): PersistenceStatus => snapshot.status === 'ready'
  ? snapshot.savedRevision === snapshot.revision ? 'saved' : 'pending' : snapshot.status;

/** Coordinates the two local owners without claiming their persistence is atomic. */
export class ComposerDraftOwner {
  constructor(private readonly text: DraftBinding, private readonly image: ImageDraftStorageHandle) {}

  capture(text = this.text.store.snapshot(this.text.key)): DraftOwnerCapture {
    const image = this.image.snapshot();
    return { token: this.token(text, image.revision), text: text.text, textRevision: text.revision,
      imageRevision: image.revision, imageParts: JSON.stringify(image.draft?.parts ?? []) };
  }

  matches(token: DraftOwnerToken): boolean {
    const expected = ownership.get(token), text = this.text.store.inspect(this.text.key), image = this.image.snapshot();
    return !!expected && expected.text.store === this.text.store && expected.text.key === this.text.key && expected.image === this.image
      && text.status === 'ready' && image.status !== 'cancelled'
      && text.revision === expected.textRevision && image.revision === expected.imageRevision;
  }

  async restore(expected: DraftOwnerToken, replacement: Omit<ImageDraft, 'key' | 'scope'>, isCurrent: () => boolean): Promise<DraftRestoreReceipt> {
    if (!isCurrent()) return this.skipped('retired');
    if (!this.matches(expected)) return this.skipped('changed');
    if (!this.image.apply || this.image.snapshot().status !== 'ready') return this.skipped('unavailable');
    const original = ownership.get(expected)!;
    const text = this.text.store.set(this.text.key, replacement.parts.flatMap(part => part.type === 'text' ? [part.text] : []).join(''));
    if (!text) return this.skipped('retired');
    let token = this.token(text, original.imageRevision);
    // Text subscribers may synchronously edit again, including same-content ABA.
    if (!isCurrent() || !this.matches(token)) return this.applied(token, 'cancelled', 'cancelled', 'page');
    const textCurrent = () => isCurrent() && this.text.store.snapshot(this.text.key).revision === text.revision;
    const image = this.image.apply(original.imageRevision, replacement, textCurrent);
    if (image.application.status === 'applied') token = this.token(text, image.application.revision);
    // An old saved snapshot cannot certify a replacement the writer declined.
    const completion = image.application.status === 'applied' ? image.completion
      : image.completion.then(snapshot => ({ ...snapshot, status: 'cancelled' as const }));
    return this.persist(token, isCurrent, completion);
  }

  /** Retries retention of the exact application without another local replacement. */
  async retain(token: DraftOwnerToken, isCurrent: () => boolean): Promise<DraftRestoreReceipt> {
    if (!isCurrent()) return this.skipped('retired');
    if (!this.matches(token)) return this.skipped('changed');
    const expected = ownership.get(token)!;
    return this.persist(token, isCurrent, this.image.flush(expected.imageRevision, () => isCurrent() && this.matches(token)));
  }

  private token(text: DraftTextSnapshot, imageRevision: number): DraftOwnerToken {
    return tokenFor({ text: this.text, image: this.image, textRevision: text.revision, imageRevision });
  }
  private async persist(token: DraftOwnerToken, isCurrent: () => boolean, imageWrite: Promise<ImageDraftStorageSnapshot>): Promise<DraftRestoreReceipt> {
    const expected = ownership.get(token)!;
    const current = () => isCurrent() && this.matches(token);
    const [text, image] = await Promise.all([
      this.text.store.flushCurrent(this.text.key, expected.textRevision, current).then(result => result.status === 'superseded' ? 'cancelled' as const : result.status, () => 'failed' as const),
      imageWrite.then(snapshot => ({ status: imagePersistence(snapshot), retention: snapshot.retention }), () => ({ status: 'failed' as const, retention: 'page' as const })),
    ]);
    return this.applied(token, text, image.status, image.retention);
  }
  private applied(token: DraftOwnerToken, text: PersistenceStatus, image: PersistenceStatus, imageRetention: 'page' | 'local'): DraftRestoreReceipt {
    return { application: { status: 'applied', token }, persistence: { text, image, imageRetention } };
  }
  private skipped(reason: 'changed' | 'unavailable' | 'retired'): DraftRestoreReceipt {
    return { application: { status: 'not-applied', reason }, persistence: { text: 'cancelled', image: 'cancelled', imageRetention: 'page' } };
  }
}
