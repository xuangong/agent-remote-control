import { expect, it } from 'vitest';
import { createWindowView, type WorkspaceWindow } from '@orchardworks/agent-remote-protocol';
import { createRelayState, emptyRelayState } from './state.js';
import { createWindowWorkspaces } from './window-workspaces.js';

const auth = { origin: 'https://relay.example', issuer: 'https://gateway.example', secret: 'window-bots-test-secret-0123456789' };
const view = (id: string, nativeSessionId: string) => createWindowView(id, { hostId: 'host', providerId: 'claude', nativeSessionId, title: nativeSessionId }, 'primary');
const window = (id: string, views: ReturnType<typeof view>[]): WorkspaceWindow => ({ schemaVersion: 3, id, title: id, revision: 0, selectedPrimaryViewId: views[0]?.id ?? null, selectedViewId: views[0]?.id ?? null, views });

async function fixture() {
  let clock = 1_000;
  const state = createRelayState(auth, { initial: emptyRelayState(auth), async commit() {} }, () => {}, () => {});
  const service = createWindowWorkspaces(state, () => true, () => clock);
  const me = { subject: 'me' };
  const create = (id: string, members: Record<string, Record<string, unknown>>) => service.create(me, { operationId: `create-${id}`, issuedAt: clock,
    window: window(id, Object.keys(members).map(viewId => view(viewId, `${id}-${viewId}`))), bots: { rank: id === 'a' ? 'm' : 'n', members } });
  let n = 0;
  const change = (id: string, operation: unknown) => service.mutate(me, id, { operationId: `op-${++n}`, issuedAt: clock, baseRevision: service.inspect(me, id).window.revision, operation });
  const member = (id: string, viewId: string) => service.list(me).groups.find(group => group.window.id === id)!.bots!.members[viewId]!;
  return { state, service, me, create, change, member, tick: () => { clock += 1_000; } };
}

it('keeps who a bot is in its record and serves its details merged, through edits that do not touch it', async () => {
  const f = await fixture();
  await f.create('a', { v1: { name: 'Chief', mission: 'Coordinate the release.', pinned: true } });
  const botId = f.member('a', 'v1').botId!;
  expect(f.member('a', 'v1')).toEqual({ botId, name: 'Chief', mission: 'Coordinate the release.', pinned: true });
  // The group stores placement and the id; the record holds the rest.
  expect(f.state.read().workspaceWindows![0]!.bots!.members.v1).toEqual({ botId, pinned: true });
  expect(f.state.read().bots).toEqual([expect.objectContaining({ subject: 'me', botId, name: 'Chief', mission: 'Coordinate the release.' })]);
  await f.change('a', { type: 'section.rank', rank: 'p' });
  expect(f.member('a', 'v1')).toMatchObject({ botId, name: 'Chief', mission: 'Coordinate the release.' });
  // A page that writes details without the id keeps the same bot.
  await f.change('a', { type: 'bot.update', viewId: 'v1', details: { name: 'Chief', label: 'Lead' } });
  expect(f.member('a', 'v1')).toEqual({ botId, name: 'Chief', label: 'Lead' });
});

it('keeps a bot\'s id when it moves to another group, and retires it when it leaves every group', async () => {
  const f = await fixture();
  await f.create('a', { v1: { name: 'Chief' } });
  await f.create('b', { v2: { name: 'Other' } });
  const botId = f.member('a', 'v1').botId!;
  const transfer = await f.service.transfer(f.me, 'a', { operationId: 'move', issuedAt: 1_000, baseRevision: f.service.inspect(f.me, 'a').window.revision,
    target: 'b', targetRevision: f.service.inspect(f.me, 'b').window.revision, viewId: 'v1' });
  expect(transfer.result.status).toBe('committed');
  expect(f.member('b', 'v1')).toMatchObject({ botId, name: 'Chief' });
  expect(f.state.read().bots!.find(bot => bot.botId === botId)!.retiredAt).toBeUndefined();
  f.tick();
  await f.change('b', { type: 'bots.remove' });
  expect(f.state.read().bots!.find(bot => bot.botId === botId)!.retiredAt).toBe(2_000);
});

