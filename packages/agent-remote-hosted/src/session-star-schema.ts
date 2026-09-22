export interface StarIdentity { hostId: string; providerId: string; nativeSessionId: string }
export interface SessionStar extends StarIdentity { title: string; parentNativeSessionId?: string; workspace?: string; starredAt: number; favoriteId?: string; folderId?: string | null; order?: number }
export interface SavedSessionStar extends SessionStar { subject: string }
export interface VisibleSessionStar extends SessionStar { available: boolean; online: boolean; hostName?: string }
export const MAX_USER_STARS = 256;
export const starKey = (value: StarIdentity): string => JSON.stringify([value.hostId, value.providerId, value.nativeSessionId]);
export const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
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
