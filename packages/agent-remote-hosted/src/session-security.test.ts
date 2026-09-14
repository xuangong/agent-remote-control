import { afterEach, expect, it, vi } from 'vitest';
import { createGatewaySessions } from './sessions.js';
import { createRelayState } from './state.js';
import { createSecurityPolicy } from './security.js';
const auth = { origin: 'https://agents.example', issuer: 'https://gateway.example', secret: 'security-test-secret-at-least-32-bytes' };
afterEach(() => vi.unstubAllGlobals());
function fixture() {
  const state = createRelayState(auth, { commit: async () => {} }, () => {}, () => {});
  vi.stubGlobal('fetch', async () => Response.json({ active: true, subject: 'alice', expiresAt: Date.now() + 3600000, validUntil: Date.now() + 120000, authenticatedAt: Date.now() - 5000 }));
  return { state, sessions: createGatewaySessions(auth, state, true) };
}
it('lists only the owner browser sessions using non-secret IDs and revokes live authorization immediately', async () => {
  const { state, sessions } = fixture();
  const grant = {subject: 'alice', namespace: 'alice-ns', expiresAt: Date.now()+10000,ticket:'sensitive-ticket',nonce:'n',continuation:'arc2_test',sessionExpiresAt:Date.now()+3600000};
  const opened = await sessions.exchange(grant, new Request(auth.origin, {headers:{'user-agent':'SensitiveDevice/1.0'}}));
  if (opened.status !== 'active') throw Error('exchange failed');
  const request = new Request(auth.origin, {headers:{cookie:`__Host-arc_session=${opened.token}`}});
  const listed = sessions.list('alice', request);
  expect(listed).toHaveLength(1); expect(listed[0]).toMatchObject({current:true});
  expect(JSON.stringify(listed)).not.toContain(opened.token); expect(JSON.stringify(listed)).not.toContain('sensitive-ticket');
  expect(sessions.list('bob',request)).toEqual([]);
  expect(await sessions.revoke('bob',listed[0]!.id,request)).toEqual({found:false,current:false});
  expect(sessions.expiresAt(request,opened.grant)).toBeGreaterThan(Date.now());
  expect(await sessions.revoke('alice',listed[0]!.id,request)).toEqual({found:true,current:true});
  expect(sessions.expiresAt(request,opened.grant)).toBe(0); expect(state.read().sessions).toEqual([]);
});
it('does not rejuvenate authentication time on a renewal or from launch claims', async () => {
  const { sessions } = fixture(); const authenticatedAt = Date.now()-900000;
  vi.stubGlobal('fetch', async () => Response.json({active:true,subject:'alice',expiresAt:Date.now()+3600000,validUntil:Date.now()+120000,authenticatedAt}));
  const result = await sessions.exchange({subject:'alice',namespace:'a',expiresAt:Date.now()+10000,ticket:'x',nonce:'n',continuation:'arc2_x',sessionExpiresAt:Date.now()+3600000,authenticatedAt:Date.now()});
  expect(result.status).toBe('active'); if(result.status!=='active')return;
  expect(result.grant.authenticatedAt).toBe(authenticatedAt);
});
it('bounds rate keys and audit retention, partitions user audit, and requires recent authentication', async () => {
  const { state }=fixture(); const policy=createSecurityPolicy(state);
  expect(policy.recent(undefined)).toBe(false); expect(policy.recent(Date.now()+60000)).toBe(false); expect(policy.recent(Date.now()-1000)).toBe(true);
  for(let n=0;n<5;n++)expect(policy.allow('pair:alice',5,60000)).toBe(true);
  expect(policy.allow('pair:alice',5,60000)).toBe(false); expect(policy.allow('pair:bob',5,60000)).toBe(true);
  await policy.record('alice','pairing_created','allowed','host-a'); await policy.record('bob','session_revoked','allowed');
  expect(policy.events('alice')).toHaveLength(1); expect(policy.events('alice')[0]).not.toHaveProperty('subject');
  expect(JSON.stringify(policy.events('alice'))).not.toContain('bob');
});
