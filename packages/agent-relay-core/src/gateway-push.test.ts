import { beforeAll, expect, it } from 'vitest';
import { createWindowView, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { fixture, origin, send } from './test-utils/relay-harness.js';
import { generateVapidKeys, type VapidKeys } from './push/web-push.js';

// The Relay's push routes and reminders through its HTTP edge, its session channel and a Controller's state reports, with the push
// service as a recording port. What a push service checks and delivers is seam S8's; what the Relay decides is decidePush's table.
const KEYS = { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' };
const subscription = (device: string) => ({ endpoint: `https://fcm.googleapis.com/fcm/send/${device}`, keys: KEYS, locale: 'en' });
let vapid: VapidKeys;
beforeAll(async () => { vapid = await generateVapidKeys(); });

async function pushRelay() {
  const pushed: Request[] = [];
  const f = await fixture({ configure: { push: { vapid: { ...vapid, subject: origin }, post: async request => { pushed.push(request); return new Response(null, { status: 201 }); } } } });
  const call = (account: { basePath: string; cookie: string }, method: string, body?: object) => f.request(account.basePath + 'v1/push-subscriptions',
    { method, headers: { origin, cookie: account.cookie, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : method === 'DELETE' ? { body: '{}' } : {}) });
  return { f, pushed, call };
}

it('says it sends no pushes and keeps no subscription without a key pair', async () => {
  const f = await fixture(); const alice = await f.login('alice');
  expect(await (await f.json(alice.basePath + 'v1/push-subscriptions', alice.cookie)).json()).toEqual({});
  const refused = await f.json(alice.basePath + 'v1/push-subscriptions', alice.cookie, subscription('phone'));
  expect([refused.status, (await refused.json() as { code: string }).code]).toEqual([503, 'push_unavailable']);
});

it('keeps one subscription per device and account, and tells each device its own', async () => {
  const { f, call } = await pushRelay();
  const phone = await f.login('alice'), desk = await f.login('alice'), bob = await f.login('bob');
  expect(await (await call(phone, 'GET')).json()).toEqual({ publicKey: vapid.publicKey });
  expect(await (await call(phone, 'POST', subscription('phone'))).json()).toEqual({ publicKey: vapid.publicKey, device: { endpoint: subscription('phone').endpoint, locale: 'en' } });
  await call(desk, 'POST', { ...subscription('desk'), locale: 'zh', paused: true });
  expect(await (await call(desk, 'GET')).json()).toEqual({ publicKey: vapid.publicKey, device: { endpoint: subscription('desk').endpoint, locale: 'zh', paused: true } });
  expect(await (await call(bob, 'GET')).json()).toEqual({ publicKey: vapid.publicKey });
  expect((await call(phone, 'POST', { ...subscription('x'), endpoint: 'https://127.0.0.1/inside' })).status).toBe(400);
  expect(await (await call(phone, 'DELETE')).json()).toEqual({ publicKey: vapid.publicKey });
  expect(await (await call(desk, 'GET')).json()).toMatchObject({ device: { locale: 'zh' } });
});

it('forgets a device\'s subscription when it signs out, when its browser is revoked, and every one when all are', async () => {
  const { f, call } = await pushRelay();
  const phone = await f.login('alice'), desk = await f.login('alice');
  await call(phone, 'POST', subscription('phone'));
  await call(desk, 'POST', subscription('desk'));
  await f.request('/auth/logout', { method: 'POST', headers: { origin, cookie: phone.cookie, 'content-type': 'application/json' }, body: '{}' });
  const again = await f.login('alice');
  expect(await (await call(desk, 'GET')).json()).toMatchObject({ device: { endpoint: subscription('desk').endpoint } });
  // The desk's browser is revoked from another device; then everything is.
  const sessions = await (await f.json('/auth/sessions', again.cookie)).json() as { sessions: Array<{ id: string; current: boolean }> };
  const deskSession = sessions.sessions.find(session => !session.current)!;
  await f.json('/auth/sessions/revoke', again.cookie, { id: deskSession.id });
  await call(again, 'POST', subscription('again'));
  expect(await (await call(again, 'GET')).json()).toMatchObject({ device: { endpoint: subscription('again').endpoint } });
  await f.json('/auth/sessions/revoke-all', again.cookie, {});
  const last = await f.login('alice');
  expect(await (await call(last, 'GET')).json()).toEqual({ publicKey: vapid.publicKey });
});

it('pushes a needs-you reminder named for the assistant when a Controller reports it waiting, and none while it is muted', async () => {
  const { f, pushed, call } = await pushRelay(); const alice = await f.login('alice');
  const pairing = await (await f.json(alice.basePath + 'v1/remote/pairings', alice.cookie, {})).json() as { key: string };
  const host = await f.upgrade('/ws/remote-host?sessionStates=1', { authorization: `Bearer ${pairing.key}` });
  const frames: any[] = [];
  host.addEventListener('message', event => {
    const frame = JSON.parse(String(event.data)); frames.push(frame);
    if (frame.type === 'heartbeat') send(host, { type: 'heartbeat_ack', nonce: frame.nonce });
    if (frame.type === 'credential_issued') send(host, { type: 'credential_saved' });
  });
  send(host, { type: 'register', credentialRotation: true, installationId: 'push-host', name: 'Push Host', providers: [{ providerId: 'codex', displayName: 'Codex' }] });
  await f.poll(() => frames.find(frame => frame.type === 'registered')).toBeTruthy();
  const hostId = frames.find(frame => frame.type === 'registered').hostId as string;
  const binding = { hostId, providerId: 'codex', nativeSessionId: 'thread', title: 'Deploy the site' };
  const window: WorkspaceWindow = { schemaVersion: 3, id: 'team', title: 'Team', revision: 0, selectedPrimaryViewId: 'chief', selectedViewId: 'chief', views: [createWindowView('chief', binding, 'primary')] };
  const created = await f.json(alice.basePath + 'v1/windows', alice.cookie, { operationId: 'create-team', issuedAt: Date.now(), window, bots: { rank: 'm', members: { chief: { name: 'Chief' } } } });
  expect(created.status, await created.clone().text()).toBe(200);
  await call(alice, 'POST', subscription('phone'));
  const report = (state: string, updatedAt: number) => send(host, { type: 'session_states', full: false, states: [{ providerId: 'codex', nativeSessionId: 'thread', state, updatedAt }] });
  report('running', 1);
  report('waiting', 2);
  await f.poll(() => pushed.length).toBe(1);
  expect(pushed[0]!.url).toBe(subscription('phone').endpoint);
  expect(pushed[0]!.headers.get('urgency')).toBe('high');
  // The muted chat sends nothing; nor does the same state reported again.
  report('waiting', 2);
  const mute = await f.json(alice.basePath + 'v1/windows/team/operations', alice.cookie, { operationId: 'mute', issuedAt: Date.now(), baseRevision: (await created.json() as { window: { revision: number } }).window.revision,
    operation: { type: 'bot.update', viewId: 'chief', details: { name: 'Chief', muted: true } } });
  expect(mute.status, await mute.clone().text()).toBe(200);
  report('running', 3);
  report('waiting', 4);
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(pushed).toHaveLength(1);
});
