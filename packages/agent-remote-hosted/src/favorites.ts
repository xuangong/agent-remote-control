import { createHash, randomUUID } from 'node:crypto';
import type { HostedRelayState, RelayState } from './state.js';
import { MAX_USER_STARS, StarError, starKey, validSessionStar, validStarIdentity, type SavedSessionStar, type SessionStar, type StarIdentity, type VisibleSessionStar } from './session-star-schema.js';

export interface Folder { id: string; parentId: string | null; title: string; order: number }
export type OrganizedSessionStar = VisibleSessionStar & { favoriteId: string; folderId: string | null; order: number };
export interface FavoritesSnapshot { revision: number; folders: Folder[]; stars: OrganizedSessionStar[] }
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
const MAX_TREES = 1024;
type OrganizedSavedStar = SavedSessionStar & { favoriteId: string; folderId: string | null; order: number };
type Access = (subject: string, item: StarIdentity) => { online: boolean; hostName: string } | undefined;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const label = (value: unknown, max: number): value is string => typeof value === 'string' && !!value.trim() && value.length <= max && !/[\u0000-\u001f]/.test(value);
const id = (value: unknown): value is string => label(value, 128);
const parent = (value: unknown): value is string | null => value === null || id(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const fail = (status: number, code: string, message: string): never => { throw new StarError(status, code, message); };
export const favoriteIdentity = (subject: string, star: StarIdentity): string => 'star_' + createHash('sha256').update(JSON.stringify([subject, starKey(star)])).digest('hex');
export function newFavoriteIdentity(draft: HostedRelayState, subject: string, star: StarIdentity): string {
  let candidate = favoriteIdentity(subject, star);
  const used = new Set([...(draft.sessionStars ?? []).filter(item => item.subject === subject).map(item => item.favoriteId), ...(draft.favoritesTrees?.find(tree => tree.subject === subject)?.folders ?? []).map(folder => folder.id)]);
  while (used.has(candidate)) candidate = 'star_' + randomUUID();
  return candidate;
}
const savedStars = (draft: HostedRelayState, subject: string) => (draft.sessionStars ?? []).filter(star => star.subject === subject) as OrganizedSavedStar[];
function sorted<T extends { order: number }>(items: T[]): T[] { return items.sort((a, b) => a.order - b.order); }
function siblings(draft: HostedRelayState, tree: SavedFavoritesTree, parentId: string | null): Array<{ id: string; item: Folder | OrganizedSavedStar; order: number }> {
  return sorted([
    ...tree.folders.filter(folder => folder.parentId === parentId).map(folder => ({ id: folder.id, item: folder, order: folder.order })),
    ...savedStars(draft, tree.subject).filter(star => star.folderId === parentId).map(star => ({ id: star.favoriteId, item: star, order: star.order })),
  ]);
}
function normalize(draft: HostedRelayState, tree: SavedFavoritesTree) {
  for (const parentId of [null, ...tree.folders.map(folder => folder.id)]) siblings(draft, tree, parentId).forEach((entry, order) => { entry.item.order = order; });
}
/** Materialize legacy metadata only inside a transaction (or a disposable read projection). */
export function organizeFavorites(draft: HostedRelayState, subject: string): SavedFavoritesTree {
  const trees = draft.favoritesTrees ??= [];
  let tree = trees.find(item => item.subject === subject);
  if (!tree) {
    if (trees.length >= MAX_TREES) fail(409, 'favorites_limit', 'The favorites account capacity has been reached.');
    tree = { subject, revision: 0, folders: [] }; trees.push(tree);
  }
  const stars = (draft.sessionStars ?? []).filter(star => star.subject === subject);
  let order = Math.max(-1, ...tree.folders.filter(folder => folder.parentId === null).map(folder => folder.order), ...stars.filter(star => star.folderId === null).map(star => star.order ?? -1)) + 1;
  for (const star of stars.sort((a, b) => b.starredAt - a.starredAt || starKey(a).localeCompare(starKey(b)))) {
    if (star.favoriteId === undefined) Object.assign(star, { favoriteId: favoriteIdentity(subject, star), folderId: null, order: order++ });
  }
  return tree;
}
export function advanceFavorites(draft: HostedRelayState, tree: SavedFavoritesTree): void {
  if (tree.revision >= Number.MAX_SAFE_INTEGER) fail(409, 'favorites_limit', 'The favorites revision limit has been reached.');
  normalize(draft, tree); tree.revision++;
}
function validStructure(tree: SavedFavoritesTree, stars: SavedSessionStar[]): boolean {
  const ids = new Set<string>(); const positions = new Set<string>();
  const folders = new Map(tree.folders.map(folder => [folder.id, folder]));
  for (const item of [...tree.folders.map(folder => ({ id: folder.id, parent: folder.parentId, order: folder.order })), ...stars.filter(star => star.favoriteId !== undefined).map(star => ({ id: star.favoriteId!, parent: star.folderId, order: star.order }))]) {
    if (!id(item.id) || ids.has(item.id) || !parent(item.parent) || !integer(item.order) || (item.parent !== null && !folders.has(item.parent))) return false;
    ids.add(item.id); const position = JSON.stringify([item.parent, item.order]);
    if (positions.has(position)) return false; positions.add(position);
  }
  for (const folder of tree.folders) {
    const visited = new Set<string>(); let current: Folder | undefined = folder;
    while (current) {
      if (visited.has(current.id) || visited.size >= MAX_FAVORITE_DEPTH) return false;
      visited.add(current.id); current = current.parentId === null ? undefined : folders.get(current.parentId);
    }
  }
  return true;
}
export function validFavoritesState(state: HostedRelayState): boolean {
  const trees = state.favoritesTrees;
  if (trees !== undefined && (!Array.isArray(trees) || trees.length > MAX_TREES)) return false;
  const subjects = new Set<string>();
  for (const tree of trees ?? []) {
    if (!record(tree) || !label(tree.subject, 512) || subjects.has(tree.subject) || !integer(tree.revision) || !Array.isArray(tree.folders) || tree.folders.length > MAX_FAVORITE_FOLDERS || !tree.folders.every(folder => record(folder) && id(folder.id) && parent(folder.parentId) && label(folder.title, 128) && integer(folder.order))) return false;
    subjects.add(tree.subject);
    if (!validStructure(tree, (state.sessionStars ?? []).filter(star => star.subject === tree.subject))) return false;
  }
  return (state.sessionStars ?? []).every(star => star.favoriteId === undefined ? star.folderId === undefined && star.order === undefined : subjects.has(star.subject) && parent(star.folderId) && integer(star.order));
}
function validSessionInput(value: unknown): value is Omit<SessionStar, 'starredAt'> {
  return record(value) && validSessionStar({ ...value, starredAt: 0 }) && Object.keys(value).every(key => ['hostId', 'providerId', 'nativeSessionId', 'title', 'parentNativeSessionId', 'workspace'].includes(key));
}
function validCommand(value: unknown): value is FavoriteCommand {
  if (!record(value) || !integer(value.revision)) return false;
  const fields: Record<string, string[]> = {
    'create-folder': ['id', 'parentId', 'title'], 'rename-folder': ['id', 'title'], move: ['id', 'parentId', 'beforeId'],
    'delete-folder': ['id'], 'save-session': ['session', 'folderId'], 'remove-session': ['session'],
  };
  if (typeof value.type !== 'string' || !Object.hasOwn(fields, value.type)) return false;
  const accepted = ['type', 'revision', ...fields[value.type]!];
  if (Object.keys(value).some(key => !accepted.includes(key))) return false;
  switch (value.type) {
    case 'create-folder': return id(value.id) && parent(value.parentId) && label(value.title, 128);
    case 'rename-folder': return id(value.id) && label(value.title, 128);
    case 'move': return id(value.id) && parent(value.parentId) && parent(value.beforeId);
    case 'delete-folder': return id(value.id);
    case 'save-session': return validSessionInput(value.session) && parent(value.folderId);
    case 'remove-session': return validStarIdentity(value.session) && Object.keys(value.session).every(key => ['hostId', 'providerId', 'nativeSessionId'].includes(key));
    default: return false;
  }
}
export function createFavorites(state: RelayState, access: Access) {
  function snapshot(draft: HostedRelayState, subject: string): FavoritesSnapshot {
    const tree = organizeFavorites(draft, subject);
    return { revision: tree.revision, folders: sorted(tree.folders), stars: sorted(savedStars(draft, subject)).map(({ subject: _, ...star }) => {
      const host = access(subject, star);
      return { ...star, available: !!host, online: host?.online ?? false, ...(host ? { hostName: host.hostName } : {}) };
    }) };
  }
  return {
    list(subject: string): FavoritesSnapshot { return snapshot(structuredClone(state.read()), subject); },
    async execute(subject: string, body: unknown): Promise<FavoritesSnapshot> {
      if (!validCommand(body)) fail(400, 'invalid_favorite', 'The favorites command is invalid.');
      const command = body as FavoriteCommand;
      return state.mutate(draft => {
        const tree = organizeFavorites(draft, subject);
        if (command.revision !== tree.revision) fail(409, 'favorites_conflict', 'Favorites changed on another device. Refresh and try again.');
        const folder = (folderId: string) => tree.folders.find(item => item.id === folderId) ?? fail(404, 'favorite_not_found', 'The folder no longer exists.');
        const destination = (parentId: string | null) => { if (parentId !== null) folder(parentId); };
        switch (command.type) {
          case 'create-folder': {
            destination(command.parentId);
            if (tree.folders.some(item => item.id === command.id) || savedStars(draft, subject).some(item => item.favoriteId === command.id)) fail(409, 'favorite_exists', 'This favorite identity already exists.');
            if (tree.folders.length >= MAX_FAVORITE_FOLDERS) fail(409, 'favorites_limit', 'Your favorites folders are full.');
            tree.folders.push({ id: command.id, title: command.title.trim(), parentId: command.parentId, order: siblings(draft, tree, command.parentId).length });
            break;
          }
          case 'rename-folder': folder(command.id).title = command.title.trim(); break;
          case 'move': {
            destination(command.parentId);
            const targetFolder = tree.folders.find(item => item.id === command.id);
            const star = savedStars(draft, subject).find(item => item.favoriteId === command.id);
            if (!targetFolder && !star) fail(404, 'favorite_not_found', 'The favorite no longer exists.');
            const entries = siblings(draft, tree, command.parentId).filter(entry => entry.id !== command.id);
            const index = command.beforeId === null ? entries.length : entries.findIndex(entry => entry.id === command.beforeId);
            if (index < 0) fail(400, 'invalid_favorite', 'The target position is not a sibling.');
            if (targetFolder) targetFolder.parentId = command.parentId; else star!.folderId = command.parentId;
            entries.splice(index, 0, { id: command.id, item: targetFolder ?? star!, order: 0 });
            entries.forEach((entry, order) => { entry.item.order = order; });
            break;
          }
          case 'delete-folder': {
            folder(command.id); const removed = new Set([command.id]);
            for (let i = 0; i < MAX_FAVORITE_DEPTH; i++) for (const item of tree.folders) if (item.parentId !== null && removed.has(item.parentId)) removed.add(item.id);
            tree.folders = tree.folders.filter(item => !removed.has(item.id));
            draft.sessionStars = (draft.sessionStars ?? []).filter(item => item.subject !== subject || item.folderId === null || !removed.has(item.folderId!));
            break;
          }
          case 'save-session': {
            destination(command.folderId);
            if (!access(subject, command.session)) fail(404, 'session_unavailable', 'This session is not available to your account.');
            const stars = draft.sessionStars ??= [];
            const previous = stars.find(item => item.subject === subject && starKey(item) === starKey(command.session));
            if (previous) {
              Object.assign(previous, command.session);
              if (previous.folderId !== command.folderId) { previous.order = siblings(draft, tree, command.folderId).length; previous.folderId = command.folderId; }
            } else {
              if (savedStars(draft, subject).length >= MAX_USER_STARS || stars.length >= 16384) fail(409, 'star_limit', 'Your favorites are full. Remove a star before adding another.');
              const favoriteId = newFavoriteIdentity(draft, subject, command.session);
              if (tree.folders.some(item => item.id === favoriteId)) fail(409, 'favorite_exists', 'This favorite identity already exists.');
              stars.push({ ...command.session, subject, starredAt: Date.now(), favoriteId, folderId: command.folderId, order: siblings(draft, tree, command.folderId).length });
            }
            break;
          }
          case 'remove-session': {
            if (!savedStars(draft, subject).some(item => starKey(item) === starKey(command.session))) fail(404, 'favorite_not_found', 'The favorite no longer exists.');
            draft.sessionStars = (draft.sessionStars ?? []).filter(item => item.subject !== subject || starKey(item) !== starKey(command.session));
            break;
          }
        }
        normalize(draft, tree);
        if (!validStructure(tree, savedStars(draft, subject))) fail(400, 'invalid_favorite', `Folders must not contain cycles or exceed ${MAX_FAVORITE_DEPTH} levels.`);
        advanceFavorites(draft, tree);
        return snapshot(draft, subject);
      });
    },
  };
}
