import type { SessionStar, StarIdentity, VisibleSessionStar } from './session-star-schema.js';

/** The favorites tree as the Relay serves it to the browser, and the commands the browser sends back. */
export interface Folder { id: string; parentId: string | null; title: string; order: number }
export type OrganizedSessionStar = VisibleSessionStar & { favoriteId: string; folderId: string | null; order: number };
export interface FavoritesSuccessionCheckpoint { hostId: string; controllerId: string; roleId: string; roleRevision: number; operationId: string; status: 'pending' | 'applied' }
export interface FavoritesSnapshot { revision: number; folders: Folder[]; stars: OrganizedSessionStar[]; successionProgress?: { version: 1; roles: FavoritesSuccessionCheckpoint[] } }
export interface SavedFavoritesTree { subject: string; revision: number; folders: Folder[] }
export type FavoriteCommand = { revision: number } & (
  | { type: 'create-folder'; id: string; parentId: string | null; title: string }
  | { type: 'rename-folder'; id: string; title: string }
  | { type: 'move'; id: string; parentId: string | null; beforeId: string | null }
  | { type: 'delete-folder'; id: string }
  | { type: 'save-session'; session: Omit<SessionStar, 'starredAt'>; folderId: string | null }
  | { type: 'remove-session'; session: StarIdentity }
);
export const MAX_FAVORITE_FOLDERS = 128;
export const MAX_FAVORITE_DEPTH = 8;
