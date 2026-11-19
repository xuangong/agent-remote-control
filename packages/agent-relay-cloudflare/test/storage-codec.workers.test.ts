import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import { buildCompleteRelayState as codecState } from '@orchardworks/agent-relay-core/testing';
import { fixture, origin, issuer, secret } from './fixture.js';

test('authenticated Worker HTTP and WS reopen complete saved C evidence, Favorites and recovery history without native replay', async () => {
  const f = await fixture({ completeCodec: true }); const owner = await f.login('owner'); const viewer = await f.login('viewer');
  const state = codecState({ origin, issuer, secret }); const authenticated = await (await f.inspect('codec/snapshot')).json() as any;
  state.sessions = authenticated.sessions; state.loginChallenges = authenticated.loginChallenges; state.consumedProofs = authenticated.consumedProofs;
  expect((await f.inspect('codec/seed', { method: 'POST', body: JSON.stringify(state) })).status).toBe(200);
  const replay = owner.basePath + 'v1/session-successions';
  expect((await f.request(replay)).status).toBe(401);
  const before = await (await f.json(replay, owner.cookie)).json() as any;
  expect(before.successions.map((row: any) => row.to.nativeSessionId)).toEqual(['B', 'C']);
  expect((await (await f.json(replay + '/current?roleId=role', owner.cookie)).json() as any).locator.nativeSessionId).toBe('C');
  expect((await (await f.json(viewer.basePath + 'v1/session-successions', viewer.cookie)).json() as any).successions).toEqual([]);
  expect((await (await f.json(owner.basePath + 'v1/favorites', owner.cookie)).json() as any).stars[0]).toMatchObject({ nativeSessionId: 'C', favoriteId: 'favorite', folderId: 'folder' });
  const pairing = await (await f.json(owner.basePath + 'v1/remote/pairings', owner.cookie)).json() as any;
  expect(JSON.stringify(pairing)).toContain('historic-host');
  const socket = await f.upgrade(owner.basePath + 'v1/session-channel?observation=session&successions=1', { origin, cookie: owner.cookie });
  const frames: any[] = []; socket.addEventListener('message', message => frames.push(JSON.parse(String(message.data))));
  const deadline = Date.now() + 5000;
  while (frames.filter(frame => frame.type === 'session_succession_committed').length < 2) { if (Date.now() > deadline) throw new Error('Replay frame deadline'); await new Promise(resolve => setTimeout(resolve, 5)); }
  expect(JSON.stringify(frames)).toContain('"nativeSessionId":"C"'); socket.close();
  await f.restart();
  const after = await (await f.json(replay, owner.cookie)).json() as any;
  expect(JSON.stringify(after.successions.map((row: any) => row.projection))).toBe(JSON.stringify(before.successions.map((row: any) => row.projection)));
  const restored = await (await f.inspect('codec/snapshot')).json() as any;
  expect(restored.tenants[0].broker.revokedHosts).toEqual(state.tenants[0]!.broker.revokedHosts);
  expect(restored.tenants[0].broker.keys[0][1].recovery).toEqual(state.tenants[0]!.broker.keys[0]![1].recovery);
  expect(restored.tenants[0].broker.pairings).toEqual(state.tenants[0]!.broker.pairings);
  expect(createHash('sha256').update(JSON.stringify(restored.tenants[0].broker.associations.freezes)).digest('hex')).toBe(createHash('sha256').update(JSON.stringify(state.tenants[0]!.broker.associations!.freezes)).digest('hex'));
  // There is no registered native Host in this fixture; every effect would require one.
}, 30000);

