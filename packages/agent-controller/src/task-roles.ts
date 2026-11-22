import { TASK_QUESTION_LIMIT, TASK_SUMMARY_LIMIT, type TeamHostCall, type TeamSeat } from '@orchardworks/agent-remote-protocol';
import type { AgentSessionTool } from '@orchardworks/agent-provider-sdk';

/** The namespace of a task worker's own tools. */
export const TASK_WORKER_NAMESPACE = 'agent_remote_task';

type Worker<A> = Omit<Extract<TeamHostCall, { action: A }>, 'teamId' | 'memberId'>;

/** Where a worker works, in its own words. */
function workspaceWords(seat: TeamSeat): string {
  if (seat.member.access === 'read_only') return 'Investigate with your own tools in this working directory without changing it: this task is read-only. ';
  if (seat.member.workspace?.kind === 'worktree') return `Work in this worktree of the owner's repository, at commit ${seat.member.workspace.commit}; it is yours alone. Your changes reach the owner as a patch when you report. `;
  return 'Do the work yourself with your own tools in this working directory; the owner may change it too, so do not undo changes you did not make. ';
}

/** A task's worker: do the brief with its own tools and report once. */
export function taskWorkerInstructions(seat: TeamSeat): string {
  return `You are the worker of task ${seat.teamId}, "${seat.task?.title ?? seat.member.responsibility}", started by the session "${seat.source.title}". `
    + 'Your brief arrives as your first input, labelled [Task … · brief]. ' + workspaceWords(seat)
    + 'Read the owner\'s conversation with read_source_session only when the brief is not enough. '
    + 'When the task is done, or you cannot finish it, call report_task once with status done or failed and a summary the owner can act on without reading your conversation: what you did, what you found, where results are, and what is left. '
    + 'When only the owner can decide something, ask with ask_owner and end your turn; the answer arrives as input. '
    + 'Input labelled [Task …] that follows comes from the owner about this task; the person may also write to you directly. Native permissions still apply.';
}

/** The worker's report_task tool. */
export function reportTaskTool(call: (input: Worker<'report_task'>) => Promise<unknown>): AgentSessionTool {
  return {
    name: 'report_task',
    description: 'Report this task\'s result to the session that started it, once. status: done when the brief is met, failed when it cannot be. The summary is all the owner reads: say what you did, what you found, where results are and what is left.',
    inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['done', 'failed'] }, summary: { type: 'string', minLength: 1, maxLength: TASK_SUMMARY_LIMIT } },
      required: ['status', 'summary'], additionalProperties: false },
    execute: async args => JSON.stringify(await call({ action: 'report_task', status: (args as { status: 'done' | 'failed' }).status, summary: (args as { summary: string }).summary })),
  };
}

/** The worker's ask_owner tool: the task waits until the owner or the person answers. */
export function askOwnerTool(call: (input: Worker<'ask_owner'>) => Promise<unknown>): AgentSessionTool {
  return {
    name: 'ask_owner',
    description: 'Ask the session that started this task a question only it or the person can answer, then end your turn. The task waits; the answer arrives as input.',
    inputSchema: { type: 'object', properties: { question: { type: 'string', minLength: 1, maxLength: TASK_QUESTION_LIMIT } }, required: ['question'], additionalProperties: false },
    execute: async args => JSON.stringify(await call({ action: 'ask_owner', question: (args as { question: string }).question })),
  };
}
