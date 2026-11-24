import { act } from 'react';
import { describe, expect, it, vi } from 'vitest';
import type { BotChain, ChainAction, ChainView } from '@orchardworks/agent-remote-protocol';
import { render } from '../../test/setup.js';
import { BotAudit } from './BotAudit.js';
import { observeChains, resetChainAlerts, useChainAlerts } from '../../kernel/chain-alerts.js';

const ids = { chief: 'b_' + '1'.repeat(32), tracker: 'b_' + '2'.repeat(32), worker: 'b_' + '3'.repeat(32) };
const chain = (id: string, extra: Partial<BotChain> = {}): BotChain => ({ id, cause: 'person', bot: ids.chief, bots: [ids.chief, ids.tracker, ids.worker], messages: 4, turns: 3, created: 1, depth: 2,
  usage: { tokens: 1200 }, startedAt: 1, updatedAt: 2, ...extra });
const view = (chains: BotChain[], paused: string[] = []): ChainView => ({ chains, paused, thresholds: {}, names: { [ids.chief]: 'Chief', [ids.tracker]: 'Tracker', [ids.worker]: 'Logs' },
  kinds: { [ids.chief]: 'standing', [ids.tracker]: 'standing', [ids.worker]: 'temporary' } });
const flush = () => act(async () => { await new Promise(resolve => setTimeout(resolve, 0)); });

describe('the audit of the bots\' work', () => {
  it('lists each chain with its cause and what it did, and stops it, a bot\'s part, pauses a standing bot and retires a temporary one', async () => {
    let current = view([chain('c_0000000000000001'), chain('c_0000000000000002', { cause: 'timer', bot: ids.tracker, bots: [ids.tracker], stopped: 3 })]);
    const acted: ChainAction[] = [];
    const client = { list: vi.fn(async () => current), act: vi.fn(async (action: ChainAction) => { acted.push(action); if (action.action === 'pause_bot') current = { ...current, paused: [action.botId] }; }) };
    const container = await render(<BotAudit baseUrl="/" client={client} />);
    await flush();
    const rows = [...container.querySelectorAll('.lab-bot-audit > ul > li')];
    expect(rows.map(row => row.querySelector('.lab-assistant-session-title')!.textContent)).toEqual(['You asked Chief', 'Timer of Tracker']);
    expect(rows[0]!.querySelector('small')!.textContent).toContain('4 messages · 3 turns · 1 bots created · depth 2');
    expect(rows[1]!.querySelector('small')!.textContent).toContain('Stopped');
    await act(async () => rows[0]!.querySelector<HTMLButtonElement>('.lab-assistant-session-toggle')!.click());
    const buttons = () => [...rows[0]!.querySelectorAll<HTMLButtonElement>('.lab-assistant-task-actions button')];
    expect(buttons().map(button => button.textContent)).toEqual(['Stop', 'Stop Chief here', 'Pause Chief', 'Stop Tracker here', 'Pause Tracker', 'Stop Logs here', 'Retire Logs']);
    for (const label of ['Stop', 'Pause Tracker', 'Retire Logs']) { await act(async () => buttons().find(button => button.textContent === label)!.click()); await flush(); }
    expect(acted).toEqual([{ action: 'stop', chainId: 'c_0000000000000001' }, { action: 'pause_bot', botId: ids.tracker }, { action: 'retire_bot', botId: ids.worker }]);
    expect(buttons().map(button => button.textContent)).toContain('Resume Tracker');
  });

  it('says when the bots have not worked together yet, and when a decision did not go through', async () => {
    const client = { list: vi.fn(async () => view([chain('c_0000000000000001')])), act: vi.fn(async () => { throw new Error('No.'); }) };
    const container = await render(<BotAudit baseUrl="/" client={client} />);
    await flush();
    await act(async () => container.querySelector<HTMLButtonElement>('.lab-assistant-session-toggle')!.click());
    await act(async () => container.querySelector<HTMLButtonElement>('.lab-assistant-task-actions button')!.click());
    await flush();
    expect(container.querySelector('[role="alert"]')!.textContent).toBe('That did not work. Try again.');
    const empty = await render(<BotAudit baseUrl="/" client={{ list: async () => view([]), act: async () => {} }} />);
    await flush();
    expect(empty.textContent).toContain('Your bots have not worked together yet.');
  });

  it('saves the person\'s thresholds, and marks a chain that passed one', async () => {
    const acted: ChainAction[] = [];
    const client = { list: vi.fn(async () => view([chain('c_0000000000000001', { passed: ['tokens', 'depth'] })])), act: vi.fn(async (action: ChainAction) => { acted.push(action); }) };
    const container = await render(<BotAudit baseUrl="/" client={client} />);
    await flush();
    expect(container.querySelector('.lab-bot-audit > ul > li small')!.textContent).toContain('Passed: Tokens, Reply depth');
    const form = container.querySelector('form')!, inputs = [...form.querySelectorAll('input')];
    const type = (input: HTMLInputElement, value: string) => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value); input.dispatchEvent(new Event('input', { bubbles: true })); };
    await act(async () => { type(inputs[0]!, '200000'); type(inputs[2]!, '30'); });
    await act(async () => form.querySelector<HTMLButtonElement>('button[type="submit"]')!.click());
    await flush();
    expect(acted).toEqual([{ action: 'set_thresholds', thresholds: { tokens: 200000, minutes: 30 } }]);
  });
});

