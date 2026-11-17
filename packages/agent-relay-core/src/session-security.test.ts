import { browserActivity } from './browser-devices.js';
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
it('takes the display profile from the trusted renewal response and refreshes it', async () => {
  const { sessions } = fixture();
  vi.stubGlobal('fetch', async () => Response.json({ active: true, subject: 'alice', profile: { name: 'Alice', email: 'alice@example.com', secret: 'not-public' }, expiresAt: Date.now()+3600000, validUntil: Date.now()+120000 }));
  const result = await sessions.exchange({ subject:'alice', namespace:'a', expiresAt:Date.now()+10000, ticket:'x', nonce:'n', continuation:'arc2_x', sessionExpiresAt:Date.now()+3600000 });
  expect(result.status).toBe('active'); if(result.status!=='active')return;
  expect(result.grant).toMatchObject({ profile: { name: 'Alice', email: 'alice@example.com' } });
  expect(JSON.stringify(result.grant)).not.toContain('not-public');
});

it('groups repeat logins by a verified browser cookie, never by the browser label, and revokes the whole group', async () => {
  const { sessions } = fixture();
  const grant = { subject: 'alice', namespace: 'a', expiresAt: Date.now()+10000, ticket: 'x', nonce: 'n', continuation: 'arc2_x', sessionExpiresAt: Date.now()+3600000 };
  const first = await sessions.exchange(grant, new Request(auth.origin));
  if (first.status !== 'active') throw Error('exchange failed');
  expect(first.browserCookie).toBeTruthy();
  const browser = `__Host-arc_browser=${first.browserCookie}`;
  const second = await sessions.exchange(grant, new Request(auth.origin, { headers: { cookie: browser } }));
  if (second.status !== 'active') throw Error('exchange failed');
  await sessions.exchange(grant, new Request(auth.origin));
  const request = new Request(auth.origin, { headers: { cookie: `__Host-arc_session=${second.token}; ${browser}` } });
  const listed = sessions.list('alice', request);
  expect(listed).toHaveLength(2);
  const group = listed.find(row => row.current)!;
  expect(group.sessionCount).toBe(2);
  expect(group.activity).toHaveLength(1);
  expect(JSON.stringify(listed)).not.toContain(first.browserCookie);
  expect(await sessions.revoke('bob', group.id, request)).toEqual({ found: false, current: false });
  expect(await sessions.revoke('alice', group.id, request)).toEqual({ found: true, current: true });
  for (const token of [first.token, second.token]) expect(await sessions.authenticate(new Request(auth.origin, { headers: { cookie: `__Host-arc_session=${token}` } }))).toEqual({});
  expect(sessions.list('alice', request)).toHaveLength(1);
});
it('limits displayed activity to seven days without expiring older authorization, and rejects forged grouping cookies', async () => {
  const { sessions, state } = fixture();
  const grant = { subject: 'alice', namespace: 'a', expiresAt: Date.now()+10000, ticket: 'x', nonce: 'n', continuation: 'arc2_x', sessionExpiresAt: Date.now()+3600000 };
  const first = await sessions.exchange(grant);
  if (first.status !== 'active') throw Error('exchange failed');
  await sessions.exchange(grant, new Request(auth.origin, { headers: { cookie: `__Host-arc_browser=${first.browserCookie?.slice(0, -5)}wrong` } }));
  expect(sessions.list('alice', new Request(auth.origin))).toHaveLength(2);
  await state.mutate(draft => { draft.sessions[0]!.lastSeenAt = Date.now() - 8*86400000; draft.sessions[0]!.createdAt = Date.now() - 8*86400000; });
  expect(sessions.list('alice', new Request(auth.origin))).toHaveLength(1);
  expect(state.read().sessions).toHaveLength(2);
});

it('upgrades a legacy current login without merging unrelated legacy records', async () => {
  const { sessions, state } = fixture();
  const grant = { subject: 'alice', namespace: 'a', expiresAt: Date.now()+10000, ticket: 'x', nonce: 'n', continuation: 'arc2_x', sessionExpiresAt: Date.now()+3600000 };
  const first = await sessions.exchange(grant); await sessions.exchange(grant);
  if (first.status !== 'active') throw Error('exchange failed');
  await state.mutate(draft => { for (const record of draft.sessions) delete record.browserId; });
  const request = new Request(auth.origin, { headers: { cookie: `__Host-arc_session=${first.token}` } });
  const cookie = await sessions.browserCookie(request);
  expect(cookie).toBeTruthy();
  expect(await sessions.browserCookie(request)).toBe(cookie);
  await sessions.exchange(grant, new Request(auth.origin, { headers: { cookie: `__Host-arc_browser=${cookie}` } }));
  const rows = sessions.list('alice', request);
  expect(rows).toHaveLength(2);
  expect(rows.find(row => row.current)).toMatchObject({ sessionCount: 2, identified: true });
  expect(rows.find(row => !row.current)).toMatchObject({ identified: false });
});

it('keeps only the latest daily activity within a rolling seven-day window', () => {
  const now = Date.UTC(2026, 8, 23, 12);
  const day = 86400000;
  expect(browserActivity([now, now - 1000, now - day, now - 7*day, now - 8*day, now + 1], now)).toEqual([now, now-day]);
  expect(browserActivity(Array.from({ length: 200 }, (_, n) => now - n*3600000), now)).toHaveLength(8);
});
