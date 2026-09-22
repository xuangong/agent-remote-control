import type { RelayState } from './state.js';
import { organizeFavorites, advanceFavorites, newFavoriteIdentity } from './favorites.js';

import { MAX_USER_STARS, StarError, record, starKey, validSessionStar, validStarIdentity, type StarIdentity, type VisibleSessionStar } from './session-star-schema.js';
export { MAX_USER_STARS, StarError, starKey, validSessionStar, validStarIdentity, type StarIdentity, type SessionStar, type SavedSessionStar, type VisibleSessionStar } from './session-star-schema.js';
export function createSessionStars(state: RelayState, access: (subject: string, item: StarIdentity) => { online: boolean; hostName: string } | undefined) {
  return {
    list(subject: string): VisibleSessionStar[] {
      return (state.read().sessionStars ?? []).filter(item => item.subject === subject).map(({ subject: _subject, ...item }) => {
        const host = access(subject, item);
        return { ...item, available: !!host, online: host?.online ?? false, ...(host ? { hostName: host.hostName } : {}) };
      }).sort((a, b) => b.starredAt - a.starredAt || starKey(a).localeCompare(starKey(b)));
    },
    async save(subject: string, body: unknown): Promise<void> {
      const item = record(body) ? { ...body, starredAt: Date.now() } : undefined;
      if (!validSessionStar(item) || !record(body) || Object.keys(body).some(key => !['hostId', 'providerId', 'nativeSessionId', 'title', 'parentNativeSessionId', 'workspace'].includes(key))) {
        throw new StarError(400, 'invalid_star', 'A session identity and title are required.');
      }
      await state.mutate(draft => {
        if (!access(subject, item)) throw new StarError(404, 'session_unavailable', 'This session is not available to your account.');
        const tree = organizeFavorites(draft, subject);
        const stars = draft.sessionStars ??= [];
        const previous = stars.find(value => value.subject === subject && starKey(value) === starKey(item));
        if (previous) Object.assign(previous, item, { starredAt: previous.starredAt });
        else {
          if (stars.filter(value => value.subject === subject).length >= MAX_USER_STARS || stars.length >= 16384) throw new StarError(409, 'star_limit', 'Your favorites are full. Remove a star before adding another.');
          const favoriteId = newFavoriteIdentity(draft, subject, item);
          if (tree.folders.some(folder => folder.id === favoriteId)) throw new StarError(409, 'favorite_exists', 'This favorite identity already exists.');
          const order = Math.max(-1, ...tree.folders.filter(folder => folder.parentId === null).map(folder => folder.order), ...stars.filter(star => star.subject === subject && star.folderId === null).map(star => star.order!)) + 1;
          stars.push({ ...item, subject, favoriteId, folderId: null, order });
        }
        advanceFavorites(draft, tree);
      });
    },
    async remove(subject: string, body: unknown): Promise<void> {
      if (!validStarIdentity(body) || Object.keys(body).some(key => !['hostId', 'providerId', 'nativeSessionId'].includes(key))) throw new StarError(400, 'invalid_star', 'A session identity is required.');
      await state.mutate(draft => {
        const tree = organizeFavorites(draft, subject);
        draft.sessionStars = (draft.sessionStars ?? []).filter(item => item.subject !== subject || starKey(item) !== starKey(body));
        advanceFavorites(draft, tree);
      });
    },
  };
}
