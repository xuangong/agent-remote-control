import { expect, it } from 'vitest';
import type { SessionRelation } from '@orchardworks/agent-remote-hosted/session-relations';
import { fixture, send } from './fixture.js';

async function setup() {
  const f = await fixture();
  const owner = await f.login('alice');
  const pairing = await (await f.json(owner.basePath + 'v1/remote/pairings', owner.cookie, {})).json() as { key: string };
  const { socket, hostId } = await f.host(pairing.key);
  const nativeRequests: string[] = [];
  socket.addEventListener('message', event => {
    const frame = JSON.parse(String(event.data));
    if (frame.type !== 'rpc_request') return;
    nativeRequests.push(frame.path);
    const body = JSON.parse(frame.body ?? '{}');
    send(socket, { type: 'rpc_response', requestId: frame.requestId, status: 200, body: JSON.stringify({ agentId: frame.sessionId,
      nativeSessionId: frame.path === '/remote/create' ? body.operationId : body.nativeSessionId }) });
  });
  type Account = typeof owner;
  async function create(account: Account, operationId: string, sourceNativeSessionId?: string, conversationKind?: 'side' | 'ask') {
    const response = await f.json(account.basePath + `v1/remote/hosts/${hostId}/create`, account.cookie,
      { providerId: 'codex', operationId, sourceNativeSessionId, conversationKind });
    expect(response.status, await response.clone().text()).toBe(200);
    return await response.json() as { nativeSessionId: string; agentId: string };
  }
  const list = async (account = owner) => {
    const response = await f.json(account.basePath + 'v1/session-relations', account.cookie);
    expect(response.status).toBe(200);
    return (await response.json() as { relations: SessionRelation[] }).relations;
  };
  const change = (account: Account, relation: SessionRelation, linked: boolean, expectedRevision: number, extra: Record<string, unknown> = {}) =>
    f.json(account.basePath + 'v1/session-relations', account.cookie, { hostId, providerId: 'codex', nativeSessionId: relation.target.nativeSessionId,
      sourceNativeSessionId: relation.source.nativeSessionId, id: relation.id, linked, expectedRevision, ...extra }, 'PATCH');
  const source = await create(owner, 'source');
  const target = await create(owner, 'side', source.nativeSessionId, 'side');
  return { f, owner, hostId, nativeRequests, create, list, change, source, target };
}

it('retains an unlink across devices and restarts without replaying creation or importing the old link', async () => {
  const { f, owner, hostId, nativeRequests, create, list, change, source, target } = await setup();
  const mobile = await f.login('alice');
  await create(owner, 'nested', target.nativeSessionId, 'side');
  const relation = (await list()).find(item => item.id === 'side')!;
  expect(relation).toMatchObject({ linked: true, revision: 0 });
  nativeRequests.length = 0;
  const replies = await Promise.all([change(owner, relation, false, 0), change(mobile, relation, false, 0)]);
  expect(replies.map(response => response.status)).toEqual([200, 200]);
  expect(await list(mobile)).toEqual(expect.arrayContaining([
    expect.objectContaining({ id: 'side', linked: false, revision: 1 }),
    expect.objectContaining({ id: 'nested', linked: true, revision: 0 }),
  ]));
  const imported = await f.json(owner.basePath + 'v1/session-relations', owner.cookie,
    { hostId, providerId: 'codex', nativeSessionId: target.nativeSessionId, sourceNativeSessionId: source.nativeSessionId,
      id: relation.id, kind: 'side', createdAt: relation.createdAt, linked: true, revision: 100 });
  expect(imported.status).toBe(200);
  expect(await create(owner, 'side', source.nativeSessionId, 'side')).toEqual(target);
  expect(await list()).toContainEqual(expect.objectContaining({ id: 'side', linked: false, revision: 1 }));
  expect(nativeRequests).toEqual([]);
  await f.restart();
  expect(await list(mobile)).toContainEqual(expect.objectContaining({ id: 'side', linked: false, revision: 1 }));
  expect((await change(mobile, relation, false, 0)).status).toBe(200);
  const restored = await change(mobile, relation, true, 1);
  expect(restored.status).toBe(200);
  expect(await restored.json()).toMatchObject({ relations: expect.arrayContaining([expect.objectContaining({ id: 'side', linked: true, revision: 2 })]) });
  expect((await change(owner, relation, true, 1)).status).toBe(200);
  const conflict = await change(owner, relation, false, 0);
  expect(conflict.status).toBe(409);
  expect(await conflict.json()).toMatchObject({ code: 'relation_conflict', error: expect.any(String),
    relations: expect.arrayContaining([expect.objectContaining({ id: 'side', linked: true, revision: 2 })]) });
  expect((await change(owner, relation, false, 1)).status).toBe(409);
  expect((await change(owner, relation, false, 2)).status).toBe(200);
  expect((await change(mobile, relation, true, 1)).status).toBe(409);
  expect(await list()).toContainEqual(expect.objectContaining({ id: 'side', linked: false, revision: 3 }));
}, 30000);

