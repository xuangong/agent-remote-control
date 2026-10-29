import { expect, it } from 'vitest';
import type { CallForSupportProfileInput, NativeSessionRef } from '@orchardworks/agent-remote-protocol';
import { CallForSupportProfileError, effectiveProfiles, emptyCallForSupportState, executeProfileCommand, isCallForSupportProfileCommand, projectEnablement,
  setEnablement, validCallForSupportState, type CallForSupportResolver } from './call-for-support-profiles.js';

const reviewProfile: CallForSupportProfileInput = { name: 'Cross review', description: 'Independent reviewers.', coordinator: {}, enableByDefault: false,
  mandate: { supporters: [{ providerId: 'claude', model: 'opus' }], maxSupporters: 2, workspaces: ['shared'], remoteHosts: [], approval: 'every_roster' } };
// Session A was handed off to B on another provider.
const moves = new Map([['codex:A', { providerId: 'claude', nativeSessionId: 'B' }]]);
const resolve: CallForSupportResolver = (hostId, providerId, nativeSessionId): NativeSessionRef => {
  if (nativeSessionId === 'gone') throw new Error('unavailable');
  const moved = moves.get(`${providerId}:${nativeSessionId}`);
  return { controllerId: hostId, ...(moved ?? { providerId, nativeSessionId }) };
};
const worker = (nativeSessionId: string, providerId = 'codex') => ({ hostId: 'mac', providerId, nativeSessionId });
const code = (run: () => unknown) => { try { run(); } catch (error) { return error instanceof CallForSupportProfileError ? error.code : 'other'; } return 'none'; };

it('creates, updates and deletes profiles with revision checks and a capacity', () => {
  const state = emptyCallForSupportState();
  const created = executeProfileCommand(state, { type: 'create', profile: reviewProfile }, 10)!;
  expect(created).toMatchObject({ ...reviewProfile, revision: 1, updatedAt: 10 });
  expect(code(() => executeProfileCommand(state, { type: 'update', id: created.id, revision: 2, profile: reviewProfile }, 11))).toBe('conflict');
  const updated = executeProfileCommand(state, { type: 'update', id: created.id, revision: 1, profile: { ...reviewProfile, name: 'Review' } }, 12)!;
  expect(updated).toMatchObject({ id: created.id, name: 'Review', revision: 2, updatedAt: 12 });
  expect(code(() => executeProfileCommand(state, { type: 'delete', id: 'missing', revision: 1 }, 13))).toBe('not_found');
  setEnablement(state, resolve, worker('S'), [created.id], 14);
  executeProfileCommand(state, { type: 'delete', id: created.id, revision: 2 }, 15);
  expect(state.profiles).toEqual([]);
  expect(state.enablement[0]!.profileIds).toEqual([]);
  for (let index = 0; index < 32; index++) executeProfileCommand(state, { type: 'create', profile: reviewProfile }, 20);
  expect(code(() => executeProfileCommand(state, { type: 'create', profile: reviewProfile }, 21))).toBe('capacity');
  expect(validCallForSupportState(state)).toBe(true);
});

it('validates commands and saved state', () => {
  expect(isCallForSupportProfileCommand({ type: 'create', profile: reviewProfile })).toBe(true);
  expect(isCallForSupportProfileCommand({ type: 'update', id: 'p', revision: 1, profile: reviewProfile })).toBe(true);
  expect(isCallForSupportProfileCommand({ type: 'delete', id: 'p', revision: 1 })).toBe(true);
  for (const invalid of [{ type: 'create', profile: { ...reviewProfile, id: 'forged' } }, { type: 'delete', id: 'p', revision: 0 }, { type: 'delete', id: 'p' },
    { type: 'update', id: 'p', revision: 1, profile: reviewProfile, extra: 1 }, { type: 'rename' }]) expect(isCallForSupportProfileCommand(invalid)).toBe(false);
  const state = emptyCallForSupportState();
  const profile = executeProfileCommand(state, { type: 'create', profile: reviewProfile }, 1)!;
  expect(validCallForSupportState({ ...state, enablement: [{ ...worker('S'), profileIds: ['unknown'], updatedAt: 1 }] })).toBe(false);
  expect(validCallForSupportState({ ...state, profiles: [profile, profile] })).toBe(false);
  expect(validCallForSupportState({ ...state, extra: [] })).toBe(false);
});

it('enables profiles per session, follows the session through a handoff and falls back to default profiles', () => {
  const state = emptyCallForSupportState();
  const review = executeProfileCommand(state, { type: 'create', profile: reviewProfile }, 1)!;
  const tests = executeProfileCommand(state, { type: 'create', profile: { ...reviewProfile, name: 'Linux tests', enableByDefault: true } }, 1)!;
  expect(effectiveProfiles(state, resolve, worker('S')).map(profile => profile.id)).toEqual([tests.id]);
  setEnablement(state, resolve, worker('A'), [review.id], 2);
  // A was handed off to B; the entry follows the role and is replaced when the user changes it on B.
  expect(effectiveProfiles(state, resolve, worker('B', 'claude')).map(profile => profile.id)).toEqual([review.id]);
  expect(projectEnablement(state, resolve)).toEqual([{ hostId: 'mac', providerId: 'claude', nativeSessionId: 'B', profileIds: [review.id], updatedAt: 2 }]);
  setEnablement(state, resolve, worker('B', 'claude'), [], 3);
  expect(state.enablement).toHaveLength(1);
  expect(effectiveProfiles(state, resolve, worker('B', 'claude'))).toEqual([]);
  expect(effectiveProfiles(state, resolve, { ...worker('B', 'claude'), hostId: 'linux' }).map(profile => profile.id)).toEqual([tests.id]);
  expect(code(() => setEnablement(state, resolve, worker('S'), ['missing'], 4))).toBe('not_found');
  expect(code(() => setEnablement(state, resolve, worker('S'), [review.id, review.id], 4))).toBe('invalid');
  expect(code(() => setEnablement(state, resolve, worker('gone'), [review.id], 4))).toBe('not_found');
});
