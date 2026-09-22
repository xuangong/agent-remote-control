import { expect, it, vi } from 'vitest';
import { createRelayState, emptyRelayState, validateRelayState, type HostedRelayState } from './state.js';
import { createSessionStars } from './session-stars.js';
import { createFavorites, MAX_FAVORITE_DEPTH, type FavoriteCommand } from './favorites.js';
const auth = { origin: 'https://relay.example', issuer: 'https://gateway.example', secret: 's'.repeat(32) };
const session = { hostId: 'host', providerId: 'codex', nativeSessionId: 'native', title: 'Session' };
const access = () => ({ online: true, hostName: 'Mac' });
function fixture(initial?: HostedRelayState) {
  let saved: HostedRelayState | undefined;
  const state = createRelayState(auth, { initial, commit: async value => { saved = structuredClone(value); } }, () => {}, () => {});
  const favorites = createFavorites(state, access);
  const command = (body: Omit<FavoriteCommand, 'revision'> | Record<string, unknown>, subject = 'alice') => favorites.execute(subject, { ...body, revision: favorites.list(subject).revision });
  return { state, favorites, command, stars: createSessionStars(state, access), saved: () => saved };
}
it('projects deterministic legacy identities and persists root order on first mutation', async () => {
  const initial = emptyRelayState(auth);
  initial.sessionStars = [1, 3, 2].map(i => ({ ...session, nativeSessionId: String(i), starredAt: i, subject: 'alice' }));
  const f = fixture(initial); const before = f.favorites.list('alice');
  expect(before.stars.map(star => star.nativeSessionId)).toEqual(['3', '2', '1']);
  expect(before.stars.map(star => star.order)).toEqual([0, 1, 2]);
  expect(before.stars.every(star => star.favoriteId && star.folderId === null)).toBe(true);
  expect(f.state.read().sessionStars![0]!.favoriteId).toBeUndefined();
  await f.command({ type: 'create-folder', id: 'folder', parentId: null, title: 'Folder' });
  expect(f.favorites.list('alice').stars).toEqual(before.stars);
  expect(fixture(f.saved()).favorites.list('alice')).toEqual(f.favorites.list('alice'));
});
it('creates, renames, and reorders mixed siblings while preserving legacy API organization', async () => {
  const f = fixture();
  await f.command({ type: 'create-folder', id: 'folder', parentId: null, title: 'Folder' });
  await f.command({ type: 'save-session', session, folderId: null });
  const id = f.favorites.list('alice').stars[0]!.favoriteId;
  await f.command({ type: 'move', id, parentId: null, beforeId: 'folder' });
  expect(f.favorites.list('alice').stars[0]!.order).toBe(0);
  expect(f.favorites.list('alice').folders[0]!.order).toBe(1);
  await f.command({ type: 'move', id, parentId: 'folder', beforeId: null });
  await f.command({ type: 'rename-folder', id: 'folder', title: 'Renamed' });
  const revision = f.favorites.list('alice').revision;
  await f.stars.save('alice', { ...session, title: 'Updated' });
  expect(f.favorites.list('alice')).toMatchObject({ revision: revision + 1, folders: [{ title: 'Renamed' }], stars: [{ favoriteId: id, folderId: 'folder', order: 0, title: 'Updated' }] });
  await f.command({ type: 'create-folder', id: 'nested', parentId: 'folder', title: 'Nested' });
  await f.command({ type: 'save-session', session: { ...session, nativeSessionId: 'second' }, folderId: 'nested' });
  await f.command({ type: 'delete-folder', id: 'folder' });
  expect(f.favorites.list('alice')).toMatchObject({ folders: [], stars: [] });
});
it('rejects stale, foreign, cyclic, malformed and excessive-depth edits atomically', async () => {
  const f = fixture();
  await f.command({ type: 'create-folder', id: 'folder', parentId: null, title: 'Folder' });
  await expect(f.favorites.execute('alice', { type: 'delete-folder', id: 'folder', revision: 0 })).rejects.toMatchObject({ status: 409, code: 'favorites_conflict' });
  await expect(f.command({ type: 'move', id: 'folder', parentId: 'folder', beforeId: null })).rejects.toMatchObject({ status: 400 });
  await expect(f.command({ type: 'rename-folder', id: 'folder', title: 'Stolen' }, 'bob')).rejects.toMatchObject({ status: 404 });
  await expect(f.command({ type: 'save-session', session: { ...session, subject: 'bob' }, folderId: null })).rejects.toMatchObject({ status: 400 });
  await expect(f.command({ type: 'create-folder', id: 'other', parentId: null, title: ' ' })).rejects.toMatchObject({ status: 400 });
  let parentId = 'folder';
  for (let i = 1; i < MAX_FAVORITE_DEPTH; i++) { const id = `level-${i}`; await f.command({ type: 'create-folder', id, parentId, title: id }); parentId = id; }
  const before = f.favorites.list('alice');
  await expect(f.command({ type: 'create-folder', id: 'deep', parentId, title: 'Deep' })).rejects.toMatchObject({ status: 400 });
  expect(f.favorites.list('alice')).toEqual(before);
  expect(f.favorites.list('bob')).toEqual({ revision: 0, folders: [], stars: [] });
});
it('serializes concurrent revisions and does not publish a failed durable commit', async () => {
  const f = fixture();
  const outcomes = await Promise.allSettled(['a', 'b'].map(id => f.favorites.execute('alice', { type: 'create-folder', id, title: id, parentId: null, revision: 0 })));
  expect(outcomes.map(item => item.status).sort()).toEqual(['fulfilled', 'rejected']);
  const published = vi.fn();
  const state = createRelayState(auth, { commit: async () => { throw new Error('Disk unavailable'); } }, () => {}, published);
  const favorites = createFavorites(state, access);
  await expect(favorites.execute('alice', { type: 'create-folder', id: 'a', title: 'A', parentId: null, revision: 0 })).rejects.toThrow('Disk unavailable');
  expect(favorites.list('alice')).toEqual({ revision: 0, folders: [], stars: [] }); expect(published).not.toHaveBeenCalled();
});
it('validates persisted parent references, sibling order, identities and cycles', async () => {
  const f = fixture();
  await f.command({ type: 'create-folder', id: 'folder', parentId: null, title: 'Folder' });
  await f.command({ type: 'save-session', session, folderId: 'folder' });
  const saved = f.saved()!;
  expect(() => validateRelayState(saved, auth)).not.toThrow();
  for (const change of [
    (value: HostedRelayState) => { value.favoritesTrees![0]!.folders[0]!.parentId = 'folder'; },
    (value: HostedRelayState) => { value.sessionStars![0]!.folderId = 'missing'; },
    (value: HostedRelayState) => { value.sessionStars![0]!.favoriteId = 'folder'; },
    (value: HostedRelayState) => { value.sessionStars![0]!.order = -1; },
    (value: HostedRelayState) => { value.favoritesTrees![0]!.revision = -1; },
  ]) { const invalid = structuredClone(saved); change(invalid); expect(() => validateRelayState(invalid, auth)).toThrow('Invalid'); }
});
it('rejects descendant cycles, nonexistent drop positions and folder capacity without changing the snapshot', async () => {
  const f = fixture();
  await f.command({ type: 'create-folder', id: 'parent', parentId: null, title: 'Parent' });
  await f.command({ type: 'create-folder', id: 'child', parentId: 'parent', title: 'Child' });
  await f.command({ type: 'save-session', session, folderId: null });
  const snapshot = f.favorites.list('alice');
  await expect(f.command({ type: 'move', id: 'parent', parentId: 'child', beforeId: null })).rejects.toMatchObject({ status: 400 });
  await expect(f.command({ type: 'move', id: snapshot.stars[0]!.favoriteId, parentId: null, beforeId: 'child' })).rejects.toMatchObject({ status: 400 });
  await expect(f.command({ type: 'save-session', session: { ...session, nativeSessionId: 'new' }, folderId: 'foreign' })).rejects.toMatchObject({ status: 404 });
  await expect(f.command({ type: 'remove-session', session: { hostId: 'foreign', providerId: 'codex', nativeSessionId: 'missing' } })).rejects.toMatchObject({ status: 404 });
  expect(f.favorites.list('alice')).toEqual(snapshot);
  const { MAX_FAVORITE_FOLDERS } = await import('./favorites.js');
  const initial = emptyRelayState(auth);
  initial.favoritesTrees = [{ subject: 'alice', revision: 0, folders: Array.from({ length: MAX_FAVORITE_FOLDERS }, (_, order) => ({ id: `folder-${order}`, parentId: null, title: 'Folder', order })) }];
  await expect(fixture(initial).command({ type: 'create-folder', id: 'overflow', parentId: null, title: 'Overflow' })).rejects.toMatchObject({ status: 409 });
});
