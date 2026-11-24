import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { afterEach, expect, test } from 'vitest';
import type { TeamHostCall, TeamMessage } from '@orchardworks/agent-remote-protocol';
import { memoryHostClient } from './test-utils/ws-relay-socket.js';
import { createHostBroker, type RemoteHostBrokerState } from './broker.js';
import { assertTeamQueueCapacity, validSavedTeam, type SavedTeam } from './team-delivery.js';

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
      role: 'requester', name: id, responsibility: '', creation: 'ready', activity: 'idle', summary: '', updatedAt: 1 })),
    messages: [], link: { assistants: ['leader', 'worker'], recent: [] },
  };
}

function pendingMessage(index: number, text = 'x'.repeat(16000)): TeamMessage {
  return { id: `pending-${index}`, from: 'leader', to: 'worker', text, status: 'queued', createdAt: 1 };
}

async function connectedBroker(teams: SavedTeam[] = [savedTeam()], stateRoom?: () => { growth: number; retention: number }) {
  let saved: RemoteHostBrokerState = {
    keys: [[createHash('sha256').update('key').digest('hex'), { kind: 'device', installationId: controllerId, expires: Number.MAX_SAFE_INTEGER }]],
    hosts: [{ id: 'host', installationId: controllerId, name: 'Host', legacyDsh: false, teamManagement: true, providers: [{ providerId: 'codex', displayName: 'Codex' }] }],
    bindings: [], creations: [], teams,
  };
  const origin = 'https://relay.example';
  const broker = createHostBroker({ origin, assistantGroups: () => [], initialState: saved, now: () => 100, ...(stateRoom ? { stateRoom } : {}), onStateChange(state) { saved = structuredClone(state); } });
  close.push(async () => { broker.close(); await broker.settled(); });
  const socket = memoryHostClient(broker, `${origin}/ws/remote-host?team=1&teamSuccession=1&tasks=1&coordinatorProvider=codex`);
  close.push(() => { socket.terminate(); });
  await once(socket, 'open', { signal: AbortSignal.timeout(3000) });
  const registered = once(socket, 'message', { signal: AbortSignal.timeout(3000) });
  socket.send(JSON.stringify({ uplinkVersion: 2, type: 'register', installationId: controllerId, name: 'Host', providers: [{ providerId: 'codex', displayName: 'Codex' }] }));
  expect(JSON.parse((await registered)[0].toString())).toMatchObject({ type: 'registered', teamSuccession: 1 });
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

const overflow = (text: string): TeamMessage => ({ id: 'overflow', from: 'leader', to: 'worker', text, status: 'queued', createdAt: 1 });

test('admits 200 small pending messages and reopens a slot after settlement', async () => {
  const team = savedTeam(); team.messages = Array.from({ length: 200 }, (_, index) => pendingMessage(index, 'Inspect'));
  const f = await connectedBroker([team]);
  expect(() => assertTeamQueueCapacity(f.snapshot()[0]!, overflow('Inspect'))).toThrow();
  const target = { teamId: 'team', memberId: 'worker', messageId: 'pending-0' };
  expect((await f.call({ action: 'claim', ...target, expectedNativeSessionId: nativeSessionId })).status).toBe(200);
  expect((await f.call({ action: 'settle', ...target, outcome: 'rejected', resolvedTarget: recipient })).status).toBe(200);
  expect(() => assertTeamQueueCapacity(f.snapshot()[0]!, overflow('Inspect'))).not.toThrow();
}, 10000);

test('uses actual pending input bytes instead of reserving recipient metadata per message', async () => {
  const team = savedTeam(); team.messages = Array.from({ length: 8 }, (_, index) => pendingMessage(index));
  const f = await connectedBroker([team]);
  expect(() => assertTeamQueueCapacity(f.snapshot()[0]!, overflow('x'.repeat(16000)))).toThrow('capacity');
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

test('keeps the Relay within its bound when recipient evidence would exceed it', async () => {
  const teams = Array.from({ length: 4 }, (_, index) => ({ ...savedTeam(`team-${index}`), messages: Array.from({ length: 8 }, (_, message) => pendingMessage(message)) }));
  // The Relay can grow by less than the claim's recipient evidence.
  const f = await connectedBroker(teams, () => ({ growth: 100, retention: 100 }));
  const result = await f.call({ action: 'claim', teamId: 'team-0', memberId: 'worker', messageId: 'pending-0', expectedNativeSessionId: nativeSessionId });
  expect(result.status).toBe(409);
  expect(result.value.error).toContain('storage capacity');
  expect(f.snapshot()[0]!.messages[0]).toMatchObject({ status: 'queued' });
  expect(f.snapshot()[0]!.messages[0]!.resolvedTarget).toBeUndefined();
}, 10000);

test('settles an acknowledgement that a started turn took with its input, and keeps the Relay storing the team', async () => {
  const team = savedTeam();
  team.messages = [{ ...pendingMessage(0, 'Thanks, noted.'), ack: true }, pendingMessage(1, 'Is the branch cut?')];
  const f = await connectedBroker([team]);
  for (const message of team.messages) {
    const target = { teamId: team.id, memberId: 'worker', messageId: message.id };
    expect((await f.call({ action: 'claim', ...target, expectedNativeSessionId: nativeSessionId })).status).toBe(200);
  }
  for (const message of team.messages) {
    const target = { teamId: team.id, memberId: 'worker', messageId: message.id };
    expect((await f.call({ action: 'settle', ...target, outcome: 'accepted', acceptance: 'started', resolvedTarget: recipient })).status).toBe(200);
  }
  const stored = f.snapshot()[0]!;
  expect(stored.messages).toEqual([]);
  expect(validSavedTeam(stored)).toBe(true);
}, 10000);
