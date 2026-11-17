import { expect, it } from 'vitest';
import type { TeamHostCall, TeamMessage, NativeSessionRef } from '@orchardworks/agent-remote-protocol';
import { TeamBroker } from './teams.js';
import type { SavedTeam } from './team-delivery.js';

function inbox() {
  const member = { hostId: 'mac', providerId: 'codex', responsibility: '', creation: 'ready' as const, activity: 'busy' as const, summary: '', updatedAt: 1 };
  let target: NativeSessionRef = { controllerId: 'mac', providerId: 'codex', nativeSessionId: 'leader-native' };
  let frozen = false;
  let state: SavedTeam[] = [{ id: 'team', operationId: 'create', revision: 1,
    source: { hostId: 'mac', providerId: 'codex', nativeSessionId: 'source', title: 'Project' }, title: 'Team', status: 'active',
    members: [{ ...member, id: 'leader', role: 'leader', name: 'Leader', nativeSessionId: 'leader-native' },
      { ...member, hostId: 'win', id: 'worker', role: 'member', name: 'Worker', nativeSessionId: 'worker-native' }],
    messages: [], createdAt: 1, updatedAt: 1 }];
  const ports: ConstructorParameters<typeof TeamBroker>[0] = {
    read: () => state, now: () => 100,
    change: async update => { const draft = structuredClone(state); const result = structuredClone(update(draft)); state = draft; return result; },
    resolveSession: (hostId, providerId, nativeSessionId) => hostId === 'mac' ? target : { controllerId: hostId, providerId, nativeSessionId },
    assertRecipient: () => { if (frozen) throw new Error('Recipient is frozen.'); },
    assertHost: () => {}, createSeat: async () => { throw new Error('Unexpected creation.'); },
  };
  const broker = new TeamBroker(ports);
  const call = (action: string, rest = {}) => ({ action, teamId: 'team', memberId: 'leader', ...rest }) as TeamHostCall;
  return { broker, ports, snapshot: () => structuredClone(state[0]!),
    move: () => { target = { ...target, nativeSessionId: 'replacement' }; }, freeze: () => { frozen = true; },
    seed: (message: TeamMessage) => { state[0]!.messages.push(message); },
    send: async (operationId = 'result') => await broker.hostCall('win', { action: 'send', teamId: 'team', memberId: 'worker', to: 'leader', operationId, text: `Report ${operationId}` }) as TeamMessage,
    read: () => broker.hostCall('mac', call('read')),
    ack: (ids: string[], nativeSessionId = 'leader-native') => broker.hostCall('mac', call('acknowledge', { messageIds: ids, expectedNativeSessionId: nativeSessionId })),
  };
}

it('acknowledges a busy recipient inbox without native dispatch and replays the receipt after restart', async () => {
  const f = inbox(), sent = await f.send();
  expect(await f.read()).toMatchObject({ messages: [{ id: sent.id, text: sent.text, status: 'queued' }] });
  expect(f.snapshot().messages).toHaveLength(1);
  const result = await f.ack([sent.id]);
  expect(result).toMatchObject({ acknowledged: [{ id: sent.id, status: 'accepted', acceptance: 'handled', resolvedTarget: { nativeSessionId: 'leader-native' } }] });
  expect(JSON.stringify(result)).not.toContain(sent.text);
  expect(f.snapshot().messages).toEqual([]);
  expect(f.snapshot().deliveryReceipts).toHaveLength(1);
  const restarted = new TeamBroker(f.ports);
  expect(await restarted.hostCall('mac', { action: 'acknowledge', teamId: 'team', memberId: 'leader', messageIds: [sent.id], expectedNativeSessionId: 'leader-native' } as TeamHostCall)).toEqual(result);
  expect(await f.send()).toMatchObject({ id: sent.id, status: 'accepted', acceptance: 'handled' });
  await expect(restarted.hostCall('mac', { action: 'claim', teamId: 'team', memberId: 'leader', messageId: sent.id, expectedNativeSessionId: 'leader-native' })).rejects.toThrow('already settled');
});

it('validates the entire acknowledgement batch before removing any body', async () => {
  const f = inbox(), first = await f.send('first');
  f.seed({ id: 'outbound', from: 'leader', to: 'worker', text: 'Task', status: 'queued', createdAt: 1 });
  await expect(f.ack([first.id, 'outbound'])).rejects.toThrow('addressed');
  expect(f.snapshot().messages.map(message => message.id)).toEqual([first.id, 'outbound']);
  await expect(f.ack([first.id, 'missing'])).rejects.toThrow('unavailable');
  expect(f.snapshot().messages).toHaveLength(2);
});

it('preserves claimed and uncertain native effects when automatic delivery wins', async () => {
  const f = inbox(), sent = await f.send();
  const claim = { action: 'claim' as const, teamId: 'team', memberId: 'leader', messageId: sent.id, expectedNativeSessionId: 'leader-native' };
  await f.broker.hostCall('mac', claim);
  await expect(f.ack([sent.id])).rejects.toThrow('native delivery');
  const target = f.snapshot().messages[0]!.resolvedTarget!;
  await f.broker.hostCall('mac', { action: 'settle', teamId: 'team', memberId: 'leader', messageId: sent.id, outcome: 'unknown', resolvedTarget: target });
  await expect(f.ack([sent.id])).rejects.toThrow('native delivery');
  expect(f.snapshot().messages[0]!.status).toBe('unknown');
  await f.broker.action({ action: 'resolve_message', teamId: 'team', messageId: sent.id, outcome: 'accepted' });
  expect(await f.ack([sent.id])).toMatchObject({ acknowledged: [{ acceptance: 'handled' }] });
});

it('requires the exact current recipient and an unfrozen session', async () => {
  const f = inbox(), sent = await f.send();
  await expect(f.broker.hostCall('win', { action: 'acknowledge', teamId: 'team', memberId: 'leader', messageIds: [sent.id], expectedNativeSessionId: 'leader-native' } as TeamHostCall)).rejects.toThrow('registered');
  f.move();
  await expect(f.ack([sent.id])).rejects.toThrow('recipient');
  f.freeze();
  await expect(f.ack([sent.id], 'replacement')).rejects.toThrow('frozen');
  expect(f.snapshot().messages).toHaveLength(1);
});

it('does not turn canceled or rejected delivery into a successful inbox acknowledgement', async () => {
  const f = inbox(), sent = await f.send();
  await f.broker.action({ action: 'archive', teamId: 'team' });
  await expect(f.ack([sent.id])).rejects.toThrow('not accepted');
  expect(f.snapshot().deliveryReceipts?.[0]?.status).toBe('canceled');
});

it('preserves attachment grants when acknowledged bodies are compacted', async () => {
  const f = inbox();
  const resource = { resourceId: 'zip', name: 'evidence.zip', mediaType: 'application/zip', byteLength: 10, sha256: 'a'.repeat(64) };
  await f.ports.change(teams => { teams[0]!.resourceUploads = [{ ownerMemberId: 'worker', expiresAt: 1000, resource }]; });
  f.seed({ id: 'attachment', from: 'worker', to: 'leader', text: 'Review this evidence', resources: [resource], status: 'queued', createdAt: 1 });
  await f.ack(['attachment']);
  expect(f.snapshot().messages).toEqual([]);
  expect(f.snapshot().resourceGrants).toEqual([{ resourceId: 'zip', memberIds: ['leader'] }]);
});
