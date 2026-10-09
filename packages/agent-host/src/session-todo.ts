import { randomUUID } from 'node:crypto';
import { bindAgentSessionTools, type AgentSessionTool } from '@orchardworks/agent-provider-sdk';
import { isSessionTodoChange, isSessionTodoDecision, isSessionTodoList, type SessionTodoChange, type SessionTodoDecision, type SessionTodoDefinition, type SessionTodoList } from '@orchardworks/agent-remote-protocol';

export const currentSessionTodo = (list: SessionTodoList) => list.steps.find(step => step.status !== 'completed');
export const sessionTodoComplete = (list: SessionTodoList) => list.steps.length > 0 && !currentSessionTodo(list);
const definition = ({ id, title, acceptance, kind }: SessionTodoDefinition): SessionTodoDefinition => ({ id, title, acceptance, kind });
function checked(list: SessionTodoList): SessionTodoList {
  if (!isSessionTodoList(list) || list.steps.some(step => !step.title.trim() || !step.acceptance.trim())
    || new Set(list.steps.map(step => step.id)).size !== list.steps.length) throw new Error('Invalid todo list or duplicate step identity.');
  if (Buffer.byteLength(JSON.stringify(list)) > 128 * 1024) throw new Error('The todo list exceeds its size budget. Keep the plan and evidence concise.');
  return list;
}
export function createSessionTodo(steps: SessionTodoDefinition[]): SessionTodoList {
  return checked({ revision: 1, planRevision: 1, steps: steps.map(step => ({ ...definition(step), status: 'pending' })), changes: [] });
}
function editable(list: SessionTodoList, revision: number): SessionTodoList {
  if (list.revision !== revision) throw new Error('The todo list changed. Read its current revision before continuing.');
  return structuredClone(list);
}
function current(list: SessionTodoList, stepId: string) {
  const step = currentSessionTodo(list);
  if (!step || step.id !== stepId) throw new Error('Only the current first unfinished todo step can progress.');
  return step;
}
export function changeSessionTodo(list: SessionTodoList, input: SessionTodoChange): SessionTodoList {
  if (!isSessionTodoChange(input)) throw new Error('Invalid todo change.');
  const next = editable(list, input.revision);
  if (input.action === 'revise_remaining') {
    if (!input.reason.trim()) throw new Error('A plan change requires a reason.');
    const step = currentSessionTodo(next);
    if (step && step.status !== 'pending') throw new Error('Revise the remaining plan at a step boundary, after completing the current step.');
    const prefix = step ? next.steps.indexOf(step) : next.steps.length;
    const remaining = next.steps.slice(prefix);
    for (const gate of remaining.filter(step => step.kind === 'confirmation')) {
      if (!input.steps.some(step => step.id === gate.id && step.kind === 'confirmation')) throw new Error('A pending user confirmation cannot be removed or converted to a task.');
    }
    next.changes.push({ revision: next.planRevision, reason: input.reason, previous: remaining.map(definition) });
    next.changes = next.changes.slice(-20);
    const replacement: SessionTodoList['steps'] = input.steps.map(step => ({ ...definition(step), status: 'pending' }));
    if (next.approvedPlanRevision !== undefined) {
      const removed = remaining.filter(old => !replacement.some(step => step.id === old.id));
      const content = `Plan change: ${input.reason}${removed.length ? '\n\nRemoved steps:\n' + removed.map(step => '- ' + step.title + ': ' + step.acceptance).join('\n') : ''}\n\nRemaining plan:\n${replacement.map((step, index) => `${index + 1}. ${step.title}\n   ${step.acceptance}`).join('\n')}`;
      if (replacement[0]?.kind === 'confirmation') {
        replacement[0].status = 'waiting'; replacement[0].confirmation = { id: randomUUID(), content };
      } else replacement.unshift({ id: randomUUID(), kind: 'confirmation', title: 'Confirm revised plan', acceptance: 'The user explicitly agrees to the revised remaining work.', status: 'waiting', confirmation: { id: randomUUID(), content } });
    }
    next.steps = [...next.steps.slice(0, prefix), ...replacement];
    next.planRevision++;
  } else {
    const step = current(next, input.stepId);
    if (input.action === 'request_confirmation') {
      if (step.kind !== 'confirmation' || !input.content.trim()) throw new Error('A user confirmation step needs concrete content to approve.');
      step.status = 'waiting'; step.confirmation = { id: randomUUID(), content: input.content };
    } else {
      if (step.kind === 'confirmation') throw new Error('Only an explicit user decision can complete a confirmation step.');
      if (input.action === 'progress') { step.status = input.status; step.note = input.note; }
      else {
        if (step.status === 'pending') throw new Error('Start the current step before completing it.');
        if (!input.evidence.some(value => value.trim())) throw new Error('Completion requires concrete evidence.');
        step.status = 'completed'; step.evidence = input.evidence;
      }
    }
  }
  next.revision++;
  return checked(next);
}

