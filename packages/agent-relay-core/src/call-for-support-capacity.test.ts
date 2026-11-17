import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { afterEach, expect, test } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { CALL_FOR_SUPPORT_GROUP_BYTES, type TeamHostCall } from '@orchardworks/agent-remote-protocol';
import { CALL_FOR_SUPPORT_RECENT_MS } from './call-for-support.js';
import { relaySocket } from '../../agent-remote-lab/src/server/remote-host-broker.js';
import { createHostBroker, type RemoteHostBrokerState } from './broker.js';
import { TEAM_RECORD_BYTES, validSavedTeam, type SavedTeam } from './team-delivery.js';

const close: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of close.splice(0).reverse()) await dispose(); }, 5000);

/** A group whose Call For Support state is close to its storage bound. */
function fullGroup(id: string, plain = false): SavedTeam {
  const member = (memberId: string, role: 'leader' | 'requester' | 'member', extra: Record<string, unknown> = {}) => ({ id: memberId, hostId: 'host', providerId: 'codex', nativeSessionId: `${id}-${memberId}`,
    role, name: memberId, responsibility: '', creation: 'ready' as const, activity: 'idle' as const, summary: '', updatedAt: 1, ...extra });
  const team: SavedTeam = { id, operationId: id, revision: 1, source: { hostId: 'host', providerId: 'codex', nativeSessionId: `${id}-worker`, title: 'Worker' }, title: 'Review',
    status: 'active', createdAt: 1, updatedAt: 1, messages: [],
    members: [member('coordinator', 'leader', { access: 'read_only', workspace: { kind: 'shared' } }), member('worker', 'requester')] };
  if (plain) { team.members = [member('coordinator', 'leader'), member('helper', 'member')]; return team; }
  const findings = Array.from({ length: 6 }, (_, index) => ({ id: `f${index}`, severity: 'note' as const, problem: 'p'.repeat(900), evidence: 'e'.repeat(900) }));
  team.callForSupport = { role: 'Review', description: '', status: 'active', coordinator: { providerId: 'codex' }, ledger: { text: 'l'.repeat(16000), revision: 1 }, usage: { tokens: 0 },
    mandate: { supporters: [{ providerId: 'codex', model: 'gpt-5.5' }], maxSupporters: 1, workspaces: ['shared'], remoteHosts: [], approval: 'every_roster' },
    calls: Array.from({ length: 3 }, (_, index) => ({ id: `c${index}`, task: 't'.repeat(2000), deliverable: 'findings' as const, origin: 'worker' as const, status: 'reported' as const,
      createdAt: 1, reportedAt: 2, usage: { tokens: 0 }, report: { status: 'reported' as const, summary: 's'.repeat(1000), findings } })) };
  return team;
}

