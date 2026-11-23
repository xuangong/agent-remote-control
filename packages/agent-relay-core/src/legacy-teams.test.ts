import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { createWindowView, type Team, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { emptyRelayState, validateRelayState, type HostedRelayState } from './state.js';
import { migrationBotId } from './bot-store.js';
import { isOrdinaryTeam } from './legacy-teams.js';

const auth = { origin: 'https://relay.example', issuer: 'https://issuer.example', secret: 'legacy-teams-test-secret-0123456789' };
const seat = (id: string, role: Team['members'][number]['role'], name: string, responsibility = '') => ({ id, role, name, responsibility, hostId: 'mac', providerId: 'claude',
  nativeSessionId: `native-${id}`, creation: 'ready' as const, activity: 'idle' as const, summary: '', updatedAt: 1 });
const team = (id: string, members: Team['members'], extra: Partial<Team> = {}): Team => ({ id, operationId: `op-${id}`, revision: 1, source: { hostId: 'mac', providerId: 'claude', nativeSessionId: 'main', title: 'Main' },
  title: `Team ${id}`, status: 'active', members, messages: [], createdAt: 1, updatedAt: 1, ...extra });
const ordinary = team('t1', [seat('lead', 'leader', 'Leader'), seat('a', 'member', 'Windows check', 'Verify on Windows'), seat('b', 'member', 'Never shown')]);
const inbox = team('inbox', [{ ...seat('bot', 'requester', 'Bot'), nativeSessionId: 'native-bot' }], { inbox: { botId: 'b_0123456789abcdef0123456789abcdef' } });
const teamView = (id: string, memberId: string, role: 'leader' | 'member') => ({ ...createWindowView(id, { hostId: 'mac', providerId: 'claude', nativeSessionId: `native-${memberId}`, title: memberId }, role === 'leader' ? 'primary' : 'dock'),
  feature: { kind: 'team', id: 't1', metadata: { role, memberId } }, bindingPolicy: 'managed' as const });
const group = (id: string): WorkspaceWindow => ({ schemaVersion: 3, id, title: id, revision: 1, selectedViewId: 'vl', selectedPrimaryViewId: 'vl',
  views: [createWindowView('vl', { hostId: 'mac', providerId: 'claude', nativeSessionId: 'native-lead', title: 'lead' }, 'primary'), teamView('va', 'a', 'member')] });
function state(teams: Team[], row: Record<string, unknown> = {}): HostedRelayState {
  const window = group('g1'); window.views[0] = teamView('vl', 'lead', 'leader');
  return { ...emptyRelayState(auth), workspaceWindows: [{ subject: 'owner', id: 'g1', generation: 0, receipts: [], window, ...row }],
    tenants: [{ subject: 'owner', namespace: createHash('sha256').update(JSON.stringify([auth.issuer, 'owner'])).digest('hex'),
      broker: { keys: [], bindings: [], creations: [], hosts: [{ id: 'mac', installationId: 'machine', name: 'Machine', providers: [{ providerId: 'claude', displayName: 'Claude' }], legacyDsh: false }], teams: teams as never } }] };
}

it('makes the Leader of an ordinary Team the chief of the members its group shows', () => {
  const loaded = validateRelayState(state([ordinary, inbox], { bots: { rank: 'm', members: {} } }), auth);
  expect(loaded.tenants[0]!.broker.teams!.map(item => item.id)).toEqual(['inbox']);
  const views = loaded.workspaceWindows![0]!.window!.views;
  expect(views.every(view => view.feature === undefined && view.bindingPolicy === undefined)).toBe(true);
  const chief = migrationBotId('owner', 'g1', 'vl'), staff = migrationBotId('owner', 'g1', 'va');
  expect(loaded.workspaceWindows![0]!.bots!.members).toEqual({ vl: { botId: chief }, va: { botId: staff } });
  expect(loaded.bots).toHaveLength(2);
  expect(loaded.bots!.find(bot => bot.botId === chief)).toMatchObject({ subject: 'owner', name: 'Team t1', chief: { kind: 'person' }, lifetime: 'standing' });
  expect(loaded.bots!.find(bot => bot.botId === staff)).toMatchObject({ name: 'Windows check', mission: 'Verify on Windows', chief: { kind: 'bot', botId: chief } });
  // The member the group never showed stays a plain session: it is nowhere in the bots.
  expect(JSON.stringify(loaded)).not.toContain('"native-b"');
});

it('migrates a group without a section, and once: the loaded state loads unchanged', () => {
  const loaded = validateRelayState(state([ordinary]), auth);
  expect(loaded.workspaceWindows![0]!.bots!.members).toEqual({ vl: { botId: migrationBotId('owner', 'g1', 'vl') }, va: { botId: migrationBotId('owner', 'g1', 'va') } });
  expect(validateRelayState(structuredClone(loaded), auth)).toEqual(loaded);
});

it('keeps the bot a Team session already was, and gives it its chief', () => {
  const loaded = validateRelayState(state([ordinary], { bots: { rank: 'm', members: { va: { name: 'Mine', mission: 'My own' } } } }), auth);
  const records = loaded.bots!;
  expect(records.find(bot => bot.botId === loaded.workspaceWindows![0]!.bots!.members.va!.botId)).toMatchObject({ name: 'Mine', mission: 'My own', chief: { kind: 'bot' } });
});

it('only tags the views of a group that is hidden in Bot mode', () => {
  const loaded = validateRelayState(state([ordinary], { presentation: { bots: false } }), auth);
  expect(loaded.workspaceWindows![0]!.window!.views.every(view => view.feature === undefined)).toBe(true);
  expect(loaded.bots ?? []).toEqual([]);
});

it('tells an ordinary Team from the Teams a bot is delivered through', () => {
  expect(isOrdinaryTeam(ordinary)).toBe(true);
  expect(isOrdinaryTeam(inbox)).toBe(false);
  expect(isOrdinaryTeam({ ...ordinary, link: { assistants: ['a', 'b'], recent: [] } })).toBe(false);
});
