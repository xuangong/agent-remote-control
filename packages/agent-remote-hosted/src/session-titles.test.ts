import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { createFavorites } from './favorites.js';
import { createSessionStars } from './session-stars.js';
import { createSessionTitles, MAX_SESSION_TITLES, pruneSessionTitles } from './session-titles.js';
import { createRelayState, emptyRelayState, validateRelayState, type HostedRelayState } from './state.js';

const auth = { origin: 'https://relay.example', issuer: 'https://gateway.example', secret: 'session-title-test-secret-0123456789' };
const identity = { hostId: 'host', providerId: 'codex', nativeSessionId: 'native' };
function initialState(): HostedRelayState {
  const initial = emptyRelayState(auth);
  initial.tenants.push({ subject: 'alice', namespace: createHash('sha256').update(JSON.stringify([auth.issuer, 'alice'])).digest('hex'),
    broker: { keys: [], hosts: [{ id: 'host', installationId: 'installation', name: 'Host', providers: [{ providerId: 'codex', displayName: 'Codex' }], legacyDsh: false }], bindings: [], creations: [] } });
  return initial;
}
function fixture(initial = initialState(), allowed = (subject: string) => subject === 'alice') {
  let saved = initial;
  const state = createRelayState(auth, { initial, async commit(value) { saved = structuredClone(value); } }, () => {}, () => {});
  const access = (subject: string) => allowed(subject) ? { online: true, hostName: 'Host', canRename: true } : undefined;
  return { state, titles: createSessionTitles(state, subject => !!access(subject)), favorites: createFavorites(state, access), stars: createSessionStars(state, access), saved: () => saved };
}

it('records a native title without adding a favorite and restores the same revision after restart', async () => {
  const f = fixture();
  await f.titles.record(identity, 'Confirmed');
  expect(f.favorites.list('alice').stars).toEqual([]);
  expect(f.state.read().favoritesTrees).toBeUndefined();
  expect(f.titles.list('alice')).toEqual([{ ...identity, title: 'Confirmed', revision: 1 }]);
  expect(f.titles.list('bob')).toEqual([]);
  const restarted = fixture(f.saved());
  expect(restarted.titles.list('alice')).toEqual(f.titles.list('alice'));
  await restarted.titles.record(identity, 'Confirmed');
  expect(restarted.state.read().sessionTitleRevision).toBe(1);
  await restarted.titles.record(identity, 'Later');
  expect(restarted.titles.list('alice')[0]).toMatchObject({ title: 'Later', revision: 2 });
});

it('advances beyond legacy favorites revisions and updates the same identity atomically', async () => {
  const initial = initialState();
  initial.favoritesTrees = [{ subject: 'alice', revision: 80, folders: [] }, { subject: 'bob', revision: 200, folders: [] }];
  initial.sessionStars = [{ ...identity, title: 'Original', starredAt: 1, subject: 'alice' },
    { ...identity, nativeSessionId: 'other', title: 'Original', starredAt: 1, subject: 'alice' },
    { ...identity, title: 'Original', starredAt: 1, subject: 'bob' }];
  const f = fixture(initial, subject => subject === 'alice' || subject === 'bob');
  await f.titles.record(identity, 'Renamed');
  expect(f.favorites.list('alice').revision).toBe(81);
  expect(f.favorites.list('alice').stars.find(star => star.nativeSessionId === 'other')?.title).toBe('Original');
  expect(f.saved().sessionStars?.filter(star => star.nativeSessionId === 'native').map(star => star.title)).toEqual(['Renamed', 'Renamed']);
  expect(f.titles.list('alice')[0]?.revision).toBe(202);
  await f.titles.record(identity, 'Renamed');
  expect(f.favorites.list('alice').revision).toBe(81);
  expect(f.titles.list('alice')[0]?.revision).toBe(202);
});

it.each(['favorites', 'legacy stars'])('persists the confirmed native name when a stale browser saves through %s', async source => {
  let allowed = true;
  const f = fixture(initialState(), subject => subject === 'alice' || subject === 'bob' && allowed);
  const save = async (title: string) => source === 'favorites'
    ? f.favorites.execute('bob', { type: 'save-session', session: { ...identity, title }, folderId: null, revision: f.favorites.list('bob').revision })
    : f.stars.save('bob', { ...identity, title });
  await f.titles.record(identity, 'Native name');
  await save('Old catalog name');
  expect(f.saved().sessionStars?.[0]?.title).toBe('Native name');
  await save('Another stale name');
  expect(f.saved().sessionStars?.[0]?.title).toBe('Native name');
  await f.state.mutate(draft => { draft.sessionTitles = []; });
  expect(f.favorites.list('bob').stars[0]?.title).toBe('Native name');
  expect(f.stars.list('bob')[0]?.title).toBe('Native name');
  allowed = false;
  await f.titles.record(identity, 'Private new name');
  expect(f.favorites.list('bob').stars[0]).toMatchObject({ title: 'Native name', available: false });
  expect(f.stars.list('bob')[0]).toMatchObject({ title: 'Native name', available: false });
});

it('preserves the last known favorite title after session access is revoked', async () => {
  let allowed = true;
  const f = fixture(initialState(), subject => subject === 'alice' || subject === 'bob' && allowed);
  await f.stars.save('bob', { ...identity, title: 'Last visible name' });
  allowed = false;
  await f.titles.record(identity, 'Private new name');
  expect(f.titles.list('bob')).toEqual([]);
  expect(f.favorites.list('bob').stars[0]).toMatchObject({ title: 'Last visible name', available: false });
  expect(f.stars.list('bob')[0]).toMatchObject({ title: 'Last visible name', available: false });
});

it('bounds retained titles and keeps the revision watermark through eviction and Host removal', async () => {
  const initial = initialState();
  initial.sessionTitles = Array.from({ length: MAX_SESSION_TITLES }, (_, index) => ({ ...identity, nativeSessionId: String(index), title: 'Name', revision: index + 1 }));
  initial.sessionTitleRevision = MAX_SESSION_TITLES;
  const f = fixture(initial);
  await f.titles.record(identity, 'Latest');
  expect(f.state.read().sessionTitles).toHaveLength(MAX_SESSION_TITLES);
  expect(f.titles.list('alice').some(session => session.nativeSessionId === '0')).toBe(false);
  await f.state.mutate(draft => { draft.tenants[0]!.broker.hosts = []; pruneSessionTitles(draft); });
  expect(f.state.read().sessionTitles).toEqual([]);
  expect(f.state.read().sessionTitleRevision).toBe(MAX_SESSION_TITLES + 1);
  expect(validateRelayState(f.saved(), auth).sessionTitleRevision).toBe(MAX_SESSION_TITLES + 1);
});

it('validates optional persisted title records while accepting older snapshots', () => {
  expect(validateRelayState(initialState(), auth).sessionTitles).toBeUndefined();
  const initial = initialState(), session = { ...identity, title: 'Known', revision: 1 };
  for (const invalid of [
    { ...initial, sessionTitleRevision: -1 },
    { ...initial, sessionTitles: [session] },
    { ...initial, sessionTitleRevision: 1, sessionTitles: [session, session] },
    { ...initial, sessionTitleRevision: 1, sessionTitles: [{ ...session, hostId: 'missing' }] },
    { ...initial, sessionTitleRevision: 1, sessionTitles: [{ ...session, unknown: true }] },
  ]) expect(() => validateRelayState(invalid, auth)).toThrow(/state/i);
});