it('keeps a bot\'s memory in its record beside the mission, and moves its chief when asked, which an edit of the details cannot do', async () => {
  const f = await fixture();
  const memory = [{ id: 'f0a1b2c3d', text: 'Releases ship on Thursdays.' }];
  await f.create('a', { v1: { name: 'Chief' }, v2: { name: 'Tracker', mission: 'Track it.', memory } });
  const [chief, tracker] = [f.member('a', 'v1').botId!, f.member('a', 'v2').botId!];
  expect(f.state.read().workspaceWindows![0]!.bots!.members.v2).toEqual({ botId: tracker });
  expect(f.state.read().bots!.find(bot => bot.botId === tracker)).toMatchObject({ mission: 'Track it.', memory });
  expect(f.member('a', 'v2')).toMatchObject({ mission: 'Track it.', memory });
  const before = f.service.inspect(f.me, 'a').window.revision;
  await f.service.setBotChief(f.me, tracker, chief);
  expect(f.member('a', 'v2')).toMatchObject({ chief, memory });
  expect(f.service.inspect(f.me, 'a').window.revision).toBe(before + 1);
  // An edit that names another chief, or none, leaves the chief where it is.
  await f.change('a', { type: 'bot.update', viewId: 'v2', details: { name: 'Tracker', mission: 'Track it.', chief: tracker } });
  expect(f.member('a', 'v2').chief).toBe(chief);
  await f.service.setBotChief(f.me, tracker, null);
  expect(f.member('a', 'v2').chief).toBeUndefined();
  await expect(f.service.setBotChief(f.me, tracker, 'b_' + '9'.repeat(32))).rejects.toThrow('no longer exists');
  await f.change('a', { type: 'bot.update', viewId: 'v2', details: { name: 'Tracker', mission: 'Track it.' } });
  expect(f.member('a', 'v2').memory).toBeUndefined();
});

it('marks at most one bot as primary, replaces the mark in one write, and refuses a bot that reports to another bot; an edit of the details cannot set it', async () => {
  const f = await fixture();
  await f.create('a', { v1: { name: 'Chief' }, v2: { name: 'Tracker' }, v3: { name: 'Scout' } });
  const [chief, tracker, scout] = ['v1', 'v2', 'v3'].map(viewId => f.member('a', viewId).botId!);
  await f.service.setBotChief(f.me, tracker, chief);
  const before = f.service.inspect(f.me, 'a').window.revision;
  await f.service.setBotPrimary(f.me, chief, true);
  expect(f.member('a', 'v1').primary).toBe(true);
  expect(f.service.inspect(f.me, 'a').window.revision).toBe(before + 1);
  // The group keeps placement only.
  expect(f.state.read().workspaceWindows![0]!.bots!.members.v1).toEqual({ botId: chief });
  await f.service.setBotPrimary(f.me, scout, true);
  expect(['v1', 'v2', 'v3'].map(viewId => f.member('a', viewId).primary)).toEqual([undefined, undefined, true]);
  await expect(f.service.setBotPrimary(f.me, tracker, true)).rejects.toThrow('Only a bot that reports to you can be primary.');
  await expect(f.service.setBotPrimary(f.me, 'b_' + '9'.repeat(32), true)).rejects.toThrow('no longer exists');
  await f.change('a', { type: 'bot.update', viewId: 'v1', details: { name: 'Chief', primary: true } });
  expect(['v1', 'v3'].map(viewId => f.member('a', viewId).primary)).toEqual([undefined, true]);
  await f.service.setBotPrimary(f.me, scout, false);
  expect(f.member('a', 'v3').primary).toBeUndefined();
  // Moving the primary bot under another bot clears the mark: only a bot that reports to the person is primary.
  await f.service.setBotPrimary(f.me, scout, true);
  await f.service.setBotChief(f.me, scout, chief);
  expect(f.member('a', 'v3')).toMatchObject({ chief });
  expect(f.member('a', 'v3').primary).toBeUndefined();
});
