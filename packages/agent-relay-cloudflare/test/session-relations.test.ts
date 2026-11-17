import { expect, it } from 'vitest';
import { fixture, send } from './fixture.js';

it('discovers Side and Ask on another device, retains relations after restart and isolates accounts', async () => {
  const f = await fixture();
  const desktop = await f.login('alice'); const mobile = await f.login('alice'); const stranger = await f.login('bob');
  const pairing = await (await f.json(desktop.basePath + 'v1/remote/pairings', desktop.cookie, {})).json() as { key: string };
  const { socket, hostId } = await f.host(pairing.key);
  let creations = 0;
  socket.addEventListener('message', event => {
    const frame = JSON.parse(String(event.data)); if (frame.type !== 'rpc_request') return;
    const body = JSON.parse(frame.body ?? '{}');
    expect(body.conversationKind).toBeUndefined();
    if (frame.path === '/remote/create') creations++;
    send(socket, { type: 'rpc_response', requestId: frame.requestId, status: 200, body: JSON.stringify({ agentId: frame.sessionId,
      nativeSessionId: frame.path === '/remote/create' ? body.operationId : body.nativeSessionId }) });
  });
  const path = desktop.basePath + `v1/remote/hosts/${hostId}/`;
  expect((await f.json(path + 'attach', desktop.cookie, { providerId: 'codex', nativeSessionId: 'main' })).status).toBe(200);
  for (const kind of ['side', 'ask']) {
    const input = { providerId: 'codex', operationId: kind, sourceNativeSessionId: 'main', conversationKind: kind };
    expect((await f.json(path + 'create', desktop.cookie, input)).status).toBe(200);
    expect((await f.json(path + 'create', mobile.cookie, input)).status).toBe(200);
    expect((await f.json(path + 'create', mobile.cookie, { ...input, conversationKind: kind === 'side' ? 'ask' : 'side' })).status).toBe(409);
  }
  const read = async () => (await f.json(mobile.basePath + 'v1/session-relations', mobile.cookie)).json();
  expect(await read()).toMatchObject({ relations: [
    { kind: 'side', id: 'side', source: { nativeSessionId: 'main' }, target: { nativeSessionId: 'side' } },
    { kind: 'ask', id: 'ask', source: { nativeSessionId: 'main' }, target: { nativeSessionId: 'ask' } },
  ] });
  expect(await (await f.json(stranger.basePath + 'v1/session-relations', stranger.cookie)).json()).toEqual({ relations: [] });
  // An older browser can identify its records, but only a verified native creation can be imported.
  expect((await f.json(path + 'create', desktop.cookie, { providerId: 'codex', operationId: 'legacy', sourceNativeSessionId: 'main' })).status).toBe(200);
  const legacy = { hostId, providerId: 'codex', nativeSessionId: 'legacy', sourceNativeSessionId: 'main', id: 'legacy', kind: 'ask', createdAt: '2026-09-01T00:00:00.000Z' };
  const endpoint = desktop.basePath + 'v1/session-relations';
  expect((await f.json(endpoint, desktop.cookie, { ...legacy, sourceNativeSessionId: 'invented' })).status).toBe(403);
  expect((await f.json(endpoint, desktop.cookie, legacy)).status).toBe(200);
  expect((await f.json(endpoint, desktop.cookie, legacy)).status).toBe(200);
  expect((await f.json(endpoint, desktop.cookie, { ...legacy, kind: 'side' })).status).toBe(409);
  expect((await f.json(stranger.basePath + 'v1/session-relations', stranger.cookie, legacy)).status).toBe(403);
  expect(creations).toBe(3);
  await f.restart();
  const restored = await read() as { relations: unknown[] };
  expect(restored.relations).toHaveLength(3);
  expect(restored).toMatchObject({ relations: expect.arrayContaining([expect.objectContaining({ kind: 'ask', id: 'legacy' })]) });
}, 30000);

it('keeps shared-host relations private, preserves client identities and hides them after revocation', async () => {
  const f = await fixture(); const alice = await f.login('alice'); const bob = await f.login('bob'); const carol = await f.login('carol');
  const pairing = await (await f.json(alice.basePath + 'v1/remote/pairings', alice.cookie, {})).json() as { key: string };
  const { socket, hostId } = await f.host(pairing.key);
  socket.addEventListener('message', event => {
    const frame = JSON.parse(String(event.data)); if (frame.type !== 'rpc_request') return;
    const input = JSON.parse(frame.body ?? '{}');
    send(socket, { type: 'rpc_response', requestId: frame.requestId, status: 200, body: JSON.stringify({ agentId: frame.sessionId,
      nativeSessionId: frame.path === '/remote/create' ? 'native-' + input.operationId : input.nativeSessionId }) });
  });
  for (const user of ['bob', 'carol']) expect((await f.control({ subject: 'alice', operation: 'share', hostId, targetSubject: user, targetLabel: user, sessionLimit: 5 })()).status).toBe(200);
  const path = bob.basePath + `v1/remote/hosts/${hostId}/create`;
  const source = await (await f.json(path, bob.cookie, { providerId: 'codex', operationId: 'main' })).json() as { nativeSessionId: string };
  const input = { providerId: 'codex', operationId: 'original-client-id', sourceNativeSessionId: source.nativeSessionId, conversationKind: 'side' };
  const first = await f.json(path, bob.cookie, input); expect(first.status).toBe(200);
  const side = await first.json() as { nativeSessionId: string };
  expect((await f.json(path, bob.cookie, input)).status).toBe(200);
  expect((await f.json(path, bob.cookie, { ...input, conversationKind: 'ask' })).status).toBe(409);
  expect((await f.json(path, bob.cookie, { ...input, operationId: 'nested', sourceNativeSessionId: side.nativeSessionId, conversationKind: 'ask' })).status).toBe(200);
  const list = async (account: typeof bob) => (await f.json(account.basePath + 'v1/session-relations', account.cookie)).json();
  expect(await list(bob)).toMatchObject({ relations: [{ id: 'original-client-id', source: { nativeSessionId: source.nativeSessionId } }, { id: 'nested', source: { nativeSessionId: side.nativeSessionId } }] });
  expect(await list(carol)).toEqual({ relations: [] });
  expect((await f.control({ subject: 'alice', operation: 'revoke-share', hostId, targetSubject: 'bob' })()).status).toBe(200);
  expect(await list(bob)).toEqual({ relations: [] });
}, 30000);
