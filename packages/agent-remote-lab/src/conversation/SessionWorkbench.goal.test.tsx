import { act } from 'react';
import { expect, it, vi } from 'vitest';
import type { AgentReplicaState } from '@orchardworks/agent-client';
import type { AgentSessionGoal } from '@orchardworks/agent-remote-protocol';
import { render } from '../test/setup.js';
import { replicaState } from '../test/fixtures.js';
import { SessionWorkbench } from './ConversationSurface.js';

const goal: AgentSessionGoal = { objective: 'all tests pass', status: 'active', iterations: 2, lastReason: 'two tests fail',
  actions: [{ kind: 'pause', commandId: 'goal', args: 'pause' }, { kind: 'clear', commandId: 'goal', args: 'clear' }] };
const withGoal = (value: AgentSessionGoal | undefined): AgentReplicaState => ({ ...replicaState, agent: { ...replicaState.agent!, status: 'idle', activeTurn: null, capabilities: { ...replicaState.agent!.capabilities, commands: true }, runtimeInfo: { ...replicaState.agent!.runtimeInfo, ...(value ? { goal: value } : {}) } } });

it('pins the goal in the conversation, and Clear goal sends the command of the session', async () => {
  const executeCommand = vi.fn(async () => ({}));
  const container = await render(<SessionWorkbench state={withGoal(goal)} sessionStatus="ready" actions={{ executeCommand }} />);
  const line = container.querySelector('[data-goal-line]')!;
  expect(line.textContent).toContain('all tests pass');
  expect(line.textContent).toContain('2 checks');
  await act(async () => line.querySelector<HTMLButtonElement>('[data-goal-action="clear"]')!.click());
  expect(executeCommand).toHaveBeenCalledExactlyOnceWith('goal', 'clear');
});

it('only reads the goal while the session cannot be changed', async () => {
  const executeCommand = vi.fn(async () => ({}));
  const readOnly = await render(<SessionWorkbench state={withGoal(goal)} sessionStatus="ready" readOnly actions={{ executeCommand }} />);
  expect(readOnly.querySelector('[data-goal-line]')).not.toBeNull();
  expect(readOnly.querySelector('[data-goal-action]')).toBeNull();
  const connecting = await render(<SessionWorkbench state={withGoal(goal)} sessionStatus="disconnected" actions={{ executeCommand }} />);
  expect(connecting.querySelector('[data-goal-action]')).toBeNull();
});

it('draws no goal for a session without one', async () => {
  const container = await render(<SessionWorkbench state={withGoal(undefined)} sessionStatus="ready" actions={{}} />);
  expect(container.querySelector('[data-goal-line]')).toBeNull();
});

it('badges the goal on a tile header, in the words of its status', async () => {
  const container = await render(<SessionWorkbench state={withGoal({ ...goal, status: 'paused', actions: [] })} sessionStatus="ready" actions={{}} headingMode="tile" assistant={{ name: 'Chief' }} />);
  const badge = container.querySelector('[data-goal-badge]')!;
  expect(badge.textContent).toBe('Goal paused');
  expect(badge.closest('.lab-tile-heading')).not.toBeNull();
  const none = await render(<SessionWorkbench state={withGoal(undefined)} sessionStatus="ready" actions={{}} headingMode="tile" assistant={{ name: 'Chief' }} />);
  expect(none.querySelector('[data-goal-badge]')).toBeNull();
});
