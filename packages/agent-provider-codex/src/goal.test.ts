import { describe, expect, it } from 'vitest';
import { codexGoalOf, describeGoal, parseGoalRequest } from './goal.js';

const native = { threadId: 't', objective: 'make tests pass', status: 'active', tokenBudget: null, tokensUsed: 506, timeUsedSeconds: 3, createdAt: 1_795_893_366, updatedAt: 1_795_893_370 };

describe('the goal of a Codex thread', () => {
  it('becomes the runtime goal: seconds become milliseconds, a status of camel case becomes its word, and an active goal can pause or clear', () => {
    expect(codexGoalOf(native)).toEqual({ objective: 'make tests pass', status: 'active', tokensUsed: 506, timeUsedSeconds: 3, startedAt: 1_795_893_366_000, updatedAt: 1_795_893_370_000,
      actions: [{ kind: 'pause', commandId: 'goal', args: 'pause' }, { kind: 'clear', commandId: 'goal', args: 'clear' }] });
  });

  it.each([
    ['paused', 'paused', ['resume', 'clear']], ['usageLimited', 'usage_limited', ['clear']], ['budgetLimited', 'budget_limited', ['clear']],
    ['blocked', 'blocked', ['clear']], ['complete', 'complete', ['clear']],
  ])('maps %s to %s and offers %j', (status, mapped, actions) => {
    const goal = codexGoalOf({ ...native, status, tokenBudget: 1000 });
    expect(goal).toMatchObject({ status: mapped, tokenBudget: 1000 });
    expect(goal?.actions?.map(action => action.kind)).toEqual(actions);
  });

  it.each([[null], ['goal'], [{ ...native, status: 'someday' }], [{ ...native, objective: '' }], [{ ...native, tokensUsed: -1, status: 'active' }]])('reads %j without inventing a goal or a figure', value => {
    const goal = codexGoalOf(value);
    if (goal) expect(goal.tokensUsed).toBeUndefined(); else expect(goal).toBeUndefined();
  });
});

describe('what the person types after /goal', () => {
  it.each([
    ['', { kind: 'show' }], ['  ', { kind: 'show' }], ['clear', { kind: 'clear' }], [' pause ', { kind: 'pause' }], ['resume', { kind: 'resume' }],
    ['all tests pass', { kind: 'set', objective: 'all tests pass' }], ['edit make it faster', { kind: 'edit', objective: 'make it faster' }],
  ])('reads %j', (args, expected) => { expect(parseGoalRequest(args)).toEqual(expected); });

  it('treats only a whole word as a subcommand', () => {
    expect(parseGoalRequest('pause the deploy')).toEqual({ kind: 'set', objective: 'pause the deploy' });
    expect(parseGoalRequest('clearing the backlog')).toEqual({ kind: 'set', objective: 'clearing the backlog' });
    expect(parseGoalRequest('editor works')).toEqual({ kind: 'set', objective: 'editor works' });
  });

  it('refuses an edit without an objective and an objective over the limit', () => {
    expect(parseGoalRequest('edit')).toMatchObject({ error: expect.stringContaining('/goal edit') });
    expect(parseGoalRequest('x'.repeat(4097))).toMatchObject({ error: expect.stringContaining('4096') });
  });

  it('describes the goal for /goal alone', () => {
    expect(describeGoal(codexGoalOf({ ...native, status: 'usageLimited' }))).toBe('Goal (usage limited): make tests pass');
    expect(describeGoal(undefined)).toContain('No goal');
  });
});
