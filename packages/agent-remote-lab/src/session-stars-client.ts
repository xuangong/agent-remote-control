import { workspaceFetch } from './workspace-access.js';
import { validSessionStar, type SessionStar, type StarIdentity, type VisibleSessionStar } from '@orchardworks/agent-remote-hosted/session-star-schema';
export type { SessionStar, StarIdentity, VisibleSessionStar };
export type StarInput = Omit<SessionStar, 'starredAt'>;
function validSuccessionProgress(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const progress = value as Record<string, unknown>;
  if (progress.version !== 1 || Object.keys(progress).some(key => !['version', 'roles'].includes(key)) || !Array.isArray(progress.roles) || progress.roles.length > 1024) return false;
  const scopes = new Set<string>();
  return progress.roles.every((item: unknown) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
    const role = item as Record<string, unknown>;
    const fields = ['hostId', 'controllerId', 'roleId', 'roleRevision', 'operationId', 'status'];
    if (Object.keys(role).length !== fields.length || Object.keys(role).some(key => !fields.includes(key)) ||
      !['hostId', 'controllerId', 'roleId', 'operationId'].every(key => typeof role[key] === 'string' && (role[key] as string).length > 0 && (role[key] as string).length <= 512 && !/[\u0000-\u001f\u007f]/.test(role[key] as string)) ||
      !/^[A-Za-z0-9_-]{1,256}$/.test(role.hostId as string) || !Number.isSafeInteger(role.roleRevision) || (role.roleRevision as number) < 2 || !['pending', 'applied'].includes(role.status as string)) return false;
    const key = JSON.stringify([role.hostId, role.controllerId, role.roleId]);
    if (scopes.has(key)) return false;
    scopes.add(key); return true;
  });
}
export class SessionStarsClient {
  constructor(private readonly baseUrl: string, private readonly fetcher: typeof fetch = workspaceFetch) {}
  private async request(method: string, body?: StarInput | StarIdentity, signal?: AbortSignal): Promise<VisibleSessionStar[]> {
    const response = await this.fetcher(new URL('v1/stars', this.baseUrl), { method, credentials: 'same-origin', cache: 'no-store',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000),
      ...(body ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}) });
    const value = await response.json();
    if (!response.ok) throw new Error(typeof value?.error === 'string' ? value.error : 'Favorites could not be updated. Try again.');
    if (!Array.isArray(value?.stars) || !value.stars.every((item: unknown) => validSessionStar(item) && 'available' in item && typeof item.available === 'boolean' && 'online' in item && typeof item.online === 'boolean')) throw new Error('The favorites response is invalid.');
    return value.stars;
  }
  private async favoritesRequest(command?: FavoriteCommand, signal?: AbortSignal): Promise<FavoritesSnapshot> {
    const response = await this.fetcher(new URL('v1/favorites', this.baseUrl), { method: command ? 'POST' : 'GET', credentials: 'same-origin', cache: 'no-store',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000),
      ...(command ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(command) } : {}) });
    const value = await response.json();
    if (!response.ok) {
      const message = typeof value?.error === 'string' ? value.error : 'Favorites could not be updated. Try again.';
      if (response.status === 409) throw new FavoritesConflict(message);
      throw new Error(message);
    }
    if (value?.successionProgress !== undefined && !validSuccessionProgress(value.successionProgress) || !Number.isSafeInteger(value?.revision) || value.revision < 0 || !Array.isArray(value.folders) || !value.folders.every((folder: any) =>
      typeof folder?.id === 'string' && typeof folder.title === 'string' && (folder.parentId === null || typeof folder.parentId === 'string') && Number.isSafeInteger(folder.order)) ||
      !Array.isArray(value.stars) || !value.stars.every((star: any) => validSessionStar(star) && typeof star.favoriteId === 'string' &&
        (star.folderId === null || typeof star.folderId === 'string') && Number.isSafeInteger(star.order) && 'available' in star && typeof star.available === 'boolean' && 'online' in star && typeof star.online === 'boolean')) {
      throw new Error('The favorites response is invalid.');
    }
    return value;
  }
  snapshot(signal?: AbortSignal) { return this.favoritesRequest(undefined, signal); }
  command(command: FavoriteCommand, signal?: AbortSignal) { return this.favoritesRequest(command, signal); }
  list(signal?: AbortSignal) { return this.request('GET', undefined, signal); }
  save(item: StarInput, signal?: AbortSignal) { return this.request('POST', item, signal); }
  remove(item: StarIdentity, signal?: AbortSignal) { return this.request('DELETE', { hostId: item.hostId, providerId: item.providerId, nativeSessionId: item.nativeSessionId }, signal); }
}

export type { Folder, FavoritesSnapshot, FavoriteCommand } from '@orchardworks/agent-remote-hosted/favorites';
import type { FavoritesSnapshot, FavoriteCommand } from '@orchardworks/agent-remote-hosted/favorites';
type WithoutRevision<T> = T extends unknown ? Omit<T, 'revision'> : never;
export type FavoriteChange = WithoutRevision<FavoriteCommand>;
export class FavoritesConflict extends Error {}
