import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { afterEach, expect, test } from 'vitest';
import { WebSocket, WebSocketServer } from 'ws';
import type { TeamHostCall, TeamMessage } from '@orchardworks/agent-remote-protocol';
import { relaySocket } from '../../agent-remote-lab/src/server/remote-host-broker.js';
import { createHostBroker, type RemoteHostBrokerState } from './broker.js';
import { validSavedTeam, type SavedTeam } from './team-delivery.js';

const close: Array<() => Promise<void>> = [];
afterEach(async () => { for (const dispose of close.splice(0).reverse()) await dispose(); }, 5000);
const controllerId = 'c'.repeat(512);
const nativeSessionId = 'n'.repeat(512);
const recipient = { controllerId, providerId: 'codex', nativeSessionId };

function savedTeam(id = 'team'): SavedTeam {
  return {
    id, operationId: id, revision: 1, source: { hostId: 'host', providerId: 'codex', nativeSessionId: 'source', title: 'Source' },
    title: 'Team', status: 'active', createdAt: 1, updatedAt: 1,
    members: ['leader', 'worker'].map((id, index) => ({ id, hostId: 'host', providerId: 'codex', nativeSessionId: index ? nativeSessionId : 'leader-session',
      role: index ? 'member' : 'leader', name: id, responsibility: '', creation: 'ready', activity: 'idle', summary: '', updatedAt: 1 })),
    messages: [],
  };
}

function pendingMessage(index: number, text = 'x'.repeat(16000)): TeamMessage {
  return { id: `pending-${index}`, from: 'leader', to: 'worker', text, status: 'queued', createdAt: 1 };
}

