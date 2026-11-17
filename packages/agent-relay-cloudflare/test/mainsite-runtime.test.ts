import { expect, it } from 'vitest';
import { fixture } from './fixture.js';

it.each(['mainsite', 'gateway'] as const)('actual Worker accepts %s config and restores main-site login and Host credentials', async authProvider => {
  const f = await fixture({ actualEntry: true, authProvider });
  const owner = await f.login('owner');
  expect(await (await f.json('/auth/status', owner.cookie)).json()).toMatchObject({
    auth: { provider: 'mainsite', capabilities: { gatewayControl: true, gatewaySetup: true } },
  });
  const pairing = await f.json(owner.basePath + 'v1/remote/pairings', owner.cookie, { purpose: 'host-only' });
  expect(pairing.status).toBe(201);
  const { key } = await pairing.json() as { key: string };
  const host = await f.host(key);
  host.socket.close(); await f.restart(undefined, authProvider === 'gateway' ? 'mainsite' : 'gateway');
  expect((await f.json('/auth/status', owner.cookie)).status).toBe(200);
  const restored = await f.host(host.key);
  expect(restored.hostId).toBe(host.hostId);
  expect((await f.control({ subject: 'owner', operation: 'hosts' })()).status).toBe(200);
}, 30000);
