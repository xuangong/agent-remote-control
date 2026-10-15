import { createHash, randomUUID } from 'node:crypto';
import type { WebSocket } from 'miniflare';
import { expect, it } from 'vitest';
import { fixture, send } from './fixture.js';

function call(socket: WebSocket, request: Record<string, unknown>): Promise<{ status: number; body: any }> {
  const requestId = randomUUID();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.removeEventListener('message', receive); reject(new Error('Team request deadline exceeded')); }, 5000);
    const receive = (event: MessageEvent) => {
      const frame = JSON.parse(String(event.data));
      if (frame.type !== 'team_response' || frame.requestId !== requestId) return;
      clearTimeout(timer); socket.removeEventListener('message', receive);
      resolve({ status: frame.status, body: JSON.parse(frame.body) });
    };
    socket.addEventListener('message', receive);
    send(socket, { type: 'team_request', requestId, call: request });
  });
}

it('transfers authorized Team resources through the production Worker and preserves access after restart', async () => {
  const f = await fixture({ actualEntry: true });
  const alice = await f.login('alice');
  async function host(name: string, savedKey?: string) {
    const key = savedKey ?? ((await (await f.json(alice.basePath + 'v1/remote/pairings', alice.cookie, {})).json()) as { key: string }).key;
    const h = await f.host(key, false, undefined, false, false, 'codex', name, false, true, true);
    expect(h.teamResources).toBe(true);
    h.socket.addEventListener('message', event => {
      const frame = JSON.parse(String(event.data));
      if (frame.type !== 'rpc_request' || frame.path !== '/remote/team/create-seat') return;
      const seat = JSON.parse(frame.body);
      send(h.socket, { type: 'rpc_response', requestId: frame.requestId, status: 200, body: JSON.stringify({ ...seat.member, nativeSessionId: 'native-' + seat.member.id, creation: 'ready', activity: 'idle' }) });
    });
    return h;
  }
  let leaderHost = await host('resource-leader');
  let workerHost = await host('resource-worker');
  const path = alice.basePath + 'v1/remote/teams';
  const created = await f.json(path + '/create', alice.cookie, { operationId: 'resources', source: { hostId: leaderHost.hostId, providerId: 'codex', nativeSessionId: 'main', title: 'Resources' } });
  expect(created.status).toBe(200);
  const team = await created.json() as any;
  const joined = await f.json(path + '/action', alice.cookie, { teamId: team.id, action: 'add_member', operationId: 'worker', hostId: workerHost.hostId, providerId: 'codex', name: 'Worker', cwd: '/fixture', responsibility: 'Receive files' });
  expect(joined.status).toBe(200);
  const owner = { teamId: team.id, memberId: team.members[0].id };
  const recipient = { teamId: team.id, memberId: 'worker' };
  const bytes = Buffer.alloc(300_007, 37);
  const sha256 = createHash('sha256').update(bytes).digest('hex');
  const operationId = 'diagnostics';
  expect((await call(leaderHost.socket, { ...owner, action: 'resource_begin', operationId, name: 'diagnostics.zip', mediaType: 'application/zip', byteLength: bytes.length, sha256 })).status).toBe(200);
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    expect((await call(leaderHost.socket, { ...owner, action: 'resource_chunk', operationId, offset, contentBase64: bytes.subarray(offset, offset + 32768).toString('base64') })).status).toBe(200);
  }
  const finished = await call(leaderHost.socket, { ...owner, action: 'resource_finish', operationId });
  expect(finished.status).toBe(200);
  const resourceId = finished.body.resource.resourceId;
  expect((await call(workerHost.socket, { ...recipient, action: 'resource_metadata', resourceId })).status).toBeGreaterThanOrEqual(400);
  const message = { ...owner, action: 'send', operationId: 'send-file', to: 'worker', text: 'Inspect this archive.', resources: [resourceId] };
  const sent = await call(leaderHost.socket, message);
  expect(sent.status).toBe(200);
  const target = { ...recipient, messageId: sent.body.id };
  const claimed = await call(workerHost.socket, { ...target, action: 'claim', expectedNativeSessionId: 'native-worker' });
  expect(claimed).toMatchObject({status:200,body:{resolvedTarget:{controllerId:'resource-worker',providerId:'codex',nativeSessionId:'native-worker'}}});
  const resolvedTarget = claimed.body.resolvedTarget;
  expect((await call(workerHost.socket, { ...target, action:'settle', outcome:'accepted', resolvedTarget:{...resolvedTarget,nativeSessionId:'wrong'} })).status).toBe(409);
  expect((await call(workerHost.socket, { ...target, action: 'settle', outcome: 'accepted', acceptance: 'started', resolvedTarget })).status).toBe(200);
  await f.restart();
  workerHost = await host('resource-worker', workerHost.key);
  leaderHost = await host('resource-leader', leaderHost.key);
  const replay = await call(leaderHost.socket, message);
  expect(replay.status).toBe(200);
  expect(replay.body).toMatchObject({id: sent.body.id, status: 'accepted', resolvedTarget});
  expect((await call(workerHost.socket, { ...target, action: 'settle', outcome: 'accepted', acceptance: 'started', resolvedTarget })).status).toBe(200);
  const chunks: Buffer[] = [];
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    const received = await call(workerHost.socket, { ...recipient, action: 'resource_read', resourceId, offset });
    expect(received.status).toBe(200);
    expect(received.body.sha256).toBe(sha256);
    chunks.push(Buffer.from(received.body.contentBase64, 'base64'));
  }
  expect(Buffer.concat(chunks)).toEqual(bytes);
  const restored = await (await f.json(path, alice.cookie)).json() as any;
  expect(restored.teams[0].messages.some((item: {id: string}) => item.id === sent.body.id)).toBe(false);
  expect(restored.teams[0]).not.toHaveProperty('deliveryReceipts');
  expect(restored.teams[0]).not.toHaveProperty('resourceGrants');
  expect(JSON.stringify(restored).length).toBeLessThan(128 * 1024);
}, 30000);