describe('the audit and the passed-chain sign', () => {
  it('seeing a passed chain in the audit clears its sign, and a chain that passes more later brings it back', async () => {
    resetChainAlerts();
    let current = view([chain('c_0000000000000001', { passed: ['depth'] })]);
    function Sign() { return <output>{useChainAlerts().length}</output>; }
    const client = { list: vi.fn(async () => current), act: vi.fn(async () => {}) };
    act(() => observeChains('/', current.chains));
    const sign = await render(<Sign />);
    expect(sign.textContent).toBe('1');
    await render(<BotAudit baseUrl="/" client={client} />);
    await flush();
    expect(sign.textContent).toBe('0');
    current = view([chain('c_0000000000000001', { passed: ['depth', 'tokens'] })]);
    act(() => observeChains('/', current.chains));
    expect(sign.textContent).toBe('1');
    resetChainAlerts();
  });

  it('lists the approvals the person gave a chain, with when and how often they applied, and revokes one so it asks again', async () => {
    let current = view([chain('c_0000000000000001', { approvals: [{ kind: 'Edit', cwd: '/repo', at: 2, applied: 3 }, { kind: 'Bash', cwd: '/repo', at: 2, applied: 1 }] }), chain('c_0000000000000002')]);
    const acted: ChainAction[] = [];
    const client = { list: vi.fn(async () => current), act: vi.fn(async (action: ChainAction) => { acted.push(action);
      if (action.action === 'revoke_approval') current = view([chain('c_0000000000000001', { approvals: [{ kind: 'Bash', cwd: '/repo', at: 2, applied: 1 }] }), chain('c_0000000000000002')]); }) };
    const container = await render(<BotAudit baseUrl="/" client={client} />);
    await flush();
    const rows = [...container.querySelectorAll('.lab-bot-audit > ul > li')];
    for (const row of rows) await act(async () => row.querySelector<HTMLButtonElement>('.lab-assistant-session-toggle')!.click());
    expect(rows[1]!.querySelector('.lab-bot-audit-approvals')).toBeNull();
    const approvals = () => [...rows[0]!.querySelectorAll('.lab-bot-audit-approvals li')];
    expect(approvals().map(row => row.querySelector('span')!.textContent)).toEqual(['Edit in /repo', 'Bash in /repo']);
    expect(approvals()[0]!.querySelector('small')!.textContent).toContain('applied 3 times');
    expect(approvals()[1]!.querySelector('small')!.textContent).toContain('applied 1 time');
    await act(async () => approvals()[0]!.querySelector<HTMLButtonElement>('button')!.click());
    await flush();
    expect(acted).toEqual([{ action: 'revoke_approval', chainId: 'c_0000000000000001', kind: 'Edit', cwd: '/repo' }]);
    expect(approvals().map(row => row.querySelector('span')!.textContent)).toEqual(['Bash in /repo']);
  });
});
