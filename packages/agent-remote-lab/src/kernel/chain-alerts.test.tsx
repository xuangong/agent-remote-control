import { act } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BotChain } from '@orchardworks/agent-remote-protocol';
import { render } from '../test/setup.js';
import { markChainsSeen, observeChains, resetChainAlerts, unseenChains, useChainAlertPoll, useChainAlerts } from './chain-alerts.js';
import { TeamRefresh } from './useTeamRoster.js';

const bot = 'b_' + '1'.repeat(32);
const chain = (id: string, passed?: BotChain['passed']): BotChain => ({ id, cause: 'person', bot, bots: [bot], messages: 1, turns: 1, created: 0, depth: 1, usage: { tokens: 1 }, startedAt: 1, updatedAt: 2, ...(passed ? { passed } : {}) });
beforeEach(() => { localStorage.clear(); resetChainAlerts(); });
afterEach(() => { vi.useRealTimers(); });

it('counts the chains that passed a threshold and are not seen, and a chain that passes another threshold is unseen again', () => {
  expect(unseenChains([chain('c_1'), chain('c_2', ['depth']), chain('c_3', ['depth', 'tokens'])], { c_3: 'depth' })).toEqual([{ chainId: 'c_2', bot }, { chainId: 'c_3', bot }]);
  expect(unseenChains([chain('c_2', ['depth'])], { c_2: 'depth' })).toEqual([]);
});

function Counter() { return <output>{useChainAlerts().length}</output>; }
const count = (container: Element) => container.querySelector('output')!.textContent;

it('keeps a seen chain seen on this device across a reload, per account address', async () => {
  const container = await render(<Counter />);
  act(() => observeChains('http://a/', [chain('c_1', ['depth'])]));
  expect(count(container)).toBe('1');
  act(() => markChainsSeen('http://a/'));
  expect(count(container)).toBe('0');
  // A later read of the same chain stays seen; another account address does not inherit it.
  act(() => observeChains('http://a/', [chain('c_1', ['depth'])]));
  expect(count(container)).toBe('0');
  act(() => observeChains('http://b/', [chain('c_1', ['depth'])]));
  expect(count(container)).toBe('1');
  act(() => observeChains('http://a/', [chain('c_1', ['depth', 'minutes'])]));
  expect(count(container)).toBe('1');
});

it('reads the chains at the Team roster\'s idle period while the page is open', async () => {
  vi.useFakeTimers();
  const list = vi.fn(async () => ({ chains: [chain('c_1', ['depth'])], names: {}, paused: [], kinds: {}, thresholds: {} }));
  function Page({ enabled }: { enabled: boolean }) { useChainAlertPoll({ baseUrl: 'http://a/', enabled, client: { list } }); return <Counter />; }
  const container = await render(<TeamRefresh.Provider value={{ watchingMs: 10, idleMs: 1_000 }}><Page enabled /></TeamRefresh.Provider>);
  await act(async () => { await vi.advanceTimersByTimeAsync(0); });
  expect(count(container)).toBe('1');
  const first = list.mock.calls.length;
  await act(async () => { await vi.advanceTimersByTimeAsync(2_500); });
  expect(list.mock.calls.length).toBeGreaterThanOrEqual(first + 2);
  expect(list.mock.calls.length).toBeLessThanOrEqual(first + 3);
});
