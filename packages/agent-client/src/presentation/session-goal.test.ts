import { describe, expect, it } from 'vitest';
import type { AgentSessionGoal } from '@orchardworks/agent-remote-protocol';
import { translator } from './messages.js';
import { sessionGoalView, tokenCount } from './session-goal.js';

const goal: AgentSessionGoal = { objective: 'all tests pass', status: 'active', iterations: 3, tokensUsed: 12_400, timeUsedSeconds: 245, lastReason: 'two tests still fail',
  actions: [{ kind: 'pause', commandId: 'goal', args: 'pause' }, { kind: 'clear', commandId: 'goal', args: 'clear' }] };

describe('the goal of a session in words', () => {
  it('says the status, the figures the CLI gave and the last reason, and labels the offered actions', () => {
    const view = sessionGoalView(goal, translator('en'));
    expect(view).toMatchObject({ objective: 'all tests pass', status: 'active', statusWords: 'Working toward it', badge: 'Goal', progress: '3 checks · 12k tokens · 4m 05s' });
    expect(view.detail).toBe('all tests pass\nWorking toward it · 3 checks · 12k tokens · 4m 05s\nLast check: two tests still fail');
    expect(view.actions).toEqual([{ kind: 'pause', label: 'Pause', commandId: 'goal', args: 'pause' }, { kind: 'clear', label: 'Clear goal', commandId: 'goal', args: 'clear' }]);
  });

  it('says the same in Chinese', () => {
    const view = sessionGoalView({ ...goal, status: 'paused' }, translator('zh'));
    expect(view).toMatchObject({ statusWords: '已暂停', badge: '目标已暂停', progress: '检查 3 次 · 12k token · 4 分 05 秒' });
    expect(view.actions.map(action => action.label)).toEqual(['暂停', '清除目标']);
  });

  it('leaves out a figure the CLI does not keep, and shows the budget when there is one', () => {
    expect(sessionGoalView({ objective: 'ship', status: 'complete' }, translator('en'))).toMatchObject({ progress: '', badge: 'Goal done', actions: [], detail: 'ship\nDone' });
    expect(sessionGoalView({ objective: 'ship', status: 'budget_limited', iterations: 0, tokensUsed: 50_000, tokenBudget: 50_000 }, translator('en')).progress).toBe('50k of 50k tokens');
    expect(sessionGoalView({ objective: 'ship', status: 'active', iterations: 1 }, translator('en')).progress).toBe('1 check');
  });

  it.each([[0, '0'], [950, '950'], [1000, '1k'], [1234, '1.2k'], [9999, '10k'], [12_400, '12k'], [1_250_000, '1.3M']])('writes %i tokens as %s', (count, words) => {
    expect(tokenCount(count)).toBe(words);
  });
});
