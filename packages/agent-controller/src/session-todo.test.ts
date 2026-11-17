import { expect, it } from 'vitest';
import { createSessionTodo, changeSessionTodo, confirmSessionTodo, currentSessionTodo, sessionTodoComplete, sessionTodoTools, invalidateSessionTodoApproval } from './session-todo.js';

const steps = [
  { id: 'discuss', title: 'Discuss scope', acceptance: 'A concrete proposal exists', kind: 'task' as const },
  { id: 'agree', title: 'Agree scope', acceptance: 'User explicitly agrees', kind: 'confirmation' as const },
  { id: 'build', title: 'Implement', acceptance: 'Tests pass', kind: 'task' as const },
];
const begin = (list: any, stepId: string) => changeSessionTodo(list, { action: 'progress', revision: list.revision, stepId, status: 'in_progress', note: 'Working' });
const complete = (list: any, stepId: string) => changeSessionTodo(list, { action: 'complete', revision: list.revision, stepId, evidence: ['Concrete result'] });

it('only progresses the first unfinished step and requires evidence before completion', () => {
  const list = createSessionTodo(steps);
  expect(() => begin(list, 'build')).toThrow(/current/i);
  expect(() => complete(list, 'discuss')).toThrow(/start|progress/i);
  const started = begin(list, 'discuss');
  expect(() => changeSessionTodo(started, { action: 'complete', revision: started.revision, stepId: 'discuss', evidence: ['  '] })).toThrow(/evidence/i);
  const done = complete(started, 'discuss');
  expect(currentSessionTodo(done)?.id).toBe('agree');
  expect(list.steps[0]?.status).toBe('pending');
  expect(sessionTodoComplete(done)).toBe(false);
});

it('requires a revision-bound explicit user decision; the model cannot approve its own gate', () => {
  let list = complete(begin(createSessionTodo(steps), 'discuss'), 'discuss');
  expect(() => complete(list, 'agree')).toThrow(/user/i);
  list = changeSessionTodo(list, { action: 'request_confirmation', revision: list.revision, stepId: 'agree', content: 'Build search with exact matching.' });
  const requestId = list.steps[1]!.confirmation!.id;
  expect(() => confirmSessionTodo(list, { revision: list.revision - 1, stepId: 'agree', requestId, decision: 'approve' })).toThrow(/changed/i);
  const updated = changeSessionTodo(list, { action: 'request_confirmation', revision: list.revision, stepId: 'agree', content: 'Build fuzzy search instead.' });
  expect(() => confirmSessionTodo(updated, { revision: updated.revision, stepId: 'agree', requestId, decision: 'approve' })).toThrow(/confirmation/i);
  const approved = confirmSessionTodo(list, { revision: list.revision, stepId: 'agree', requestId, decision: 'approve' });
  expect(currentSessionTodo(approved)?.id).toBe('build');
  expect(approved.steps[1]!.confirmation?.decision).toBe('approve');
});

it('leaves a declined confirmation current and requires a fresh request before acceptance', () => {
  let list = createSessionTodo([steps[1]!]);
  list = changeSessionTodo(list, { action: 'request_confirmation', revision: list.revision, stepId: 'agree', content: 'Approve proposal' });
  const requestId = list.steps[0]!.confirmation!.id;
  const declined = confirmSessionTodo(list, { revision: list.revision, stepId: 'agree', requestId, decision: 'revise' });
  expect(currentSessionTodo(declined)?.id).toBe('agree');
  expect(() => confirmSessionTodo(declined, { revision: declined.revision, stepId: 'agree', requestId, decision: 'approve' })).toThrow(/confirmation/i);
});

it('preserves completed history and gates changes to an already approved plan', () => {
  let list = complete(begin(createSessionTodo(steps), 'discuss'), 'discuss');
  list = changeSessionTodo(list, { action: 'request_confirmation', revision: list.revision, stepId: 'agree', content: 'Approved plan' });
  list = confirmSessionTodo(list, { revision: list.revision, stepId: 'agree', requestId: list.steps[1]!.confirmation!.id, decision: 'approve' });
  const revised = changeSessionTodo(list, { action: 'revise_remaining', revision: list.revision, reason: 'Need regression coverage', steps: [steps[2]!, { id: 'test', kind: 'task', title: 'Test', acceptance: 'Regression passes' }] });
  expect(revised.steps.slice(0, 2)).toEqual(list.steps.slice(0, 2));
  expect(currentSessionTodo(revised)?.kind).toBe('confirmation');
  expect(currentSessionTodo(revised)?.confirmation?.content).toContain('Need regression coverage');
  expect(revised.changes.at(-1)?.reason).toBe('Need regression coverage');
  expect(() => changeSessionTodo(list, { action: 'revise_remaining', revision: list.revision, reason: 'Drop everything', steps: [] })).toThrow();
});

it('does not remove user gates or change the plan while a step is in progress', () => {
  const list = createSessionTodo(steps);
  expect(() => changeSessionTodo(list, { action: 'revise_remaining', revision: list.revision, reason: 'Skip user', steps: [steps[0]!, steps[2]!] })).toThrow(/confirmation/i);
  const started = begin(list, 'discuss');
  expect(() => changeSessionTodo(started, { action: 'revise_remaining', revision: started.revision, reason: 'Change plan', steps })).toThrow(/boundary/i);
});

it('composes the toolkit with an independent store and exposes no user-decision tool', async () => {
  let list = createSessionTodo([steps[0]!]);
  const tools = sessionTodoTools({ read: async () => list, change: async input => (list = changeSessionTodo(list, input)) });
  expect(tools.map(tool => tool.name)).toEqual(['read_todo_list', 'revise_todo_list', 'update_todo_step', 'complete_todo_step', 'request_todo_confirmation']);
  const call = (name: string, input: unknown) => tools.find(tool => tool.name === name)!.execute(input);
  await call('update_todo_step', { revision: list.revision, stepId: 'discuss', status: 'in_progress', note: 'Discussed' });
  await call('complete_todo_step', { revision: list.revision, stepId: 'discuss', evidence: ['Proposal agreed in discussion'] });
  expect(sessionTodoComplete(JSON.parse(await call('read_todo_list', {})))).toBe(true);
  await expect(call('complete_todo_step', { revision: list.revision, stepId: 'discuss', evidence: [], approve: true })).rejects.toThrow();
});

it('invalidates displayed consent when an attached specification changes', () => {
  let list = createSessionTodo([steps[1]!, steps[2]!]);
  list = changeSessionTodo(list, { action: 'request_confirmation', revision: list.revision, stepId: 'agree', content: 'Old specification' });
  const decision = { revision: list.revision, stepId: 'agree', requestId: list.steps[0]!.confirmation!.id, decision: 'approve' as const };
  const changed = invalidateSessionTodoApproval(list);
  expect(() => confirmSessionTodo(changed, decision)).toThrow(/changed/i);
  const approved = confirmSessionTodo(list, decision);
  const invalidated = invalidateSessionTodoApproval(begin(approved, 'build'));
  expect(currentSessionTodo(invalidated)?.kind).toBe('confirmation');
  expect(invalidated.approvedPlanRevision).not.toBe(invalidated.planRevision);
  expect(invalidated.steps[0]).toEqual(approved.steps[0]);
});
