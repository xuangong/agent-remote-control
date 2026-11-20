import { expect, it } from 'vitest';
import { createWindowView, type WindowGroup } from '@orchardworks/agent-remote-protocol';
import { botPlaceForTile, parseWorkbenchRoute, windowRouteForPin, writeWorkbenchRoute, windowRouteFields } from './workbench-mode.js';
it('parses explicit Bot locators and gives ordinary Window/session links precedence', () => {
  expect(parseWorkbenchRoute(new URL('https://test/?mode=bot&section=s&bot=v'))).toEqual({ mode: 'bot', place: { kind: 'bot', groupId: 's', viewId: 'v' } });
  expect(parseWorkbenchRoute(new URL('https://test/?mode=bot&section=s'))).toEqual({ mode: 'bot', place: { kind: 'section', groupId: 's' } });
  expect(parseWorkbenchRoute(new URL('https://test/?window=w'))).toEqual({ mode: 'window' });
  expect(parseWorkbenchRoute(new URL('https://test/?host=h&provider=p&session=s'))).toEqual({ mode: 'window' });
  expect(parseWorkbenchRoute(new URL('https://test/?debug=1'))).toBeUndefined();
});
it('writes one route while preserving unrelated parameters and hashes', () => {
  const initial = new URL('https://test/?debug=1&window=w&host=old&provider=p&session=old&parent=x&agent=a&intent=history&keepOriginal=1#trace');
  const url = writeWorkbenchRoute(initial, 'bot', { kind: 'bot', groupId: 's', viewId: 'v' });
  expect(url.search).toBe('?debug=1&mode=bot&section=s&bot=v'); expect(url.hash).toBe('#trace');
  const fallback = writeWorkbenchRoute(url, 'bot', { kind: 'session', session: { hostId: 'h', providerId: 'p', nativeSessionId: 'n', title: 'Title', agentId: 'secret' } });
  expect(fallback.search).toBe('?debug=1&mode=bot&host=h&provider=p&session=n');
  expect(writeWorkbenchRoute(fallback, 'window', undefined, { window: 'w' }).search).toBe('?debug=1&window=w');
});
it('captures only Window navigation fields', () => {
  expect(windowRouteFields(new URL('https://test/?window=w&host=h&debug=1&mode=bot&section=s&bot=v'))).toEqual({ window: 'w', host: 'h' });
});

// Moving between the modes keeps your place (I3 plan, section 4.4): the place of a tile in Bot mode, the Window a pin shows.
const binding = (id: string) => ({ hostId: 'host', providerId: 'claude', nativeSessionId: id, title: id });
const group = (extra: Partial<WindowGroup> = {}): WindowGroup => ({ window: { schemaVersion: 3, id: 'g', revision: 0, title: 'G', selectedPrimaryViewId: 'a', selectedViewId: 'a',
  views: [createWindowView('a', binding('a'), 'primary'), { ...createWindowView('ask', binding('ask'), 'dock'), feature: { kind: 'ask', id: 'ask-1' }, closeWith: 'a' },
    createWindowView('history', { ...binding('old'), sessionIntent: 'history' }, 'dock'), createWindowView('empty')] }, ...extra });
const PLACE_VECTORS: ReadonlyArray<readonly [string, WindowGroup, string, ReturnType<typeof botPlaceForTile>]> = [
  ['a tile of a group with a Bot section', group({ bots: { rank: 'm', members: {} } }), 'a', { place: { kind: 'bot', groupId: 'g', viewId: 'a' } }],
  ['a tile of a group without one adds it', group(), 'a', { place: { kind: 'bot', groupId: 'g', viewId: 'a' }, edit: { type: 'bots.add', rank: 'r' } }],
  ['a group hidden in Bot mode shows there again', group({ bots: { rank: 'm', members: {} }, presentation: { bots: false } }), 'a',
    { place: { kind: 'bot', groupId: 'g', viewId: 'a' }, edit: { type: 'bots.show' } }],
  ['a bot hidden in Bot mode shows again, keeping its details', group({ bots: { rank: 'm', members: { a: { hidden: true, label: 'Lead' } } } }), 'a',
    { place: { kind: 'bot', groupId: 'g', viewId: 'a' }, edit: { type: 'bot.update', viewId: 'a', details: { label: 'Lead' } } }],
  ['every edit in one change', group({ presentation: { bots: false } }), 'a',
    { place: { kind: 'bot', groupId: 'g', viewId: 'a' }, edit: { type: 'batch', operations: [{ type: 'bots.add', rank: 'r' }, { type: 'bots.show' }] } }],
  ['an Ask has no Bot place', group(), 'ask', undefined],
  ['a history view has none', group(), 'history', undefined],
  ['an empty view has none', group(), 'empty', undefined],
  ['a view that left the group has none', group(), 'gone', undefined],
];
it.each(PLACE_VECTORS)('opening a tile in Bot mode: %s', (_name, value, viewId, expected) => {
  expect(botPlaceForTile(value, viewId, 'r')).toEqual(expected);
});
const PIN_VECTORS: ReadonlyArray<readonly [string, WindowGroup, string | undefined, ReturnType<typeof windowRouteForPin>]> = [
  ['a bot whose group is a Window', group({ bots: { rank: 'm', members: {} } }), undefined, { route: { window: 'g' }, viewId: 'a', request: { kind: 'none' } }],
  ['a bot whose group is hidden from Window mode shows it there', group({ bots: { rank: 'm', members: {} }, presentation: { window: false } }), undefined,
    { route: { window: 'g' }, viewId: 'a', request: { kind: 'show', edit: { type: 'window.add' } } }],
  ['a bot pinned to another window moves there', group({ bots: { rank: 'm', members: {} } }), 'other', { route: { window: 'other' }, viewId: 'a', request: { kind: 'transfer', target: 'other' } }],
  ['its own window as the target is its group', group({ bots: { rank: 'm', members: {} } }), 'g', { route: { window: 'g' }, viewId: 'a', request: { kind: 'none' } }],
];
it.each(PIN_VECTORS)('pinning to a window: %s', (_name, value, target, expected) => {
  expect(windowRouteForPin(value, 'a', target)).toEqual(expected);
});
