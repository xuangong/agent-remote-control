import { expect, it } from 'vitest';
import { event, fixture, origin, send } from './fixture.js';

it('actual Google Worker persists pending OAuth, sessions, pairings and Host credentials across cold starts', async () => {
  const f = await fixture({ actualEntry: true, authProvider: 'google' });
  expect((await f.request('/health')).status).toBe(200);
  expect(await (await f.request('/')).text()).toContain('agent-remote-auth');
  expect((await f.request('/assets/main.js')).status).toBe(200);
  const pending = await f.beginGoogleLogin(); await f.restart();
  const owner = await f.finishGoogleLogin(pending);
  expect(owner).toMatchObject({ user: { id: 'owner' }, auth: { provider: 'google', capabilities: { gatewayControl: false, gatewaySetup: false } } });
  expect((await f.request('/ws/remote-host', { headers: { upgrade: 'websocket' } })).status).toBe(401);
  expect((await f.json('/gateway/control', owner.cookie, {})).status).toBe(404);
  expect((await f.json(owner.basePath + 'v1/remote/pairings', owner.cookie, { purpose: 'gateway-setup' })).status).toBe(403);
  const pairing = await f.json(owner.basePath + 'v1/remote/pairings', owner.cookie, { purpose: 'host-only' });
  expect(pairing.status).toBe(201); const { key } = await pairing.json() as { key: string };
  await f.restart();
  const socket = await f.upgrade('/ws/remote-host?successionEnrollment=2', { authorization: `Bearer ${key}` });
  const issued = event(socket, 'message'); send(socket, { type: 'register', credentialRotation: true, installationId: 'google-host', name: 'Host', providers: [{ providerId: 'fixture', displayName: 'Fixture' }] });
  const credential = await issued; expect(credential.type).toBe('credential_issued');
  const registered = event(socket, 'message'); send(socket, { type: 'credential_saved' }); const registration = await registered;
  expect(registration).toMatchObject({ type: 'registered', successionEnrollmentVersion: 2, successionEnrollment: { ownerSubject: 'owner' } });
  socket.close(); await f.restart();
  expect(await (await f.json(owner.basePath + 'v1/remote/hosts', owner.cookie)).json()).toMatchObject({ hosts: [{ id: registration.hostId, online: false }] });
  const restored = await f.host(credential.credential, false, undefined, false, false, 'fixture', 'google-host');
  expect(restored.hostId).toBe(registration.hostId);
  expect((await f.request(owner.basePath + 'v1/session-channel?observation=session', { headers: { upgrade: 'websocket', origin: 'https://other.example', cookie: owner.cookie } })).status).toBe(403);
  const channel = await f.upgrade(owner.basePath + 'v1/session-channel?observation=session', { cookie: owner.cookie, origin }); channel.close();
  expect((await f.request(pending.callback, { headers: { cookie: pending.cookie } })).status).toBe(401);
  restored.socket.close();
  f.setGoogleConfig('other-client'); await f.restart(); expect((await f.request('/health')).status).toBe(503);
}, 30000);

it('Google Worker rejects removed allowlist accounts after a persisted restart', async () => {
  const f = await fixture({ actualEntry: true, authProvider: 'google' });
  const owner = await f.finishGoogleLogin(await f.beginGoogleLogin());
  f.setGoogleConfig('workers-client', 'other@example.com'); await f.restart();
  expect((await f.json('/auth/status', owner.cookie)).status).toBe(401);
  expect((await f.request(owner.basePath + 'v1/session-channel?observation=session', { headers: { upgrade: 'websocket', origin, cookie: owner.cookie } })).status).toBe(401);
}, 15000);
