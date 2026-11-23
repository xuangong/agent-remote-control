import { expect, it } from 'vitest';
import { isTeam, type NativeSessionRef, type Team } from '@orchardworks/agent-remote-protocol';
import { TeamBroker } from './teams.js';
import { createHostBroker } from './broker.js';
import { validSavedTeam, deliveryFingerprint, trimTeamDeliveryReceipts, teamMessageBudgetBytes, teamBytes, type SavedTeam } from './team-delivery.js';

/** A Team seeded in the Relay's state, as its Controller sees it: two ready seats and the queue between them. */
function fixture() {
  let state: SavedTeam[] = [], now = 100, counter = 0;
  const ports: ConstructorParameters<typeof TeamBroker>[0] = { resolveSession: (hostId, providerId, nativeSessionId) => ({ controllerId: hostId, providerId, nativeSessionId }),
    read: () => state, now: () => ++now, assertHost: () => {},
    change: async update => { const draft = structuredClone(state); const result = structuredClone(update(draft)); state = draft; return result; },
    createSeat: async () => { throw new Error('Unexpected seat creation.'); } };
  const broker = new TeamBroker(ports);
  const seat = (id: string, hostId: string, role: 'leader' | 'member', providerId: string) => ({ id, hostId, providerId, nativeSessionId: `native-${id}`, role, name: id, responsibility: '',
    creation: 'ready' as const, activity: 'idle' as const, summary: '', updatedAt: 1 });
  const saved: SavedTeam = { id: 'team', operationId: 'create', revision: 1, source: { hostId: 'mac', providerId: 'codex', nativeSessionId: 'main', title: 'Project' }, title: 'Team', status: 'active',
    members: [seat('lead', 'mac', 'leader', 'codex'), seat('work', 'win', 'member', 'claude')], messages: [], createdAt: 1, updatedAt: 1 };
  state = [saved];
  return { broker, ports, team: saved, leader: saved.members[0]!, worker: saved.members[1]!, snapshot: () => structuredClone(state), seed: (teams: SavedTeam[]) => { state = structuredClone(teams); },
    restart: () => new TeamBroker(ports),
    /** The Relay's own queueing: a message waits for its recipient. */
    enqueue(text = 'Inspect', to = 'work', from = 'lead') {
      const id = `m-${++counter}`; state[0]!.messages.push({ id, from, to, text, status: 'queued', createdAt: 1 }); return id;
    } };
}

it('restricts Host calls to the exact registered Host and member', async () => {
  const { broker, team, worker } = fixture();
  await expect(broker.hostCall('intruder', { action: 'read', teamId: team.id, memberId: worker.id })).rejects.toThrow('registered');
  await expect(broker.hostCall('win', { action: 'read', teamId: team.id, memberId: 'missing' })).rejects.toThrow('not found');
});

it('keeps unknown native delivery unresolved after the claim', async () => {
  const f = fixture(), id = f.enqueue();
  const claim = { teamId: f.team.id, memberId: f.worker.id, messageId: id };
  await f.broker.hostCall('win', { action: 'claim', ...claim });
  await expect(f.broker.hostCall('win', { action: 'claim', ...claim })).rejects.toThrow('claimed');
  await f.broker.hostCall('win', { action: 'settle', ...claim, outcome: 'unknown' });
  expect(f.snapshot()[0]!.messages[0]).toMatchObject({ id, status: 'unknown' });
  expect(f.broker.hasUnsettledRecipient({ controllerId: 'win', providerId: 'claude', nativeSessionId: f.worker.nativeSessionId! })).toBe(true);
});

it('releases both count and byte capacity after successful or rejected delivery', async () => {
  const f = fixture();
  for (let i = 0; i < 220; i++) {
    const id = f.enqueue('x'.repeat(8000)), target = { teamId: f.team.id, memberId: f.worker.id, messageId: id };
    await f.broker.hostCall('win', { action: 'claim', ...target });
    await f.broker.hostCall('win', { action: 'settle', ...target, outcome: i % 2 ? 'rejected' : 'accepted', ...(i % 2 ? { error: 'Native refused input.' } : { acceptance: 'started' as const }) });
    expect(f.broker.list()[0]!.messages.some(item => item.id === id)).toBe(false);
  }
  expect(validSavedTeam(f.snapshot()[0])).toBe(true);
  expect(isTeam(f.broker.list()[0])).toBe(true);
  expect(JSON.stringify(f.snapshot()).length).toBeLessThan(36000);
  expect(f.broker.list()[0]!.messages).toHaveLength(0);
});

it('deduplicates late receipts across a broker restart without retaining the body', async () => {
  const f = fixture(), text = 'A private delivery body.', id = f.enqueue(text);
  const target = { teamId: f.team.id, memberId: f.worker.id, messageId: id };
  await f.broker.hostCall('win', { action: 'claim', ...target });
  await f.broker.hostCall('win', { action: 'settle', ...target, outcome: 'rejected', error: 'Permission denied.' });
  expect(JSON.stringify(f.snapshot())).not.toContain(text);
  const restored = f.restart();
  expect(await restored.hostCall('win', { action: 'settle', ...target, outcome: 'rejected' })).toMatchObject({ id, status: 'rejected' });
  await expect(restored.hostCall('mac', { action: 'settle', ...target, memberId: f.leader.id, outcome: 'accepted' })).rejects.toThrow('addressed');
  expect(restored.list()[0]!.messages.some(item => item.id === id)).toBe(false);
});

