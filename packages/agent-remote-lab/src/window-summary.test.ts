import { expect, it } from 'vitest';
import { createWindowView, type WindowView } from '@orchardworks/agent-remote-protocol';
import { windowSummary } from './window-summary.js';

const bot = (id: string, extra: Partial<WindowView> = {}): WindowView => ({
  ...createWindowView(id, { hostId: 'h', providerId: 'codex', nativeSessionId: id, title: id }, 'primary'), ...extra });

it('counts the bots, and how many are open once any is folded or asleep', () => {
  expect(windowSummary([bot('a'), bot('b'), bot('c')])).toBe('3 bots');
  expect(windowSummary([bot('a')])).toBe('1 bot');
  expect(windowSummary([bot('a'), bot('b', { collapsed: true }), bot('c')])).toBe('3 bots · 2 open');
  // An asleep bot stands folded in a Window, so it is not open either.
  expect(windowSummary([bot('a'), bot('b'), bot('c')], viewId => viewId !== 'a')).toBe('3 bots · 1 open');
  expect(windowSummary([bot('a', { collapsed: true })])).toBe('1 bot · 0 open');
});

it('counts views when a Window has no bot, and says when it is empty', () => {
  const ask = createWindowView('ask', { hostId: 'h', providerId: 'codex', nativeSessionId: 'q', title: 'Why?' }, 'float');
  const askView: WindowView = { ...ask, feature: { kind: 'ask', id: 'q' }, closeWith: 'a' };
  expect(windowSummary([createWindowView('empty')])).toBe('1 view');
  expect(windowSummary([createWindowView('one'), createWindowView('two')])).toBe('2 views');
  expect(windowSummary([])).toBe('Empty');
  // Asks, history views and empty views are not bots.
  expect(windowSummary([bot('a'), askView, createWindowView('empty')])).toBe('1 bot');
  expect(windowSummary([bot('h', { binding: { hostId: 'h', providerId: 'codex', nativeSessionId: 'h', title: 'h', sessionIntent: 'history' } })])).toBe('1 view');
});
