import type { RelayState } from './state.js';

export interface StarIdentity { hostId: string; providerId: string; nativeSessionId: string }
export interface SessionStar extends StarIdentity { title: string; parentNativeSessionId?: string; workspace?: string; starredAt: number }
export interface SavedSessionStar extends SessionStar { subject: string }
export interface VisibleSessionStar extends SessionStar { available: boolean; online: boolean; hostName?: string }
export const MAX_USER_STARS = 256;
export const starKey = (value: StarIdentity): string => JSON.stringify([value.hostId, value.providerId, value.nativeSessionId]);
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown, maximum: number): value is string => typeof value === 'string' && value.trim().length > 0 && value.length <= maximum && !/[\u0000-\u001f]/.test(value);
export function validStarIdentity(value: unknown): value is StarIdentity {
  return record(value) && text(value.hostId, 512) && text(value.providerId, 512) && text(value.nativeSessionId, 4096);
}
export function validSessionStar(value: unknown): value is SessionStar {
  return validStarIdentity(value) && record(value) && text(value.title, 512) && Number.isSafeInteger(value.starredAt) && (value.starredAt as number) >= 0 &&
    (value.parentNativeSessionId === undefined || text(value.parentNativeSessionId, 4096)) && (value.workspace === undefined || text(value.workspace, 4096));
}
export class StarError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
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
        const stars = draft.sessionStars ??= [];
        const previous = stars.find(value => value.subject === subject && starKey(value) === starKey(item));
        if (previous) Object.assign(previous, item, { starredAt: previous.starredAt });
        else {
          if (stars.filter(value => value.subject === subject).length >= MAX_USER_STARS || stars.length >= 16384) throw new StarError(409, 'star_limit', 'Your favorites are full. Remove a star before adding another.');
          stars.push({ ...item, subject });
        }
      });
    },
    async remove(subject: string, body: unknown): Promise<void> {
      if (!validStarIdentity(body) || Object.keys(body).some(key => !['hostId', 'providerId', 'nativeSessionId'].includes(key))) throw new StarError(400, 'invalid_star', 'A session identity is required.');
      await state.mutate(draft => { draft.sessionStars = (draft.sessionStars ?? []).filter(item => item.subject !== subject || starKey(item) !== starKey(body)); });
    },
  };
}