it('compacts old settled bodies on broker restore before any client or Host request', async () => {
  const f = fixture(), team = f.snapshot()[0]!;
  team.messages = [{ id: 'old', from: 'lead', to: 'work', text: 'Legacy settled body', status: 'rejected', createdAt: 1 },
    { id: 'unknown', from: 'lead', to: 'work', text: 'Uncertain input', status: 'unknown', createdAt: 2 }];
  const broker = createHostBroker({ origin: 'https://relay.example', initialState: { keys: [], hosts: [], bindings: [], creations: [], teams: [team] } });
  try {
    const saved = broker.snapshot().teams![0]!;
    expect(saved.messages.map(message => message.id)).toEqual(['unknown']);
    expect(JSON.stringify(saved)).not.toContain('Legacy settled body');
    expect(validSavedTeam(saved)).toBe(true);
  } finally { await broker.close(); }
});

it('trims a Team\'s oldest retry receipts when it reaches its bound, without discarding queued work', () => {
  const f = fixture(), id = f.enqueue('Inspect');
  const team: SavedTeam = { ...f.snapshot()[0]!, messages: [{ id, from: 'lead', to: 'work', text: 'Inspect', status: 'queued', createdAt: 1 }],
    deliveryReceipts: Array.from({ length: 3 }, (_, index) => ({ id: `r${index}`, from: 'lead', to: 'work', status: 'rejected' as const, createdAt: 1, settledAt: 1 + index,
      fingerprint: deliveryFingerprint({ to: 'work', text: `r${index}` }), error: 'e'.repeat(2000) })) };
  trimTeamDeliveryReceipts(team, teamBytes(team) - 100);
  expect(team.deliveryReceipts?.map(receipt => receipt.id)).not.toContain('r0');
  expect(team.messages).toHaveLength(1);
  trimTeamDeliveryReceipts(team, 1);
  expect(team.deliveryReceipts ?? []).toEqual([]);
  expect(team.messages).toHaveLength(1);
});

it('projects every Team response through the current recipient and pins claim evidence across compaction', async () => {
  const f = fixture(), anchor = f.worker.nativeSessionId!;
  const recipient: NativeSessionRef = { controllerId: 'controller-win', providerId: f.worker.providerId, nativeSessionId: 'B' };
  f.ports.resolveSession = (hostId, providerId, nativeSessionId) => ({ controllerId: `controller-${hostId}`, providerId, nativeSessionId: nativeSessionId === anchor ? recipient.nativeSessionId : nativeSessionId });
  const id = f.enqueue('Inspect once'), claim = { teamId: f.team.id, memberId: f.worker.id, messageId: id };
  for (const result of [f.broker.list()[0], await f.broker.hostCall('win', { action: 'read', teamId: f.team.id, memberId: f.worker.id })] as Team[]) expect(result.members[1]!.nativeSessionId).toBe('B');
  expect(f.snapshot()[0]!.members[1]!.nativeSessionId).toBe(anchor);
  await expect(f.broker.hostCall('win', { action: 'claim', ...claim })).rejects.toThrow(/recipient|moved/);
  await expect(f.broker.hostCall('win', { action: 'claim', ...claim, expectedNativeSessionId: anchor })).rejects.toThrow(/recipient/);
  const claimed = await f.broker.hostCall('win', { action: 'claim', ...claim, expectedNativeSessionId: 'B' });
  expect(claimed).toMatchObject({ status: 'dispatching', resolvedTarget: recipient });
  expect(f.broker.hasUnsettledRecipient(recipient)).toBe(true);
  await expect(f.broker.hostCall('win', { action: 'settle', ...claim, outcome: 'accepted', resolvedTarget: { ...recipient, nativeSessionId: 'other' } })).rejects.toThrow(/recipient/);
  await f.broker.hostCall('win', { action: 'settle', ...claim, outcome: 'accepted', acceptance: 'queued', resolvedTarget: recipient });
  expect(f.broker.hasUnsettledRecipient(recipient)).toBe(true);
  await f.broker.hostCall('win', { action: 'settle', ...claim, outcome: 'accepted', acceptance: 'started', resolvedTarget: recipient });
  expect(f.broker.hasUnsettledRecipient(recipient)).toBe(false);
  expect(validSavedTeam(f.snapshot()[0])).toBe(true);
  f.ports.resolveSession = () => { throw new Error('Generic succession unavailable'); };
  expect(f.broker.list()[0]!.members[1]!.nativeSessionId).toBeUndefined();
  expect(isTeam(f.broker.list()[0])).toBe(true);
  expect(validSavedTeam(f.broker.list()[0])).toBe(false);
  const queued = f.enqueue('Wait');
  await expect(f.broker.hostCall('win', { action: 'claim', teamId: f.team.id, memberId: f.worker.id, messageId: queued, expectedNativeSessionId: 'C' })).rejects.toThrow('unavailable');
  expect(f.snapshot()[0]!.messages.find(message => message.id === queued)!.status).toBe('queued');
});

