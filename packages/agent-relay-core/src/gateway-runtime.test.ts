import { expect, it } from 'vitest';
import { event, send } from './test-utils/relay-harness.js';
import { world } from './test-utils/relay-world.js';

it('expires HTTP and socket access during an authority outage even without a refresh, then renews after recovery', async () => {
  const w = await world({ authorityOutageGraceMs: 0 }); w.authority.answer(200, 400);
  const alice = await w.signIn('alice');
  const pairing = await (await w.json(alice.basePath + 'v1/remote/pairings', alice.cookie, {})).json() as any;
  const { socket, key } = await w.host(pairing.key);
  const closed = event(socket, 'close'); w.authority.answer(503);
  await w.advance(500);
  expect([1008, 1013]).toContain((await closed).code);
  expect((await w.json('/auth/status', alice.cookie)).status).toBe(503);
  const before = w.authority.calls;
  await w.advance(30_000);
  expect(w.authority.calls).toBeGreaterThan(before);
  w.authority.answer(200); await w.refreshNow();
  expect((await w.json('/auth/status', alice.cookie)).status).toBe(200);
  expect((await w.host(key)).hostId).toBeTruthy();
});

it('closes a registration whose asynchronous durable commit fails, without telling the Controller it registered', async () => {
  const w = await world(); const alice = await w.signIn('alice');
  const pairing = await (await w.json(alice.basePath + 'v1/remote/pairings', alice.cookie, {})).json() as any;
  const registering = await w.upgrade('/ws/remote-host', { authorization: `Bearer ${pairing.key}` });
  const frames: unknown[] = []; registering.addEventListener('message', message => frames.push(message.data));
  await w.inspect('fail-commit?kind=host');
  const rejected = event(registering, 'close');
  send(registering, { type: 'register', credentialRotation: true, installationId: 'rejected-host', name: 'Rejected Host', providers: [{ providerId: 'codex', displayName: 'Codex' }] });
  expect([1001, 1011]).toContain((await rejected).code); expect(frames).toEqual([]);
});
