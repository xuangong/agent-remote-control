import { expect, it } from 'vitest';
import { TeamBroker } from './teams.js';
import { committed, detached } from './drafts.js';
import { compactTeamDeliveries, deliveryFingerprint, teamNeedsCompaction, teamStateBytes, type SavedTeam } from './team-delivery.js';

const day = 24 * 60 * 60 * 1000;
function team(id: string, messages: SavedTeam['messages'] = [], extra: Partial<SavedTeam> = {}): SavedTeam {
  const member = (memberId: string, role: 'leader' | 'member') => ({ id: memberId, hostId: 'host', providerId: 'codex', nativeSessionId: `${id}-${memberId}`,
    role, name: memberId, responsibility: '', creation: 'ready' as const, activity: 'idle' as const, summary: '', updatedAt: 1 });
  return { id, operationId: id, revision: 1, source: { hostId: 'host', providerId: 'codex', nativeSessionId: `${id}-source`, title: 'Source' }, title: 'Team',
    status: 'active', createdAt: 1, updatedAt: 1, members: [member('leader', 'leader'), member('helper', 'member')], messages, ...extra };
}
const message = (id: string, status: SavedTeam['messages'][number]['status'], extra: object = {}) => ({ id, from: 'leader', to: 'helper', text: `text ${id}`, status, createdAt: 1, ...extra });
const receipt = (id: string, settledAt: number, extra: object = {}) => ({ id, from: 'leader', to: 'helper', status: 'accepted' as const, acceptance: 'handled' as const, createdAt: 1,
  fingerprint: deliveryFingerprint({ to: 'helper', text: id }), settledAt, ...extra });

it('reports exactly the Teams that compaction changes', () => {
  const now = 10 * day;
  const cases: Array<[SavedTeam, boolean]> = [
    [team('empty'), false],
    [team('queued', [message('q', 'queued')]), false],
    [team('dispatching', [message('d', 'dispatching')]), false],
    [team('settled', [message('s', 'accepted', { acceptance: 'handled' })]), true],
    [team('recent receipt', [], { deliveryReceipts: [receipt('r', now - 1000)] }), false],
    [team('expired receipt', [], { deliveryReceipts: [receipt('r', now - 2 * day)] }), true],
    [team('unresolved receipt', [], { deliveryReceipts: [receipt('u', now - 2 * day, { status: 'unknown', acceptance: undefined })] }), false],
    [team('empty receipts', [], { deliveryReceipts: [] }), true],
    [team('repeated receipt', [], { deliveryReceipts: [receipt('r', now - 1000), receipt('r', now - 500)] }), true],
    [team('too many receipts', [], { deliveryReceipts: Array.from({ length: 201 }, (_, index) => receipt(`r${index}`, now - 1000)) }), true],
    [team('large receipts', [], { deliveryReceipts: Array.from({ length: 120 }, (_, index) => receipt(`r${index}-${'x'.repeat(200)}`, now - 1000)) }), true],
  ];
  for (const [saved, changes] of cases) {
    const compacted = structuredClone(saved); compactTeamDeliveries(compacted, now);
    expect({ team: saved.id, changes: teamNeedsCompaction(saved, now) }).toEqual({ team: saved.id, changes });
    if (!changes) expect(JSON.stringify(compacted)).toBe(JSON.stringify(saved));
    else expect(JSON.stringify(compacted)).not.toBe(JSON.stringify(saved));
  }
});

it('a Team change copies, compacts and measures only the Teams it touches', async () => {
  let state: SavedTeam[] = committed.produce(Array.from({ length: 200 }, (_, index) => team(`team-${index}`, [message(`m-${index}`, 'queued')])), () => {});
  let now = 1000;
  const broker = new TeamBroker({ resolveSession: (hostId, providerId, nativeSessionId) => ({ controllerId: hostId, providerId, nativeSessionId }),
    read: () => state, now: () => ++now, assertHost: () => {}, createSeat: async () => { throw new Error('No seats.'); },
    // As the Relay broker changes Teams: copy-on-write, so unchanged Teams stay the committed objects.
    change: async update => { let value: unknown; state = committed.produce(state, teams => { value = structuredClone(detached(update(teams))); }); return value as never; } });
  const before = state;
  await broker.hostCall('host', { action: 'send', teamId: 'team-7', memberId: 'leader', to: 'helper', operationId: 'send-7', text: 'Inspect the logs.' });
  expect(state).not.toBe(before);
  expect(state.filter((saved, index) => saved !== before[index]).map(saved => saved.id)).toEqual(['team-7']);
  expect(state[7]!.messages.map(item => item.text)).toEqual(['text m-7', 'Inspect the logs.']);
  expect(teamStateBytes(state)).toBe(Buffer.byteLength(JSON.stringify(state)));
  // A settled message moves to a receipt in the same change, in that Team only.
  await broker.hostCall('host', { action: 'claim', teamId: 'team-9', memberId: 'helper', messageId: 'm-9' });
  await broker.hostCall('host', { action: 'settle', teamId: 'team-9', memberId: 'helper', messageId: 'm-9', outcome: 'accepted', acceptance: 'handled' });
  expect(state[9]!.messages).toEqual([]);
  expect(state[9]!.deliveryReceipts?.map(item => item.id)).toEqual(['m-9']);
  expect(state.filter((saved, index) => saved !== before[index]).map(saved => saved.id)).toEqual(['team-7', 'team-9']);
});
