import { expect, it } from 'vitest';
import { createRelayState } from './state.js';
import { createSessionStars } from './session-stars.js';
import { createSessionMigrations } from './session-migrations.js';
const auth = { origin: 'https://relay.example', issuer: 'https://gateway.example', secret: 's'.repeat(32) };
const from = { hostId: 'h', providerId: 'codex', nativeSessionId: 'old', agentId: 'old-agent' };
const to = { ...from, nativeSessionId: 'new', agentId: 'new-agent' };
const migration = { id: 'operation', from, to, createdAt: 1 };
it('atomically migrates only the initiating account favorites and replays once', async () => {
  const state = createRelayState(auth, undefined, () => {}, () => {});
  const stars = createSessionStars(state, () => ({ online: true, hostName: 'Host' }));
  const { agentId: _, ...identity } = from;
  await stars.save('alice', { ...identity, title: 'Title' }); await stars.save('bob', { ...identity, title: 'Other' });
  const moves = createSessionMigrations(state, () => true);
  await moves.save('alice', migration); await moves.save('alice', migration);
  expect(stars.list('alice')[0]?.nativeSessionId).toBe('new');
  expect(stars.list('bob')[0]?.nativeSessionId).toBe('old');
  expect(moves.list('alice')).toEqual([migration]); expect(moves.list('bob')).toEqual([]);
  expect(() => moves.check('alice', from, 'another')).toThrow(/already edited/);
});
it('does not publish or leak a migration when access is missing or storage fails', async () => {
  const state = createRelayState(auth, { commit: async () => { throw new Error('disk'); } }, () => {}, () => {});
  const moves = createSessionMigrations(state, () => true);
  await expect(moves.save('alice', migration)).rejects.toThrow('disk'); expect(moves.list('alice')).toEqual([]);
  const other = createSessionMigrations(createRelayState(auth, undefined, () => {}, () => {}), () => false);
  await expect(other.save('alice', migration)).rejects.toThrow(/access/);
});
