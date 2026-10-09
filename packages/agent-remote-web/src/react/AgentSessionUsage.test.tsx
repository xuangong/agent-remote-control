import type { AgentUsage } from '@orchardworks/agent-remote-protocol';
import { expect, it } from 'vitest';
import { render, rerender } from '../test/setup.js';
import { AgentSessionUsage } from './AgentSessionUsage.js';

function fact(section: Element, label: string): HTMLElement {
  const term = [...section.querySelectorAll('dt')].find(item => item.textContent === label);
  if (!(term?.nextElementSibling instanceof HTMLElement)) throw new Error(`Missing usage fact: ${label}`);
  return term.nextElementSibling;
}

it.each([
  ['session', 'Session tokens'], ['runtime', 'Tokens since start / resume'], ['turn', 'Latest turn tokens'], ['call', 'Latest call tokens'],
] as const)('labels %s token measurements by their supplied scope', async (tokenScope, label) => {
  const container = await render(<AgentSessionUsage lastKnown={false} usage={{ tokenScope, inputTokens: 3_456, outputTokens: 100,
    cachedInputTokens: 200, cacheCreationInputTokens: 0, totalTokens: 3_756, totalCostUsd: 12.34 }} />);
  const tokens = container.querySelector(`section[aria-label="${label}"]`)!;
  expect(tokens).not.toBeNull();
  expect(fact(tokens, 'Input').querySelector('data')?.getAttribute('value')).toBe('3456');
  expect(fact(tokens, 'Input').querySelector('data')?.title).toBe('3,456 tokens');
  expect(fact(tokens, 'Input').querySelector('[aria-hidden="true"]')?.textContent).toBe('3.5K');
  expect(fact(tokens, 'Input').querySelector('.agent-visually-hidden')?.textContent).toBe('3,456 tokens');
  expect(fact(tokens, 'Cache read').querySelector('data')?.getAttribute('value')).toBe('200');
  expect(fact(tokens, 'Cache write').querySelector('data')?.getAttribute('value')).toBe('0');
  expect(fact(tokens, 'Total').querySelector('data')?.getAttribute('value')).toBe('3756');
  expect(container.textContent).not.toMatch(/12\.34|cost|USD|Last known/i);
});

it('distinguishes native session totals from cumulative usage limited to the current runtime', async () => {
  const container = await render(<AgentSessionUsage lastKnown={false} usage={{ tokenScope: 'session', totalTokens: 1_000 }} />);
  const session = container.querySelector('section[aria-label="Session tokens"]')!;
  expect(session.textContent).toContain('Cumulative usage for this native session.');
  expect(session.textContent).not.toContain('resets when resumed');
  await rerender(container, <AgentSessionUsage lastKnown={false} usage={{ tokenScope: 'runtime', totalTokens: 50 }} />);
  const runtime = container.querySelector('section[aria-label="Tokens since start / resume"]')!;
  expect(runtime.textContent).toContain('Accumulated during this run; resets when resumed or cleared.');
  expect(fact(runtime, 'Total').querySelector('data')?.getAttribute('value')).toBe('50');
  expect(container.querySelector('section[aria-label="Session tokens"]')).toBeNull();
});

it('preserves zero and leaves missing counters unknown without deriving a total', async () => {
  const container = await render(<AgentSessionUsage lastKnown={false} usage={{ tokenScope: 'session', inputTokens: 0, outputTokens: 50, cachedInputTokens: 1_000 }} />);
  const tokens = container.querySelector('section[aria-label="Session tokens"]')!;
  expect(fact(tokens, 'Input').querySelector('[aria-hidden="true"]')?.textContent).toBe('0');
  expect(fact(tokens, 'Cache write').textContent).toBe('Not provided');
  expect(fact(tokens, 'Total').textContent).toBe('Not provided');
});

it.each([undefined, { inputTokens: 1_234_567, outputTokens: 111, totalCostUsd: 123 }] satisfies Array<AgentUsage | undefined>)('does not assign legacy or missing counters a session scope', async usage => {
  const container = await render(<AgentSessionUsage lastKnown={false} usage={usage} />);
  const tokens = container.querySelector('section[aria-label="Token usage"]')!;
  expect(tokens.textContent).toBe('Token usageNot provided');
  expect(tokens.querySelector('data')).toBeNull();
  expect(container.querySelector('section[aria-label="Session tokens"]')).toBeNull();
});

