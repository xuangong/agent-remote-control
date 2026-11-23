import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { createWindowView, type Team, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { emptyRelayState, validateRelayState, type HostedRelayState } from './state.js';
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

it('loads state that holds an ordinary Team without it, its views plain, and keeps the Teams bots are delivered through', () => {
  const loaded = validateRelayState(state([ordinary, inbox], { bots: { rank: 'm', members: {} } }), auth);
  expect(loaded.tenants[0]!.broker.teams!.map(item => item.id)).toEqual(['inbox']);
  const views = loaded.workspaceWindows![0]!.window!.views;
  expect(views.every(view => view.feature === undefined && view.bindingPolicy === undefined)).toBe(true);
  expect(views.map(view => view.binding?.nativeSessionId)).toEqual(['native-lead', 'native-a']);
  expect(loaded.bots ?? []).toEqual([]);
  expect(validateRelayState(structuredClone(loaded), auth)).toEqual(loaded);
});

it('tells an ordinary Team from the Teams a bot is delivered through', () => {
  expect(isOrdinaryTeam(ordinary)).toBe(true);
  expect(isOrdinaryTeam(inbox)).toBe(false);
  expect(isOrdinaryTeam(team('task', ordinary.members, { task: {} as never }))).toBe(false);
});

it('drops the file transfers of a Team an older Relay saved, and loads it unchanged afterwards', () => {
  const file = { resourceId: 'r1', name: 'notes.txt', mediaType: 'text/plain', byteLength: 3, sha256: 'a'.repeat(64) };
  const message = { id: 'm1', from: 'bot', to: 'bot', text: 'hello', status: 'queued', createdAt: 1, resources: [file] };
  const saved = { ...inbox, messages: [message], resourceUploads: [{ ownerMemberId: 'bot', expiresAt: 9, resource: file }], resourceGrants: [{ resourceId: 'r1', memberIds: ['bot'] }] };
  const loaded = validateRelayState(state([saved as unknown as Team]), auth);
  const kept = loaded.tenants[0]!.broker.teams![0]! as unknown as Record<string, unknown>;
  expect(kept).not.toHaveProperty('resourceUploads');
  expect(kept).not.toHaveProperty('resourceGrants');
  expect(kept.messages).toEqual([{ id: 'm1', from: 'bot', to: 'bot', text: 'hello', status: 'queued', createdAt: 1 }]);
  expect(validateRelayState(structuredClone(loaded), auth)).toEqual(loaded);
});

it('drops the tag and managed binding of a view that showed a TPM work, and the view stays a plain session', () => {
  const loaded = state([inbox]); const window = loaded.workspaceWindows![0]!.window!;
  window.views[1] = { ...window.views[1]!, feature: { kind: 'tpm', id: 'work-1', metadata: { hostId: 'mac' } }, bindingPolicy: 'managed' };
  const migrated = validateRelayState(loaded, auth).workspaceWindows![0]!.window!.views;
  expect(migrated.every(view => view.feature === undefined && view.bindingPolicy === undefined)).toBe(true);
  expect(migrated[1]!.binding?.nativeSessionId).toBe('native-a');
});
