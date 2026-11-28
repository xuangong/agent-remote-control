// @vitest-environment jsdom
import { act } from 'react';
import { expect, it, vi } from 'vitest';
import type { AgentSessionGoal } from '@orchardworks/agent-remote-protocol';
import { render, rerender } from '../../test/setup.js';
import { SessionGoalLine } from './SessionGoalLine.js';

const goal: AgentSessionGoal = { objective: 'all tests pass', status: 'active', iterations: 3, tokensUsed: 12_400, lastReason: 'two tests still fail',
  actions: [{ kind: 'pause', commandId: 'goal', args: 'pause' }, { kind: 'clear', commandId: 'goal', args: 'clear' }] };
const buttons = (container: HTMLElement) => [...container.querySelectorAll<HTMLButtonElement>('[data-goal-action]')];

it('says the objective and where it stands in one line, with the last reason in its title', async () => {
  const container = await render(<SessionGoalLine goal={goal} onAction={async () => {}} />);
  const line = container.querySelector('[data-goal-line]')!;
  expect(line.getAttribute('aria-label')).toBe('Goal: all tests pass');
  expect(line.textContent).toContain('all tests pass');
  expect(line.textContent).toContain('Working toward it · 3 checks · 12k tokens');
  expect(line.getAttribute('title')).toContain('Last check: two tests still fail');
  expect(buttons(container).map(button => button.textContent)).toEqual(['Pause', 'Clear goal']);
});

it('sends the command its adapter named for an action, once, and holds the buttons while it runs', async () => {
  let finish!: () => void;
  const onAction = vi.fn(() => new Promise<void>(resolve => { finish = resolve; }));
  const container = await render(<SessionGoalLine goal={goal} onAction={onAction} />);
  await act(async () => buttons(container)[1]!.click());
  expect(onAction).toHaveBeenCalledExactlyOnceWith('goal', 'clear');
  expect(buttons(container).every(button => button.disabled)).toBe(true);
  await act(async () => { finish(); });
  expect(buttons(container).every(button => !button.disabled)).toBe(true);
});

it('says so when the action failed, and the next report of the goal replaces it', async () => {
  const container = await render(<SessionGoalLine goal={goal} onAction={async () => { throw new Error('refused'); }} />);
  await act(async () => buttons(container)[0]!.click());
  expect(container.querySelector('[role="alert"]')?.textContent).toBe('The goal could not be changed.');
  await rerender(container, <SessionGoalLine goal={{ ...goal, iterations: 4 }} onAction={async () => {}} />);
  expect(container.querySelector('[role="alert"]')).toBeNull();
  expect(container.textContent).toContain('4 checks');
});

it('draws only the actions the adapter offered, and none where the session cannot be changed', async () => {
  const paused = await render(<SessionGoalLine goal={{ ...goal, status: 'paused', actions: [{ kind: 'resume', commandId: 'goal', args: 'resume' }] }} onAction={async () => {}} />);
  expect(buttons(paused).map(button => button.textContent)).toEqual(['Resume']);
  const readOnly = await render(<SessionGoalLine goal={goal} />);
  expect(buttons(readOnly)).toEqual([]);
  expect(readOnly.querySelector('[data-goal-line]')!.textContent).toContain('Working toward it');
  const done = await render(<SessionGoalLine goal={{ objective: 'ship', status: 'complete' }} onAction={async () => {}} />);
  expect(buttons(done)).toEqual([]);
  expect(done.querySelector('[data-goal-line]')!.getAttribute('data-goal-status')).toBe('complete');
});