it('keeps recipient evidence outside the pending input budget while persisting valid claims', async () => {
  const f = fixture(), nativeSessionId = '￿'.repeat(512);
  f.ports.resolveSession = (_host, providerId) => ({ controllerId: '￿'.repeat(512), providerId, nativeSessionId });
  const ids = Array.from({ length: 8 }, () => f.enqueue('x'.repeat(16000)));
  for (const messageId of ids) {
    await f.broker.hostCall('win', { action: 'claim', teamId: f.team.id, memberId: f.worker.id, messageId, expectedNativeSessionId: nativeSessionId });
    expect(teamMessageBudgetBytes(f.snapshot()[0]!)).toBeLessThanOrEqual(128 * 1024);
    expect(validSavedTeam(f.snapshot()[0]!)).toBe(true);
  }
  expect(Buffer.byteLength(JSON.stringify(f.snapshot()[0]!.messages))).toBeGreaterThan(128 * 1024);
});

it('limits legacy unresolved recipient blockers to the owning Controller when its anchor route is unavailable', () => {
  const f = fixture(), state = f.snapshot();
  state[0]!.messages.push({ id: 'legacy', from: f.leader.id, to: f.worker.id, text: 'Unknown effect', status: 'unknown', createdAt: 1 });
  f.seed(state);
  f.ports.resolveSession = (hostId, providerId, nativeSessionId) => {
    if (nativeSessionId === f.worker.nativeSessionId) throw new Error('Unavailable legacy route');
    return { controllerId: hostId, providerId, nativeSessionId };
  };
  expect(f.broker.hasUnsettledRecipient({ controllerId: 'other', providerId: 'claude', nativeSessionId: 'other-session' })).toBe(false);
  expect(f.broker.hasUnsettledRecipient({ controllerId: 'win', providerId: 'claude', nativeSessionId: 'current-session' })).toBe(true);
});

it('retains legacy compact uncertainty through expiry, count and shared storage pressure', async () => {
  const f = fixture(), team = f.snapshot()[0]!;
  const receipt = { id: 'legacy', from: f.leader.id, to: f.worker.id, status: 'accepted' as const, createdAt: 1, settledAt: 1, fingerprint: deliveryFingerprint({ to: f.worker.id, text: 'Original private body' }) };
  team.deliveryReceipts = [receipt];
  expect(validSavedTeam(team)).toBe(true);
  expect(validSavedTeam({ ...team, unresolvedReceipts: [{ id: receipt.id, from: receipt.from, to: receipt.to, status: receipt.status, createdAt: receipt.createdAt }] })).toBe(false);
  f.seed([team]);
  const restored = f.restart();
  for (let index = 0; index < 205; index++) {
    const id = f.enqueue('Unrelated input'), target = { teamId: team.id, memberId: f.worker.id, messageId: id };
    await restored.hostCall('win', { action: 'claim', ...target });
    await restored.hostCall('win', { action: 'settle', ...target, outcome: 'rejected' });
  }
  const saved = f.snapshot();
  expect(saved[0]!.deliveryReceipts!.find(item => item.id === receipt.id)).toEqual(receipt);
  expect(saved[0]!.deliveryReceipts!.length).toBeLessThan(200);
  trimTeamDeliveryReceipts(saved[0]!, 1);
  expect(saved[0]!.deliveryReceipts).toEqual([receipt]);
  expect(validSavedTeam(saved[0])).toBe(true);
  expect(JSON.stringify(saved)).not.toContain('Original private body');
});

it('requires recipient-aware participants before replacing a Team role and retains legacy unresolved evidence', () => {
  const f = fixture(); let supported = false;
  f.ports.assertRecipientSupport = hostId => { if (hostId === 'win' && !supported) throw new Error('Update the Controller'); };
  const target = { controllerId: 'win', providerId: 'claude', nativeSessionId: f.worker.nativeSessionId! };
  expect(() => f.broker.assertReplacementSupported(target, 'win')).toThrow('Update the Controller');
  supported = true; expect(() => f.broker.assertReplacementSupported(target, 'win')).not.toThrow();
  const saved = f.snapshot();
  saved[0]!.deliveryReceipts = [{ id: 'legacy', from: f.leader.id, to: f.worker.id, status: 'accepted', createdAt: 1, settledAt: 1, fingerprint: deliveryFingerprint({ to: f.worker.id, text: 'Old input' }) }];
  f.seed(saved); const restarted = f.restart();
  expect(restarted.hasUnsettledRecipient(target)).toBe(true);
  expect(() => restarted.list(false)).toThrow('Update the Controller');
  expect(restarted.hasUnsettledRecipient(target)).toBe(true);
  expect(f.snapshot()[0]!.deliveryReceipts).toEqual(saved[0]!.deliveryReceipts);
});