it('shows current context independently of cumulative token totals', async () => {
  const container = await render(<AgentSessionUsage lastKnown={false} usage={{ tokenScope: 'session', totalTokens: 2_000_000, contextScope: 'current',
    contextWindowUsedTokens: 32_000, contextWindowMaxTokens: 128_000 }} />);
  const context = container.querySelector('section[aria-label="Current context"]')!;
  expect(fact(context, 'Used').querySelector('data')?.getAttribute('value')).toBe('32000');
  expect(fact(context, 'Capacity').querySelector('data')?.getAttribute('value')).toBe('128000');
  expect(fact(context, 'Utilization').textContent).toBe('25%');
});

it.each([undefined, 'session'] as const)('does not label legacy context counters as current context with token scope %s', async tokenScope => {
  const container = await render(<AgentSessionUsage lastKnown={false} usage={{ tokenScope, contextWindowUsedTokens: 2_000_000,
    contextWindowMaxTokens: 128_000 }} />);
  const context = container.querySelector('section[aria-label="Current context"]')!;
  expect(fact(context, 'Used').textContent).toBe('Not provided');
  expect(fact(context, 'Capacity').textContent).toBe('Not provided');
  expect(fact(context, 'Utilization').textContent).toBe('Not provided');
});

it('shows explicitly current context without requiring a token scope', async () => {
  const container = await render(<AgentSessionUsage lastKnown={false} usage={{ contextScope: 'current',
    contextWindowUsedTokens: 1_000, contextWindowMaxTokens: 10_000 }} />);
  const context = container.querySelector('section[aria-label="Current context"]')!;
  expect(container.querySelector('section[aria-label="Token usage"]')?.textContent).toBe('Token usageNot provided');
  expect(fact(context, 'Used').querySelector('data')?.getAttribute('value')).toBe('1000');
  expect(fact(context, 'Capacity').querySelector('data')?.getAttribute('value')).toBe('10000');
  expect(fact(context, 'Utilization').textContent).toBe('10%');
});

it.each([
  [{ contextScope: 'current', contextWindowUsedTokens: 0, contextWindowMaxTokens: 128_000 }, '0%'],
  [{ contextScope: 'current', contextWindowUsedTokens: 10 }, 'Not provided'],
  [{ contextScope: 'current', contextWindowMaxTokens: 128_000 }, 'Not provided'],
  [{ contextScope: 'current', contextWindowUsedTokens: 10, contextWindowMaxTokens: 0 }, 'Not provided'],
] satisfies Array<[AgentUsage, string]>)('requires a known positive capacity for context utilization: %j', async (usage, expected) => {
  const container = await render(<AgentSessionUsage lastKnown={false} usage={usage} />);
  const context = container.querySelector('section[aria-label="Current context"]')!;
  expect(fact(context, 'Utilization').textContent).toBe(expected);
});

it('replaces snapshots, including counters no longer supplied and reduced context after compaction', async () => {
  const container = await render(<AgentSessionUsage lastKnown={false} usage={{ tokenScope: 'session', inputTokens: 600, totalTokens: 800, contextScope: 'current',
    contextWindowUsedTokens: 70_000, contextWindowMaxTokens: 128_000 }} />);
  await rerender(container, <AgentSessionUsage lastKnown={true} usage={{ tokenScope: 'session', totalTokens: 950, contextScope: 'current',
    contextWindowUsedTokens: 10_000, contextWindowMaxTokens: 128_000 }} />);
  const tokens = container.querySelector('section[aria-label="Session tokens"]')!;
  const context = container.querySelector('section[aria-label="Current context"]')!;
  expect(fact(tokens, 'Total').querySelector('data')?.getAttribute('value')).toBe('950');
  expect(fact(tokens, 'Input').textContent).toBe('Not provided');
  expect(fact(context, 'Used').querySelector('data')?.getAttribute('value')).toBe('10000');
  expect(tokens.querySelector('h3')?.textContent).toContain('Last known');
  expect(context.querySelector('h3')?.textContent).toContain('Last known');
  expect(container.querySelectorAll('button, svg, canvas')).toHaveLength(0);
});
