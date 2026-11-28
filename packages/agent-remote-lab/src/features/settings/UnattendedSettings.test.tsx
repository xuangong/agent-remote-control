import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { ChainAction, ChainView } from '@orchardworks/agent-remote-protocol';
import { render } from '../../test/setup.js';
import { UnattendedSettings } from './UnattendedSettings.js';

const bot = 'b_' + '1'.repeat(32);
const view = (unattended: Partial<NonNullable<ChainView['unattended']>> = {}): ChainView => ({ chains: [], paused: [], thresholds: {}, names: { [bot]: 'Chief' },
  unattended: { settings: {}, timeZone: 'UTC', day: '2026-11-30', today: { usd: 0, bots: {} }, month: { usd: 0, bots: {} }, limits: [], tripped: [], unpriced: [], ...unattended } });
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });
const click = (element: Element | null | undefined) => act(async () => { (element as HTMLElement).click(); });
const type = (input: HTMLInputElement, value: string) => act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); });
function setup(initial: ChainView) {
  let current = initial; const acted: ChainAction[] = [];
  const client = { list: vi.fn(async () => current), act: vi.fn(async (action: ChainAction) => { acted.push(action); }) };
  return { client, acted, set: (next: ChainView) => { current = next; } };
}
const field = (container: Element, label: string) => [...container.querySelectorAll('label')].find(item => item.textContent!.startsWith(label))!.querySelector('input') as HTMLInputElement;

describe('the unattended work settings', () => {
  it('pauses everything with one switch and shows how the work is going: usage by bot in ≈ $, the provider windows that stand, and the cap reached with a way to allow more', async () => {
    const s = setup(view({ today: { usd: 6.5, bots: { [bot]: { usd: 6.5, tokens: 1_200_000, turns: 4, runs: 3 } } }, month: { usd: 20, bots: { [bot]: { usd: 20, tokens: 5_000_000, turns: 20, runs: 12 } } },
      tripped: [{ scope: 'account', period: 'day' }], limits: [{ provider: 'mac/claude' }], settings: { budget: { perDay: 5 } } }));
    const container = await render(<UnattendedSettings baseUrl="/" client={s.client} />);
    await flush();
    const text = container.textContent!;
    expect(text).toContain('Today · ≈ $6.50');
    expect(text).toContain('Chief');
    expect(text).toContain('≈ $6.50 · 1,200,000 tokens · 3 runs');
    expect(text).toContain('Limit reached: all bots, today');
    expect(text).toContain('claude: waiting (reset time unknown)');
    await click([...container.querySelectorAll('button')].find(item => item.textContent === 'Allow $5 more today'));
    await click(container.querySelector('[role="switch"], input[type="checkbox"]'));
    expect(s.acted).toEqual([{ action: 'set_unattended', patch: { allowMoreToday: 5 } }, { action: 'set_unattended', patch: { paused: true } }]);
  });
  it('saves the caps it was given and clears them when every field is empty', async () => {
    const s = setup(view({ settings: { budget: { perDay: 5, perMonth: 50 } } }));
    const container = await render(<UnattendedSettings baseUrl="/" client={s.client} />);
    await flush();
    const budget = container.querySelector('form[aria-label="Budget"]')!;
    expect((field(budget, 'Per day') ).value).toBe('5');
    await type(field(budget, 'Per month'), '80'); await type(field(budget, 'Runs a day'), '20');
    await click([...budget.querySelectorAll('button')].find(item => item.textContent === 'Save'));
    await type(field(budget, 'Per day'), ''); await type(field(budget, 'Per month'), ''); await type(field(budget, 'Runs a day'), '');
    await click([...budget.querySelectorAll('button')].find(item => item.textContent === 'Save'));
    expect(s.acted).toEqual([{ action: 'set_unattended', patch: { budget: { perDay: 5, perMonth: 80, runsPerDay: 20 } } }, { action: 'set_unattended', patch: { budget: null } }]);
  });
  it('adds a model\'s rates and removes them, flags the models priced by default, and changes the time zone and the days away', async () => {
    const s = setup(view({ unpriced: ['my-local-model'], settings: { prices: { 'old-model': { input: 1, cacheWrite: 1, cacheRead: 0.1, output: 5 } } } }));
    const container = await render(<UnattendedSettings baseUrl="/" client={s.client} />);
    await flush();
    expect(container.textContent).toContain('No price for: my-local-model');
    const prices = container.querySelector('section[aria-label^="Prices"]')!;
    await click(prices.querySelector('button[aria-label="Remove old-model"]'));
    await type(field(prices, 'Model id'), 'my-local-model');
    for (const [label, value] of [['Input', '1'], ['Cache write', '1.25'], ['Cache read', '0.1'], ['Output', '5']] as const) await type(field(prices, label), value);
    await click([...prices.querySelectorAll('button')].find(item => item.textContent === 'Add price'));
    await type(field(container, 'Time zone'), 'Asia/Tokyo'); await type(field(container, 'Pause after days'), '30');
    await click([...container.querySelectorAll('form:not([aria-label]) button')].find(item => item.textContent === 'Save'));
    expect(s.acted).toEqual([{ action: 'set_unattended', patch: { prices: { 'old-model': null } } }, { action: 'set_unattended', patch: { prices: { 'my-local-model': { input: 1, cacheWrite: 1.25, cacheRead: 0.1, output: 5 } } } },
      { action: 'set_unattended', patch: { timeZone: 'Asia/Tokyo', absenceDays: 30 } }]);
  });
  it('says so when it cannot load', async () => {
    const container = await render(<UnattendedSettings baseUrl="/" client={{ list: async () => { throw new Error('x'); }, act: async () => {} }} />);
    await flush();
    expect(container.querySelector('[role="alert"]')!.textContent).toBe('That did not work. Try again.');
  });
});