async function connectedBroker(teams: SavedTeam[] = [savedTeam()]) {
  let saved: RemoteHostBrokerState = {
    keys: [[createHash('sha256').update('key').digest('hex'), { kind: 'device', installationId: controllerId, expires: Number.MAX_SAFE_INTEGER }]],
    hosts: [{ id: 'host', installationId: controllerId, name: 'Host', legacyDsh: false, teamManagement: true, providers: [{ providerId: 'codex', displayName: 'Codex' }] }],
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
  close.push(async () => {
    broker.close();
    for (const socket of server.clients) socket.terminate();
    await broker.settled();
    await new Promise<void>(resolve => server.close(() => resolve()));
  });
  const socket = new WebSocket(`${origin.replace('http:', 'ws:')}/ws/remote-host?team=1&teamRecipients=1`);
  await once(socket, 'open', { signal: AbortSignal.timeout(3000) });
  const registered = once(socket, 'message', { signal: AbortSignal.timeout(3000) });
  socket.send(JSON.stringify({ uplinkVersion: 2, type: 'register', installationId: controllerId, name: 'Host', providers: [{ providerId: 'codex', displayName: 'Codex' }] }));
  expect(JSON.parse((await registered)[0].toString())).toMatchObject({ type: 'registered', teamRecipients: 1 });
  let sequence = 0;
  return {
    snapshot: () => structuredClone(saved.teams!),
    async call(call: TeamHostCall): Promise<{ status: number; value: TeamMessage & { error?: string } }> {
      const requestId = String(++sequence);
      const response = once(socket, 'message', { signal: AbortSignal.timeout(3000) });
      socket.send(JSON.stringify({ uplinkVersion: 2, type: 'team_request', requestId, call }));
      const packet = JSON.parse((await response)[0].toString());
      expect(packet).toMatchObject({ type: 'team_response', requestId });
      return { status: packet.status, value: JSON.parse(packet.body) };
    },
  };
}

const send = (operationId: string, text: string): TeamHostCall => ({ action: 'send', teamId: 'team', memberId: 'leader', to: 'worker', operationId, text });

test('admits 200 small pending messages and reopens a slot after settlement', async () => {
  const f = await connectedBroker();
  for (let index = 0; index < 200; index++) expect((await f.call(send(`small-${index}`, 'Inspect'))).status).toBe(200);
  expect(f.snapshot()[0]!.messages).toHaveLength(200);
  expect((await f.call(send('overflow', 'Inspect'))).status).toBe(409);
  const target = { teamId: 'team', memberId: 'worker', messageId: f.snapshot()[0]!.messages[0]!.id };
  expect((await f.call({ action: 'claim', ...target, expectedNativeSessionId: nativeSessionId })).status).toBe(200);
  expect((await f.call({ action: 'settle', ...target, outcome: 'rejected', resolvedTarget: recipient })).status).toBe(200);
  expect((await f.call(send('overflow', 'Inspect'))).status).toBe(200);
  expect(f.snapshot()[0]!.messages).toHaveLength(200);
}, 10000);

test('uses actual pending input bytes instead of reserving recipient metadata per message', async () => {
  const f = await connectedBroker();
  for (let index = 0; index < 8; index++) expect((await f.call(send(`large-${index}`, 'x'.repeat(16000)))).status).toBe(200);
  expect(f.snapshot()[0]!.messages).toHaveLength(8);
  const rejected = await f.call(send('overflow', 'x'.repeat(16000)));
  expect(rejected.status).toBe(409);
  expect(rejected.value.error).toContain('capacity');
  for (const message of f.snapshot()[0]!.messages) {
    const target = { teamId: 'team', memberId: 'worker', messageId: message.id };
    expect((await f.call({ action: 'claim', ...target, expectedNativeSessionId: nativeSessionId })).status).toBe(200);
    expect((await f.call({ action: 'settle', ...target, outcome: 'accepted', acceptance: 'queued', resolvedTarget: recipient })).status).toBe(200);
  }
  const saved = f.snapshot()[0]!;
  expect(saved.messages).toHaveLength(8);
  expect(saved.messages.every(message => message.acceptance === 'queued' && message.resolvedTarget?.nativeSessionId === nativeSessionId)).toBe(true);
  expect(Buffer.byteLength(JSON.stringify(saved.messages))).toBeGreaterThan(128 * 1024);
  expect(validSavedTeam(saved)).toBe(true);
}, 10000);

test('persists claim and uncertain settlement evidence when pending input nearly fills the byte budget', async () => {
  const team = savedTeam();
  team.messages = Array.from({ length: 8 }, (_, index) => pendingMessage(index));
  team.messages.push(pendingMessage(8, 'x'));
  team.messages[8]!.text += 'x'.repeat(128 * 1024 - 1 - Buffer.byteLength(JSON.stringify(team.messages)));
  expect(Buffer.byteLength(JSON.stringify(team.messages))).toBe(128 * 1024 - 1);
  const f = await connectedBroker([team]);
  for (const message of team.messages) {
    const target = { teamId: team.id, memberId: 'worker', messageId: message.id };
    expect((await f.call({ action: 'claim', ...target, expectedNativeSessionId: nativeSessionId })).status).toBe(200);
    expect((await f.call({ action: 'settle', ...target, outcome: 'unknown', error: '\u0000'.repeat(2048), resolvedTarget: recipient })).status).toBe(200);
  }
  const stored = f.snapshot()[0]!;
  expect(stored.messages).toHaveLength(9);
  expect(stored.messages.every(message => message.status === 'unknown' && message.error?.length === 2048)).toBe(true);
  expect(validSavedTeam(stored)).toBe(true);
}, 10000);

test('keeps the full durable Team state limit when recipient evidence would exceed it', async () => {
  const teams = Array.from({ length: 17 }, (_, index) => ({ ...savedTeam(`team-${index}`), messages: Array.from({ length: 8 }, (_, message) => pendingMessage(message)) }));
  let excess = Buffer.byteLength(JSON.stringify(teams)) - (2 * 1024 * 1024 - 1);
  for (const team of [...teams].reverse()) for (const message of team.messages) {
    const removed = Math.min(excess, message.text.length - 1);
    message.text = message.text.slice(removed);
    excess -= removed;
  }
  expect(excess).toBe(0);
  expect(Buffer.byteLength(JSON.stringify(teams))).toBe(2 * 1024 * 1024 - 1);
  const f = await connectedBroker(teams);
  const result = await f.call({ action: 'claim', teamId: 'team-0', memberId: 'worker', messageId: 'pending-0', expectedNativeSessionId: nativeSessionId });
  expect(result.status).toBe(409);
  expect(result.value.error).toContain('storage capacity');
  expect(f.snapshot()[0]!.messages[0]).toMatchObject({ status: 'queued' });
  expect(f.snapshot()[0]!.messages[0]!.resolvedTarget).toBeUndefined();
}, 10000);
