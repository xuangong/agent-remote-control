// @vitest-environment node
import { expect, it } from 'vitest';
import { appBadgeShown, browserBadge } from './app-badge.js';

const row = (state: 'needs_you' | 'working' | 'idle', unread = false, muted = false) => ({ assistant: { state } as never, ...(unread ? { unread: true as const } : {}), ...(muted ? { muted: true as const } : {}) });

it.each([
  ['no assistant', [], false],
  ['every reply seen and nothing waiting', [row('idle'), row('working')], false],
  ['an assistant needs you', [row('idle'), row('needs_you')], true],
  ['a muted chat needs you: its need still shows', [row('needs_you', false, true)], true],
  ['an unread reply', [row('idle', true)], true],
  ['only a muted chat\'s unread reply', [row('idle', true, true)], false],
] as const)('%s: a dot is %s', (_name, rows, shown) => { expect(appBadgeShown(rows)).toBe(shown); });

it('sets and clears the dot with no number where the browser has a badge, and offers nothing where it has none', async () => {
  const calls: unknown[][] = [];
  const badge = browserBadge({ navigator: { setAppBadge: async (...args: unknown[]) => { calls.push(['set', ...args]); }, clearAppBadge: async () => { calls.push(['clear']); } } });
  await badge!.set(); await badge!.clear();
  expect(calls).toEqual([['set'], ['clear']]);
  expect(browserBadge({ navigator: {} })).toBeUndefined();
});
