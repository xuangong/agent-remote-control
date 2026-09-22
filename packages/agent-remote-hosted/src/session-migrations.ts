import { organizeFavorites, advanceFavorites } from './favorites.js';
import type { SessionMigration } from '@orchardworks/agent-remote-protocol';
import type { RelayState } from './state.js';
import { starKey, StarError, type StarIdentity } from './session-stars.js';
export interface SavedSessionMigration extends SessionMigration { subject: string }
export function createSessionMigrations(state: RelayState, access: (subject: string, item: StarIdentity) => boolean) {
  return {
    list(subject: string): SessionMigration[] {
      return (state.read().sessionMigrations ?? []).filter(item => item.subject === subject && access(subject, item.to))
        .map(({ subject: _, ...item }) => item);
    },
    check(subject: string, from: StarIdentity, id: string): void {
      if (!id.trim() || id.length > 128) throw new StarError(400, 'invalid_migration', 'The edit identity is invalid.');
      const records = state.read().sessionMigrations ?? [];
      const byId = records.find(item => item.subject === subject && item.id === id);
      if (byId && starKey(byId.from) !== starKey(from)) throw new StarError(409, 'migration_conflict', 'This edit identity belongs to another conversation.');
      if (!byId && (records.length >= 16384 || records.filter(item => item.subject === subject).length >= 1024)) throw new StarError(409, 'migration_limit', 'The prompt-edit history limit has been reached.');
      const prior = records.find(item => item.subject === subject && starKey(item.from) === starKey(from));
      if (prior && prior.id !== id) throw new StarError(409, 'session_already_edited', 'This conversation was already edited on another device. Open its new branch before editing again.');
    },
    async save(subject: string, item: SessionMigration): Promise<void> {
      await state.mutate(draft => {
        if (!access(subject, item.from) || !access(subject, item.to)) throw new StarError(403, 'session_forbidden', 'Session access is unavailable.');
        if (item.from.hostId !== item.to.hostId || item.from.providerId !== item.to.providerId || starKey(item.from) === starKey(item.to)) throw new StarError(400, 'invalid_migration', 'The branch identity is invalid.');
        const migrations = draft.sessionMigrations ??= [];
        const prior = migrations.find(value => value.subject === subject && (value.id === item.id || starKey(value.from) === starKey(item.from)));
        if (prior) {
          if (prior.id !== item.id || starKey(prior.from) !== starKey(item.from) || starKey(prior.to) !== starKey(item.to)) throw new StarError(409, 'migration_conflict', 'This conversation already has another prompt-edit branch.');
          return;
        }
        if (migrations.length >= 16384 || migrations.filter(value => value.subject === subject).length >= 1024) throw new StarError(409, 'migration_limit', 'The prompt-edit history limit has been reached.');
        migrations.push({ ...item, subject });
        const old = draft.sessionStars?.find(star => star.subject === subject && starKey(star) === starKey(item.from));
        if (old) {
          const tree = organizeFavorites(draft, subject);
          draft.sessionStars = draft.sessionStars!.filter(star => star !== old && (star.subject !== subject || starKey(star) !== starKey(item.to)));
          const { parentNativeSessionId: _, ...saved } = old;
          draft.sessionStars.push({ ...saved, hostId: item.to.hostId, providerId: item.to.providerId, nativeSessionId: item.to.nativeSessionId });
          advanceFavorites(draft, tree);
        }
      });
    },
  };
}
