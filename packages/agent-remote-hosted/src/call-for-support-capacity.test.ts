import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { afterEach, expect, test } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import { CALL_FOR_SUPPORT_GROUP_BYTES, type TeamHostCall } from '@orchardworks/agent-remote-protocol';
import { CALL_FOR_SUPPORT_RETENTION_BYTES } from './call-for-support.js';
import { relaySocket } from '../../agent-remote-lab/src/server/remote-host-broker.js';
import { createHostBroker, type RemoteHostBrokerState } from './broker.js';
import { validSavedTeam, type SavedTeam } from './team-delivery.js';

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

async function connectedBroker(teams: SavedTeam[], query: string) {
  const installationId = 'controller';
  let saved: RemoteHostBrokerState = {
    keys: [[createHash('sha256').update('key').digest('hex'), { kind: 'device', installationId, expires: Number.MAX_SAFE_INTEGER }]],
    hosts: [{ id: 'host', installationId, name: 'Host', legacyDsh: false, teamManagement: true, providers: [{ providerId: 'codex', displayName: 'Codex' }] }],
    bindings: [], creations: [], teams,
  };
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening', { signal: AbortSignal.timeout(3000) });
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const broker = createHostBroker({ origin, initialState: saved, now: () => 100, onStateChange(state) { saved = structuredClone(state); } });
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

test('keeps the account\'s Team state bound with full groups and leaves it unchanged when a change would exceed it', async () => {
  const one = fullGroup('probe');
  expect(Buffer.byteLength(JSON.stringify(one.callForSupport))).toBeLessThanOrEqual(CALL_FOR_SUPPORT_GROUP_BYTES);
  const teams: SavedTeam[] = [];
  while (Buffer.byteLength(JSON.stringify([...teams, fullGroup(`group-${teams.length}`)])) <= 2 * 1024 * 1024) teams.push(fullGroup(`group-${teams.length}`));
  expect(teams.length).toBeGreaterThanOrEqual(24);
  // Pad with an ordinary Team's pending messages to 100 bytes under the bound; then writing 200 more ledger characters crosses it.
  teams[0]!.callForSupport!.ledger.text = 'l'.repeat(15800);
  const padding = fullGroup('padding', true); teams.push(padding);
  const message = (index: number, length: number) => ({ id: `pad-${index}`, from: 'coordinator', to: 'helper', text: 'x'.repeat(length), status: 'queued' as const, createdAt: 1 });
  for (let index = 0; ; index++) {
    const spare = 2 * 1024 * 1024 - 100 - Buffer.byteLength(JSON.stringify(teams)) - Buffer.byteLength(JSON.stringify(message(index, 0))) - 1;
    if (spare <= 0) break;
    padding.messages.push(message(index, Math.min(16000, spare)));
  }
  expect(2 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(teams))).toBeGreaterThan(0);
  expect(2 * 1024 * 1024 - Buffer.byteLength(JSON.stringify(teams))).toBeLessThan(200);
  const f = await connectedBroker(teams, capable);
  const result = await f.call({ action: 'write_ledger', teamId: 'group-0', memberId: 'coordinator', revision: 1, text: 'l'.repeat(16000) });
  expect(result).toMatchObject({ status: 409, value: { error: expect.stringContaining('storage capacity') } });
  expect(f.snapshot()[0]!.callForSupport!.ledger.revision).toBe(1);
  expect((await f.call({ action: 'write_ledger', teamId: 'group-0', memberId: 'coordinator', revision: 1, text: 'short' })).value).toEqual({ revision: 2 });
}, 15000);

test('takes read-only providers from the Call For Support request, not from provider descriptors', async () => {
  const team = fullGroup('group');
  team.callForSupport!.calls = [{ id: 'c0', task: 'Review.', deliverable: 'findings', origin: 'worker', status: 'open', createdAt: 1, usage: { tokens: 0 } }];
  const propose = (f: Awaited<ReturnType<typeof connectedBroker>>) => f.call({ action: 'propose_roster', teamId: 'group', memberId: 'coordinator', operationId: 'roster',
    members: [{ name: 'Reviewer', responsibility: 'Review.', providerId: 'codex', model: 'gpt-5.5', workspace: 'shared' }], rationale: 'A second model.' });
  expect(await propose(await connectedBroker([structuredClone(team)], capable))).toMatchObject({ status: 409, value: { error: expect.stringContaining('cannot run read-only sessions') } });
  expect(await propose(await connectedBroker([structuredClone(team)], `${capable}&readOnlyProvider=codex`))).toMatchObject({ status: 200 });
});

test('removes the oldest archived groups when Team state nears its bound, so active Teams keep growing', async () => {
  const teams: SavedTeam[] = [];
  while (Buffer.byteLength(JSON.stringify([...teams, fullGroup(`group-${teams.length}`)])) <= 2 * 1024 * 1024 - 64 * 1024) teams.push(fullGroup(`group-${teams.length}`));
  // All but the first group are archived history, oldest first.
  teams.forEach((team, index) => { if (index) Object.assign(team, { status: 'archived', updatedAt: index }); });
  teams[0]!.callForSupport!.ledger.text = 'short';
  // An ordinary Team's pending messages bring the state within 1000 bytes of the bound; it is never removed.
  const plain = fullGroup('plain', true); teams.push(plain);
  const message = (index: number, length: number) => ({ id: `pad-${index}`, from: 'coordinator', to: 'helper', text: 'x'.repeat(length), status: 'queued' as const, createdAt: 1 });
  for (let index = 0; ; index++) {
    const spare = 2 * 1024 * 1024 - 1000 - Buffer.byteLength(JSON.stringify(teams)) - Buffer.byteLength(JSON.stringify(message(index, 0))) - 1;
    if (spare <= 0) break;
    plain.messages.push(message(index, Math.min(16000, spare)));
  }
  // Without removing archived groups, a full ledger would cross the bound.
  expect(Buffer.byteLength(JSON.stringify(teams))).toBeLessThanOrEqual(2 * 1024 * 1024);
  expect(Buffer.byteLength(JSON.stringify(teams)) + 16000).toBeGreaterThan(2 * 1024 * 1024);
  const f = await connectedBroker(teams, capable);
  expect((await f.call({ action: 'write_ledger', teamId: 'group-0', memberId: 'coordinator', revision: 1, text: 'l'.repeat(16000) })).value).toEqual({ revision: 2 });
  const kept = f.snapshot();
  expect(Buffer.byteLength(JSON.stringify(kept))).toBeLessThanOrEqual(CALL_FOR_SUPPORT_RETENTION_BYTES);
  expect(kept.map(team => team.id)).toEqual(expect.arrayContaining(['group-0', 'plain', `group-${teams.length - 2}`]));
  expect(kept.some(team => team.id === 'group-1')).toBe(false);
}, 15000);
