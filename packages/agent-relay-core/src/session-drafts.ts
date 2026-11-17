import { isSessionDraftRequest, SESSION_DRAFT_LIMIT, type SessionDraft, type SessionDrafts } from '@orchardworks/agent-remote-protocol';
import { MAX_SESSION_DRAFTS, type HostedRelayState, type RelayState, type SavedSessionDraft } from './state.js';

export class SessionDraftsError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
const sessionKey = (draft: Pick<SessionDraft, 'hostId' | 'providerId' | 'nativeSessionId'>) => JSON.stringify([draft.hostId, draft.providerId, draft.nativeSessionId]);

/**
 * Each account's unsent drafts, one per session, shared by every device. Each save gets a revision greater than the
 * draft's previous one, so devices tell newer from known. A cleared draft keeps an empty text until room is needed.
 */
export function createSessionDrafts(state: RelayState, now: () => number = Date.now) {
  /** Each account's view of one committed collection of drafts; committed collections never change. */
  const views = new WeakMap<object, Map<string, SessionDraft[]>>();
  function own(snapshot: HostedRelayState, subject: string): SessionDraft[] {
    const saved = snapshot.sessionDrafts;
    if (!saved) return [];
    let bySubject = views.get(saved);
    if (!bySubject) {
      bySubject = new Map();
      for (const { subject: owner, ...draft } of saved) { const list = bySubject.get(owner) ?? []; list.push(draft); bySubject.set(owner, list); }
      views.set(saved, bySubject);
    }
    return bySubject.get(subject) ?? [];
  }
  function read(subject: string): SessionDrafts {
    return { drafts: own(state.read(), subject).map(draft => ({ ...draft })) };
  }
  return {
    read,
    async save(subject: string, body: unknown): Promise<SessionDraft> {
      if (!isSessionDraftRequest(body)) throw new SessionDraftsError(400, 'invalid_draft', 'A draft needs a session identity and at most 8 KB of text.');
      const key = sessionKey(body);
      const known = own(state.read(), subject).find(draft => sessionKey(draft) === key);
      if (known?.text === body.text) return { ...known };
      let stored: SessionDraft | undefined;
      await state.mutate(draft => {
        const saved = draft.sessionDrafts ??= [];
        const mine = saved.filter(item => item.subject === subject);
        const previous = mine.find(item => sessionKey(item) === key);
        const revision = Math.max(now(), (previous?.revision ?? 0) + 1);
        if (previous) { previous.text = body.text; previous.revision = revision; stored = { ...body, revision }; return; }
        // Past the account's limit, a cleared draft gives way first, then the oldest.
        if (mine.length >= SESSION_DRAFT_LIMIT) {
          const leaving = [...mine].sort((a, b) => Number(!!a.text) - Number(!!b.text) || a.revision - b.revision)[0]!;
          draft.sessionDrafts = saved.filter(item => item !== leaving);
        } else if (saved.length >= MAX_SESSION_DRAFTS) throw new SessionDraftsError(409, 'drafts_limit', 'Drafts are unavailable until some are sent or cleared.');
        const added: SavedSessionDraft = { subject, hostId: body.hostId, providerId: body.providerId, nativeSessionId: body.nativeSessionId, text: body.text, revision };
        draft.sessionDrafts!.push(added);
        stored = { ...body, revision };
      });
      return stored!;
    },
  };
}