/** A changed attached specification invalidates consent without rewriting completed history. */
export function invalidateSessionTodoApproval(list: SessionTodoList): SessionTodoList {
  const next = structuredClone(list);
  const step = currentSessionTodo(next);
  if (!step) throw new Error('Reopen the completed list before changing its specification.');
  if (next.approvedPlanRevision !== undefined && step.kind !== 'confirmation') {
    step.status = 'pending';
    next.steps.splice(next.steps.indexOf(step), 0, { id: randomUUID(), title: 'Confirm updated specification', acceptance: 'The user explicitly agrees to the updated specification and remaining plan.', kind: 'confirmation', status: 'pending' });
  } else if (step.kind === 'confirmation') {
    step.status = 'pending'; delete step.confirmation;
  }
  next.changes.push({ revision: next.planRevision, reason: 'Specification or acceptance criteria changed.', previous: next.steps.filter(step => step.status !== 'completed').map(definition) });
  next.changes = next.changes.slice(-20);
  next.planRevision++; next.revision++;
  return checked(next);
}

/** Call only from an authenticated user action, never a model tool. */
export function confirmSessionTodo(list: SessionTodoList, input: SessionTodoDecision): SessionTodoList {
  if (!isSessionTodoDecision(input)) throw new Error('Invalid todo confirmation.');
  const next = editable(list, input.revision);
  const step = current(next, input.stepId);
  if (step.kind !== 'confirmation' || step.status !== 'waiting' || step.confirmation?.id !== input.requestId || step.confirmation.decision) throw new Error('This confirmation is no longer awaiting a user decision.');
  step.confirmation.decision = input.decision;
  step.status = input.decision === 'approve' ? 'completed' : 'pending';
  if (input.decision === 'approve') next.approvedPlanRevision = next.planRevision;
  next.revision++;
  return checked(next);
}

export interface SessionTodoAccess {
  read(): Promise<SessionTodoList>;
  change(input: SessionTodoChange): Promise<SessionTodoList>;
}
export const sessionTodoInstructions = `Use read_todo_list to inspect the current execution list. Only its first unfinished step can progress. Start a task with update_todo_step, then complete_todo_step with concrete evidence. Use revise_todo_list at step boundaries to replace the unfinished suffix; completed steps stay immutable and pending user confirmations must remain. Plan changes after approval require renewed user confirmation. Use request_todo_confirmation for a confirmation step; only the user can approve it in the view. Conversation, silence, timeouts and your own assessment do not approve it. Wait without repeated reminders. Native idle is not task completion. This list does not grant any native tool permission.`;

/** Storage and role independent toolkit; the caller supplies atomic durable updates. */
export function sessionTodoTools(access: SessionTodoAccess): AgentSessionTool[] {
  const revision = { type: 'integer', minimum: 1 }, id = { type: 'string', minLength: 1, maxLength: 128 }, text = { type: 'string', minLength: 1, maxLength: 2048 };
  const step = { type: 'object', properties: { id, title: { ...text, maxLength: 256 }, acceptance: text, kind: { type: 'string', enum: ['task', 'confirmation'] } }, required: ['id', 'title', 'acceptance', 'kind'], additionalProperties: false };
  const tool = (name: string, description: string, properties: Record<string, unknown>, run: (args: any) => Promise<SessionTodoList>): AgentSessionTool => ({ name, description,
    inputSchema: { type: 'object', properties, required: Object.keys(properties), additionalProperties: false }, execute: async args => JSON.stringify(await run(args)) });
  return bindAgentSessionTools([
    tool('read_todo_list', 'Read the ordered execution list, current revision and user confirmation state.', {}, () => access.read()),
    tool('revise_todo_list', 'Replace only unfinished steps at a step boundary. Keep pending confirmation gates. Changes after approval require renewed user agreement.', { revision, reason: text, steps: { type: 'array', minItems: 1, maxItems: 100, items: step } }, args => access.change({ ...args, action: 'revise_remaining' })),
    tool('update_todo_step', 'Start or record waiting for the current task. Cannot progress a later task or approve a user gate.', { revision, stepId: id, status: { type: 'string', enum: ['in_progress', 'waiting'] }, note: text }, args => access.change({ ...args, action: 'progress' })),
    tool('complete_todo_step', 'Complete the current task with attributable evidence. Cannot complete user confirmation steps.', { revision, stepId: id, evidence: { type: 'array', minItems: 1, maxItems: 20, items: text } }, args => access.change({ ...args, action: 'complete' })),
    tool('request_todo_confirmation', 'Present the exact proposal for the current user confirmation step. Replacing it invalidates the previous request.', { revision, stepId: id, content: { ...text, maxLength: 16000 } }, args => access.change({ ...args, action: 'request_confirmation' })),
  ]);
}
