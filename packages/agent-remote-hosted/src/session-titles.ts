import type { SessionTitleUpdate } from '@orchardworks/agent-remote-protocol';
import { updateFavoriteSessionTitles } from './favorites.js';
import { StarError, starKey, validSessionStar, type StarIdentity } from './session-stars.js';
import type { HostedRelayState, RelayState } from './state.js';

export const MAX_SESSION_TITLES = 16384;

export function pruneSessionTitles(draft: HostedRelayState): void {
  if (!draft.sessionTitles) return;
  const hosts = new Set(draft.tenants.flatMap(tenant => tenant.broker.hosts.map(host => host.id)));
  draft.sessionTitles = draft.sessionTitles.filter(session => hosts.has(session.hostId));
}

/** Confirmed native names survive browser reconnects independently of favorites. */
export function createSessionTitles(state: RelayState, access: (subject: string, session: StarIdentity) => boolean) {
  return {
    list(subject: string): SessionTitleUpdate[] {
      return (state.read().sessionTitles ?? []).filter(session => access(subject, session));
    },
    async record(identity: StarIdentity, title: string): Promise<void> {
      if (!validSessionStar({ ...identity, title, starredAt: 0 }) || !title.trim() || /[\u0000-\u001f\u007f]/.test(title)) {
        throw new StarError(502, 'invalid_session_title', 'The native session name is invalid.');
      }
      await state.mutate(draft => {
        updateFavoriteSessionTitles(draft, identity, title, access);
        const records = draft.sessionTitles ??= [];
        const key = starKey(identity), previous = records.find(session => starKey(session) === key);
        if (previous?.title === title) return;
        const revision = Math.max(draft.sessionTitleRevision ?? 0, ...(draft.favoritesTrees ?? []).map(tree => tree.revision));
        if (revision >= Number.MAX_SAFE_INTEGER) throw new StarError(409, 'session_title_limit', 'The session title revision limit has been reached.');
        draft.sessionTitleRevision = revision + 1;
        const session = { ...identity, title, revision: draft.sessionTitleRevision };
        if (previous) Object.assign(previous, session);
        else records.push(session);
        if (records.length > MAX_SESSION_TITLES) {
          records.sort((a, b) => b.revision - a.revision);
          records.length = MAX_SESSION_TITLES;
        }
        pruneSessionTitles(draft);
      });
    },
  };
}