it('requires a matching side relation and a valid revision before changing navigation', async () => {
  const { f, owner, create, list, change, source } = await setup();
  await create(owner, 'ask', source.nativeSessionId, 'ask');
  const relation = (await list()).find(item => item.id === 'side')!;
  const ask = (await list()).find(item => item.id === 'ask')!;
  expect((await change(owner, ask, false, 0)).status).toBe(409);
  for (const extra of [{ id: 'different' }, { sourceNativeSessionId: relation.target.nativeSessionId }]) {
    expect((await change(owner, relation, false, 0, extra)).status).toBe(409);
  }
  for (const extra of [{ expectedRevision: -1 }, { expectedRevision: 0.5 }, { expectedRevision: Number.MAX_SAFE_INTEGER },
    { expectedRevision: '0' }, { expectedRevision: null }, { linked: 'false' }, { id: '' }, { nativeSessionId: '' }]) {
    expect((await change(owner, relation, false, 0, extra)).status).toBe(400);
  }
  const crossOrigin = await f.request(owner.basePath + 'v1/session-relations', { method: 'PATCH',
    headers: { origin: 'https://elsewhere.example', cookie: owner.cookie, 'content-type': 'application/json' }, body: '{}' });
  expect(crossOrigin.status).toBe(403);
  expect(await list()).toContainEqual(expect.objectContaining({ id: 'side', linked: true, revision: 0 }));
}, 30000);

it('authorizes both endpoints and preserves shared-host isolation and revocation', async () => {
  const { f, owner, hostId, create, list, change } = await setup();
  const bob = await f.login('bob'); const carol = await f.login('carol');
  for (const user of ['bob', 'carol']) expect((await f.control({ subject: 'alice', operation: 'share', hostId,
    targetSubject: user, targetLabel: user, sessionLimit: 5 })()).status).toBe(200);
  const ownRelation = (await list())[0]!;
  const denied = await change(bob, ownRelation, false, 0);
  expect(denied.status).toBe(403);
  expect(await denied.json()).not.toHaveProperty('relations');
  const source = await create(bob, 'bob-source');
  await create(bob, 'bob-side', source.nativeSessionId, 'side');
  const relation = (await list(bob))[0]!;
  expect((await change(carol, relation, false, 0)).status).toBe(403);
  expect((await change(bob, relation, false, 0, { sourceNativeSessionId: ownRelation.source.nativeSessionId })).status).toBe(403);
  expect((await change(bob, relation, false, 0)).status).toBe(200);
  expect(await list(bob)).toContainEqual(expect.objectContaining({ id: 'bob-side', linked: false, revision: 1 }));
  const conflict = await change(bob, relation, true, 0);
  expect(conflict.status).toBe(409);
  expect((await conflict.json() as { relations: SessionRelation[] }).relations).toEqual([
    expect.objectContaining({ id: 'bob-side', linked: false, revision: 1 }),
  ]);
  expect((await change(owner, relation, true, 1)).status).toBe(200);
  expect((await f.control({ subject: 'alice', operation: 'revoke-share', hostId, targetSubject: 'bob' })()).status).toBe(200);
  expect((await change(bob, relation, false, 2)).status).toBe(403);
  expect(await list(bob)).toEqual([]);
}, 30000);

it('does not acknowledge or retain an unlink when durable storage fails', async () => {
  const { f, owner, list, change } = await setup();
  const relation = (await list())[0]!;
  expect((await f.inspect('fail-commit')).status).toBe(200);
  expect((await change(owner, relation, false, 0)).status).toBe(503);
  expect((await f.inspect('restore-commit')).status).toBe(200);
  await f.restart();
  expect(await list()).toContainEqual(expect.objectContaining({ id: 'side', linked: true, revision: 0 }));
  expect((await change(owner, relation, false, 0)).status).toBe(200);
}, 30000);
