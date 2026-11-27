import { describe, expect, it } from 'vitest';
import { buildGroup, buildView, buildWindow } from '../test/window-builders.js';
import { mockScope, renderHook } from '../test/render-hook.js';
import { useBotRoster } from './useBotRoster.js';

const view = buildView('bot1');
const group = buildGroup(buildWindow([view]));
const binding = view.binding!;
const session = { ...binding, agentId: 'agent-bot1' };

function scopeOf(facts: Record<string, unknown> = {}) {
  return mockScope<typeof useBotRoster>({
    accessReady: true, canRead: true, activated: true, compactLayout: false, connections: { find: () => ({ agentId: 'agent-bot1' }), shown: (): boolean => true },
    currentBotSession: () => session, navigation: { rosterVisible: false }, selectedBot: { view, group, slot: 'slot' }, windowMode: false, windowWorkspace: { groups: [group] }, ...facts,
  });
}

describe('the bots Bot mode lists', () => {
  it('are the bots of the groups with bot details', async () => {
    const { result } = await renderHook(() => useBotRoster(scopeOf()));
    expect(result.current.botTargets.map(target => (target as { agentId?: string }).agentId)).toEqual(['agent-bot1']);
  });
  it.each([['Window mode', { windowMode: true }], ['a device holding no lease', { canRead: false }]])('are none in %s', async (_name, change) => {
    const { result } = await renderHook(() => useBotRoster(scopeOf(change)));
    expect(result.current.botTargets).toEqual([]);
  });
});

describe('the bots Bot mode lists while access is being confirmed', () => {
  it('are those the device holds, because listing needs no network', async () => {
    const { result } = await renderHook(() => useBotRoster(scopeOf({ accessReady: false, activated: false })));
    expect(result.current.botTargets.map(target => (target as { agentId?: string }).agentId)).toEqual(['agent-bot1']);
  });
});

describe('the bot Bot mode shows', () => {
  it('is the selected bot, once its conversation is connected and shown', async () => {
    const { result } = await renderHook(() => useBotRoster(scopeOf()));
    expect(result.current.botBinding).toBe(binding);
    expect(result.current.visibleBots.map(bot => (bot as { agentId?: string }).agentId)).toEqual(['agent-bot1']);
  });
  it.each([
    ['Window mode', { windowMode: true }], ['restoring access', { accessReady: false }], ['no selected slot', { selectedBot: { view, group, slot: undefined } }],
    ['no connection', { connections: { find: () => undefined, shown: (): boolean => true } }], ['a conversation not shown', { connections: { find: () => ({ agentId: 'a' }), shown: (): boolean => false } }],
    ['a selected bot the roster does not list', { selectedBot: { view: buildView('other'), group, slot: 'slot' }, currentBotSession: (_window: string, viewId: string, bound: object) => ({ ...bound, agentId: `agent-${viewId}` }) }],
  ])('is none for %s', async (_name, change) => {
    const { result } = await renderHook(() => useBotRoster(scopeOf(change)));
    expect(result.current.visibleBots).toEqual([]);
  });
  it('is none on a compact layout while the roster is open, and shown once it closes', async () => {
    const open = await renderHook(() => useBotRoster(scopeOf({ compactLayout: true, navigation: { rosterVisible: true } })));
    const closed = await renderHook(() => useBotRoster(scopeOf({ compactLayout: true, navigation: { rosterVisible: false } })));
    expect(open.result.current.visibleBots).toEqual([]);
    expect(closed.result.current.visibleBots).toHaveLength(1);
  });
  it('keeps one set of sessions eligible for notifications across renders', async () => {
    const { result, rerender } = await renderHook(() => useBotRoster(scopeOf()));
    const first = result.current.latestEligible;
    await rerender();
    expect(result.current.latestEligible).toBe(first);
  });
});