async function connectedBroker(teams: SavedTeam[], query: string, now = 100, stateRoom?: () => { growth: number; retention: number }) {
  const installationId = 'controller';
  let saved: RemoteHostBrokerState = {
    keys: [[createHash('sha256').update('key').digest('hex'), { kind: 'device', installationId, expires: Number.MAX_SAFE_INTEGER }]],
    hosts: [{ id: 'host', installationId, name: 'Host', legacyDsh: false, teamManagement: true, providers: [{ providerId: 'codex', displayName: 'Codex' }] }],
    bindings: [], creations: [], teams,
  };
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening', { signal: AbortSignal.timeout(3000) });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const broker = createHostBroker({ origin, initialState: saved, now: () => now, ...(stateRoom ? { stateRoom } : {}), onStateChange(state) { saved = structuredClone(state); } });
  server.on('connection', (socket, request) => {
    void broker.prepareUpgrade(new Request(origin + request.url, { headers: { authorization: 'Bearer key' } })).then(upgrade => {
      if (!upgrade || upgrade instanceof Response) socket.close();
      else upgrade.accept(relaySocket(socket));
    }).catch(() => socket.close(1011));
  });
  close.push(async () => { broker.close(); for (const socket of server.clients) socket.terminate(); await broker.settled(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/ws/remote-host?${query}`);
  await once(socket, 'open', { signal: AbortSignal.timeout(3000) });
  const registered = once(socket, 'message', { signal: AbortSignal.timeout(3000) });
  socket.send(JSON.stringify({ uplinkVersion: 2, type: 'register', installationId, name: 'Host', providers: [{ providerId: 'codex', displayName: 'Codex' }] }));
  await registered;
  let sequence = 0;
  return {
    snapshot: () => structuredClone(saved.teams!),
    async call(call: TeamHostCall): Promise<{ status: number; value: any }> {
      const requestId = String(++sequence);
      const response = once(socket, 'message', { signal: AbortSignal.timeout(3000) });
      socket.send(JSON.stringify({ uplinkVersion: 2, type: 'team_request', requestId, call }));
      const packet = JSON.parse((await response)[0].toString());
      return { status: packet.status, value: JSON.parse(packet.body) };
    },
  };
}
const capable = 'team=1&teamRecipients=1&teamSuccession=1&callForSupport=1';

test('hides groups from Controllers that do not run them and serves them to those that do', async () => {
  const teams = [fullGroup('group'), fullGroup('plain', true)];
  expect(teams.every(validSavedTeam)).toBe(true);
  const legacy = await connectedBroker(teams, 'team=1&teamRecipients=1&teamSuccession=1');
  expect((await legacy.call({ action: 'poll' })).value.map((team: { id: string }) => team.id)).toEqual(['plain']);
  expect(await legacy.call({ action: 'read', teamId: 'group', memberId: 'coordinator' })).toMatchObject({ status: 409, value: { error: expect.stringContaining('Update the Controller') } });
  expect(await legacy.call({ action: 'write_ledger', teamId: 'group', memberId: 'coordinator', revision: 1, text: 'x' })).toMatchObject({ status: 409 });
  const current = await connectedBroker(teams, capable);
  expect((await current.call({ action: 'poll' })).value.map((team: { id: string }) => team.id).sort()).toEqual(['group', 'plain']);
});

/** An ordinary Team whose resource grants bring it within reach of its own bound. */
function largeTeam(id: string, bytes: number): SavedTeam {
  const team = fullGroup(id, true), ids = Array.from({ length: 12 }, (_, index) => `${index}-`.padEnd(200, 'm'));
  team.members = ids.map((memberId, index) => ({ ...team.members[0]!, id: memberId, role: index ? 'member' as const : 'leader' as const, name: `member ${index}`, nativeSessionId: `${id}-${index}` }));
  team.resourceUploads = []; team.resourceGrants = [];
  for (let index = 0; Buffer.byteLength(JSON.stringify(team)) < bytes - 8000; index++) {
    const resourceId = `${index}-`.padEnd(200, 'r');
    team.resourceUploads.push({ ownerMemberId: ids[0]!, expiresAt: Number.MAX_SAFE_INTEGER, resource: { resourceId, name: 'n'.repeat(250), mediaType: 'text/plain', byteLength: 1, sha256: 'a'.repeat(64) } });
    team.resourceGrants.push({ resourceId, memberIds: ids });
  }
  // Responsibilities fill the rest, to 2000 bytes under the requested size.
  for (const member of team.members) {
    const missing = bytes - 2000 - Buffer.byteLength(JSON.stringify(team));
    if (missing <= 0) break;
    member.responsibility = 'x'.repeat(Math.min(2048, missing));
  }
  return team;
}

test('lets an account\'s Teams exceed what one Team may hold, while no change grows a Team beyond its own bound', async () => {
  const teams: SavedTeam[] = [];
  while (Buffer.byteLength(JSON.stringify(teams)) <= 3 * 1024 * 1024) teams.push(fullGroup(`group-${teams.length}`));
  const large = largeTeam('large', TEAM_RECORD_BYTES); teams.push(large);
  expect(teams.every(validSavedTeam)).toBe(true);
  expect(TEAM_RECORD_BYTES - Buffer.byteLength(JSON.stringify(large))).toBe(2000);
  const f = await connectedBroker(teams, capable);
  expect((await f.call({ action: 'write_ledger', teamId: 'group-0', memberId: 'coordinator', revision: 1, text: 'l'.repeat(16000) })).value).toEqual({ revision: 2 });
  const leader = large.members[0]!.id;
  expect(await f.call({ action: 'report', teamId: 'large', memberId: leader, summary: 's'.repeat(2048) })).toMatchObject({ status: 409, value: { error: expect.stringContaining('storage capacity') } });
  expect(f.snapshot().find(team => team.id === 'large')!.members[0]!.summary).toBe('');
  expect((await f.call({ action: 'report', teamId: 'large', memberId: leader, summary: 'Checked.' })).status).toBe(200);
  expect(Buffer.byteLength(JSON.stringify(f.snapshot()))).toBeGreaterThan(5 * 1024 * 1024);
}, 15000);

test('a Team already over its bound may still shrink, but not grow', async () => {
  const large = largeTeam('large', TEAM_RECORD_BYTES + 4000);
  large.members[0]!.summary = 's'.repeat(2048);
  expect(Buffer.byteLength(JSON.stringify(large))).toBeGreaterThan(TEAM_RECORD_BYTES);
  const f = await connectedBroker([large], capable), leader = large.members[0]!.id;
  expect((await f.call({ action: 'report', teamId: 'large', memberId: leader, summary: 'Shorter.' })).status).toBe(200);
  expect(await f.call({ action: 'report', teamId: 'large', memberId: leader, summary: 's'.repeat(2048) })).toMatchObject({ status: 409, value: { error: expect.stringContaining('storage capacity') } });
}, 15000);

test('takes read-only providers from the Call For Support request, not from provider descriptors', async () => {
  const team = fullGroup('group');
  team.callForSupport!.calls = [{ id: 'c0', task: 'Review.', deliverable: 'findings', origin: 'worker', status: 'open', createdAt: 1, usage: { tokens: 0 } }];
  const propose = (f: Awaited<ReturnType<typeof connectedBroker>>) => f.call({ action: 'propose_roster', teamId: 'group', memberId: 'coordinator', operationId: 'roster',
    members: [{ name: 'Reviewer', responsibility: 'Review.', providerId: 'codex', model: 'gpt-5.5', workspace: 'shared' }], rationale: 'A second model.' });
  expect(await propose(await connectedBroker([structuredClone(team)], capable))).toMatchObject({ status: 409, value: { error: expect.stringContaining('cannot run read-only sessions') } });
  expect(await propose(await connectedBroker([structuredClone(team)], `${capable}&readOnlyProvider=codex`))).toMatchObject({ status: 200 });
});

test('removes the oldest archived groups while the Relay is above what it retains, which also makes room at its bound', async () => {
  const teams = Array.from({ length: 20 }, (_, index) => fullGroup(`group-${index}`));
  // All but the first group are archived history, oldest first.
  teams.forEach((team, index) => { if (index) Object.assign(team, { status: 'archived', updatedAt: index }); });
  teams[0]!.callForSupport!.ledger.text = 'short';
  const plain = fullGroup('plain', true); teams.push(plain);
  const group = Buffer.byteLength(JSON.stringify(teams[1]));
  // The Relay is two groups over what it retains, and can still grow by two groups.
  let room = { growth: 2 * group, retention: -2 * group };
  // The groups' last calls were reported long ago, so none is protected as recently used.
  const f = await connectedBroker(teams, capable, 2 * CALL_FOR_SUPPORT_RECENT_MS, () => room);
  expect((await f.call({ action: 'write_ledger', teamId: 'group-0', memberId: 'coordinator', revision: 1, text: 'l'.repeat(15000) })).value).toEqual({ revision: 2 });
  const kept = () => f.snapshot().map(team => team.id);
  expect(kept()).toEqual(expect.arrayContaining(['group-0', 'plain', 'group-19']));
  expect(kept().filter(id => ['group-1', 'group-2', 'group-3'].includes(id))).toEqual([]);
  expect(kept()).toHaveLength(teams.length - 3);
  // At its bound, a change that grows the account's Teams removes the next oldest group to make room for it.
  room = { growth: 0, retention: 0 };
  expect((await f.call({ action: 'write_ledger', teamId: 'group-0', memberId: 'coordinator', revision: 2, text: 'l'.repeat(16000) })).value).toEqual({ revision: 3 });
  expect(kept()).not.toContain('group-4');
  expect(kept()).toHaveLength(teams.length - 4);
}, 15000);

test('refuses a change that would grow the Relay beyond its bound, and still applies one that shrinks a Team', async () => {
  const team = fullGroup('plain', true); team.members[0]!.summary = 'Reviewed the storage layer.';
  const f = await connectedBroker([team], capable, 100, () => ({ growth: 0, retention: 0 }));
  expect(await f.call({ action: 'report', teamId: 'plain', memberId: 'coordinator', summary: 'Reviewed the storage layer and its tests.' }))
    .toMatchObject({ status: 409, value: { error: expect.stringContaining('storage capacity') } });
  expect(f.snapshot()[0]!.members[0]!.summary).toBe('Reviewed the storage layer.');
  expect((await f.call({ action: 'report', teamId: 'plain', memberId: 'coordinator', summary: 'Done.' })).status).toBe(200);
}, 15000);

test('deletes an archived support group through the Team route', async () => {
  const archived = fullGroup('archived'), active = fullGroup('active'); archived.status = 'archived';
  const broker = createHostBroker({ origin: 'https://relay.example', now: () => 100, initialState: { keys: [], bindings: [], creations: [], teams: [archived, active],
    hosts: [{ id: 'host', installationId: 'controller', name: 'Host', legacyDsh: false, providers: [{ providerId: 'codex', displayName: 'Codex' }] }] } });
  try {
    const remove = async (teamId: string) => {
      const response = (await broker.handleRequest(new Request('https://relay.example/v1/remote/teams/delete', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ teamId }) })))!;
      return [response.status, await response.json()];
    };
    expect(await remove('active')).toEqual([409, { error: 'Archive the support group before deleting it.' }]);
    expect(await remove('archived')).toEqual([200, { teamId: 'archived', deleted: true }]);
    expect(broker.snapshot().teams!.map(team => team.id)).toEqual(['active']);
    expect(await remove('archived')).toEqual([404, { error: 'Team not found.' }]);
  } finally { await broker.close(); }
});
