import { describe, expect, it, vi } from 'vitest';
import type { Translate } from '@orchardworks/agent-client';
import { BotPicture } from '../../kernel/BotPicture.js';
import { buildGroup, buildView, buildWindow } from '../../test/window-builders.js';
import { buildHost, buildSessionViewContext } from '../../test/session-view-context.js';
import { replicaState } from '../../test/fixtures.js';
import { botWorking, identityContribution, type IdentityContributionInputs } from './identity.js';

const t = ((key: string) => key) as Translate;
const view = buildView('v1');
const sharedWindow = buildWindow([view]);
const group = buildGroup(sharedWindow);

function setup(overrides: Record<string, unknown> = {}, facts: Record<string, unknown> = {}) {
  const spies = { select: vi.fn(), revealEarlier: vi.fn(), bindDirectorySession: vi.fn(), openSession: vi.fn(), setSessionNotice: vi.fn(), operateGroup: vi.fn(async () => {}) };
  const inputs = {
    assistantNames: { view: (groupId: string, viewId: string) => `view:${groupId}/${viewId}`, session: () => 'session-name' },
    bindDirectorySession: spies.bindDirectorySession, favorites: {}, navigation: { select: spies.select }, openSession: spies.openSession, remoteHosts: [buildHost()],
    revealEarlier: spies.revealEarlier, setSessionNotice: spies.setSessionNotice, sharedWindow, succession: { historyNavigationFor: () => undefined }, supportTeams: new Set(),
    windowWorkspace: { readGroup: () => group, operateGroup: spies.operateGroup, groups: [] }, t, ...overrides,
  } as unknown as IdentityContributionInputs;
  const props = identityContribution(inputs)(buildSessionViewContext({ view, ...facts })).props!;
  return { props, details: props.details as Record<string, any>, ...spies };
}

describe('who answers in a session view', () => {
  it('names a Window view by its group, and a session in no Window by its session', () => {
    expect(setup().props.assistant?.name).toBe('view:W/v1');
    expect(setup({}, { view: undefined }).props.assistant?.name).toBe('session-name');
  });

  it('names a bot of Bot mode by its group and view, as a tile heading is not', () => {
    const { props } = setup({}, { botPresentation: true, options: { bot: { groupId: 'G', viewId: 'B' } } });
    expect(props.assistant?.name).toBe('view:G/B');
    expect(props.headingMode).toBe('assistant');
    expect(setup().props.headingMode).toBe('tile');
  });

  it('draws the picture of the view that works while the agent runs', () => {
    expect(botWorking(replicaState)).toBe(false);
    const running = { ...replicaState, agent: { ...replicaState.agent!, status: 'running' as const } };
    expect(botWorking(running)).toBe(true);
    expect(botWorking({ ...running, pendingInteractions: [{} as never] })).toBe(false);
    const { props, details } = setup({}, { context: { state: running } });
    expect(props.assistant?.avatar).toMatchObject({ type: BotPicture, props: { id: 'v1', mood: 'working' } });
    expect(details.mood).toBe('working');
  });

  it('says where the session works and which agents came before a handoff', () => {
    const chain = { predecessor: { providerId: 'claude', hostId: 'local' }, ancestors: [{ providerId: 'codex', hostId: 'local' }], history: false };
    const { details } = setup({ succession: { historyNavigationFor: () => chain } });
    expect(details.where).toEqual({ host: 'Mac', online: true, provider: 'Codex', earlier: ['Codex', 'claude'] });
    expect(setup().details.where.earlier).toEqual([]);
  });

  it('opens an earlier session where the view lives', async () => {
    const earlier = { providerId: 'codex', nativeSessionId: 'old', title: 'Old' } as never;
    const bot = setup({}, { botPresentation: true, options: { bot: { groupId: 'G', viewId: 'B' } } });
    expect(await bot.details.sessions.chain.open(earlier)).toBe(true);
    expect(bot.select).toHaveBeenCalledWith({ kind: 'session', session: { ...earlier as object, hostId: 'local' } });
    const tile = setup({}, { windowBot: true });
    await tile.details.sessions.chain.open(earlier);
    expect(tile.revealEarlier).toHaveBeenCalledWith('v1', earlier);
    const bound = setup();
    await bound.details.sessions.chain.open(earlier, 'history');
    expect(bound.bindDirectorySession).toHaveBeenCalledWith({ ...earlier as object, sessionIntent: 'history' }, { windowId: 'W', viewId: 'v1', binding: JSON.stringify(view.binding) });
    const alone = setup({}, { view: undefined });
    await alone.details.sessions.chain.open(earlier);
    expect(alone.openSession).toHaveBeenCalledWith(earlier, undefined, undefined, false, undefined, undefined);
  });

  it('offers opening the bot in Bot mode only when the view can', () => {
    const openBot = vi.fn();
    expect(setup({}, { openBot }).details.action).toMatchObject({ label: 'card.openInBot', onSelect: openBot });
    expect(setup().details).not.toHaveProperty('action');
  });

  it('renames a bot of a Window with its group', () => {
    const { details, operateGroup } = setup();
    details.rename('  Ada ');
    expect(operateGroup).toHaveBeenCalledWith('W', { type: 'bot.update', viewId: 'v1', details: { name: 'Ada' } });
    details.rename('   ');
    expect(operateGroup).toHaveBeenCalledTimes(1);
  });

  it('adds the bot details to a group that has none before it names the bot', () => {
    const readGroup = () => buildGroup(sharedWindow, { bots: false }), operateGroup = vi.fn(async (_id: string, _operation: object) => {});
    setup({ windowWorkspace: { readGroup, operateGroup, groups: [] } }).details.rename('Ada');
    expect(operateGroup.mock.calls[0]![1]).toMatchObject({ type: 'batch', operations: [{ type: 'bots.add' }, { type: 'bot.update', details: { name: 'Ada' } }] });
  });

  it('offers no rename in Bot mode, where the host names the bot', () => {
    expect(setup({}, { botPresentation: true, options: { bot: { groupId: 'G', viewId: 'B' } } }).details).not.toHaveProperty('rename');
  });

  it('stores the details of a bot of Bot mode with its group, and tells the owner when that fails', async () => {
    const operateGroup = vi.fn(async () => { throw new Error('offline'); }), setSessionNotice = vi.fn();
    const { props } = setup({ windowWorkspace: { readGroup: () => group, operateGroup, groups: [] }, setSessionNotice }, { botPresentation: true, options: { bot: { groupId: 'G', viewId: 'B' } } });
    props.processAssistant!.update({ picture: 'p' } as never);
    expect(operateGroup).toHaveBeenCalledWith('G', { type: 'bot.update', viewId: 'B', details: { picture: 'p' } });
    await Promise.resolve(); await Promise.resolve();
    expect(setSessionNotice).toHaveBeenCalled();
    expect(setup().props.processAssistant).toBeUndefined();
  });
});
