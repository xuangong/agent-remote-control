import { SESSION_DRAFT_BYTES, sessionDraftBytes } from '@orchardworks/agent-remote-protocol';
import type { SharedDraft } from '@orchardworks/agent-remote-web';

/** The shared draft a composer last agreed with: its revision and a hash of its text. */
export interface SharedDraftAgreement { revision: number; hash: string }
export interface SharedDraftSyncOptions {
  /** The composer's text now. */
  read(): string;
  /** Puts another device's draft into the composer. */
  apply(text: string): void;
  /** Saves the composer's text for every device and resolves with the revision it got. */
  publish(text: string): Promise<number>;
  /** What this composer last agreed with for this session, remembered across reloads of the tab. */
  agreement?: SharedDraftAgreement;
  remember(agreement: SharedDraftAgreement): void;
  delayMs?: number;
  retryMs?: number;
}
export interface SharedDraftSync {
  /** The Relay's draft for the session, once its drafts arrived: undefined when it keeps none. */
  remote(draft: SharedDraft | undefined): void;
  /** The composer's text changed: typing, or a send emptying it. */
  local(text: string): void;
  dispose(): void;
}

/** A short hash of a draft's text, so a tab remembers what it agreed on without keeping the text twice. */
export function draftHash(text: string): string {
  let a = 0xdeadbeef, b = 0x41c6ce57;
  for (let index = 0; index < text.length; index++) {
    const code = text.charCodeAt(index);
    a = Math.imul(a ^ code, 2654435761); b = Math.imul(b ^ code, 1597334677);
  }
  a = Math.imul(a ^ (a >>> 16), 2246822507) ^ Math.imul(b ^ (b >>> 13), 3266489909);
  b = Math.imul(b ^ (b >>> 16), 2246822507) ^ Math.imul(a ^ (a >>> 13), 3266489909);
  return `${text.length.toString(36)}:${(4294967296 * (2097151 & b) + (a >>> 0)).toString(36)}`;
}

/**
 * Keeps one composer's draft in step with the draft shared across devices. The composer follows a newer shared draft
 * only while it has nothing unpublished of its own, so typing is never overwritten; its own edits are published shortly
 * after the last keystroke, and the last device to edit wins. A composer whose text differs from the shared draft
 * without either being known to be newer (a tab that reloaded with an older draft) keeps its text until it is edited.
 */
export function createSharedDraftSync(options: SharedDraftSyncOptions): SharedDraftSync {
  const delayMs = options.delayMs ?? 800, retryMs = options.retryMs ?? 5_000;
  let agreed = options.agreement, timer: ReturnType<typeof setTimeout> | undefined, publishing = false, again = false, disposed = false;
  const clean = () => agreed ? draftHash(options.read()) === agreed.hash : options.read() === '';
  function agree(revision: number, text: string) {
    agreed = { revision, hash: draftHash(text) };
    options.remember(agreed);
  }
  function schedule(delay = delayMs) {
    if (disposed) return;
    if (publishing) { again = true; return; }
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = undefined; void publish(); }, delay);
  }
  async function publish() {
    if (disposed) return;
    const text = options.read();
    // A draft over the shared bound stays on this device; the others keep the last one that fit.
    if (sessionDraftBytes(text) > SESSION_DRAFT_BYTES || agreed && draftHash(text) === agreed.hash) return;
    publishing = true;
    try {
      const revision = await options.publish(text);
      if (disposed) return;
      if (!agreed || revision > agreed.revision) agree(revision, text);
    } catch {
      if (!disposed) { publishing = false; schedule(retryMs); }
      return;
    } finally { publishing = false; }
    if (again || options.read() !== text) { again = false; schedule(); }
  }
  return {
    remote(draft) {
      if (disposed) return;
      const text = options.read();
      if (!draft) { if (text) schedule(); return; }
      if (agreed && draft.revision <= agreed.revision) return;
      if (clean()) {
        agree(draft.revision, draft.text);
        if (text !== draft.text) options.apply(draft.text);
        return;
      }
      if (text === draft.text) { agree(draft.revision, draft.text); return; }
      // Edited here since the last agreement: this device's text is published and wins. Without one, wait for an edit.
      if (agreed && !timer && !publishing) schedule();
    },
    local(text) {
      if (disposed) return;
      if (agreed && draftHash(text) === agreed.hash) { if (timer) { clearTimeout(timer); timer = undefined; } return; }
      schedule();
    },
    dispose() {
      disposed = true;
      if (timer) clearTimeout(timer);
      timer = undefined;
    },
  };
}
