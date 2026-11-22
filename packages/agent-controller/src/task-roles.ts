import { TASK_SUMMARY_LIMIT, type TeamHostCall, type TeamSeat } from '@orchardworks/agent-remote-protocol';
import type { AgentSessionTool } from '@orchardworks/agent-provider-sdk';

type Call = (input: Omit<Extract<TeamHostCall, { action: 'report_task' }>, 'teamId' | 'memberId'>) => Promise<unknown>;

/** A task's worker: do the brief with its own tools and report once. */
export function taskWorkerInstructions(seat: TeamSeat): string {
  return `You are the worker of task ${seat.teamId}, "${seat.task?.title ?? seat.member.responsibility}", started by the session "${seat.source.title}". `
    + 'Your brief arrives as your first input, labelled [Task … · brief]. Do the work yourself with your own tools in this working directory; the owner may change it too, so do not undo changes you did not make. '
    + 'Read the owner\'s conversation with read_source_session only when the brief is not enough. '
    + 'When the task is done, or you cannot finish it, call report_task once with status done or failed and a summary the owner can act on without reading your conversation: what you did, what you found, where results are, and what is left. '
    + 'Input labelled [Task …] that follows comes from the person or the owner about this task. Native permissions still apply.';
}

/** The worker's report_task tool. */
export function reportTaskTool(call: Call): AgentSessionTool {
  return {
    name: 'report_task',
    description: 'Report this task\'s result to the session that started it, once. status: done when the brief is met, failed when it cannot be. The summary is all the owner reads: say what you did, what you found, where results are and what is left.',
    inputSchema: { type: 'object', properties: { status: { type: 'string', enum: ['done', 'failed'] }, summary: { type: 'string', minLength: 1, maxLength: TASK_SUMMARY_LIMIT } },
      required: ['status', 'summary'], additionalProperties: false },
    execute: async args => JSON.stringify(await call({ action: 'report_task', status: (args as { status: 'done' | 'failed' }).status, summary: (args as { summary: string }).summary })),
  };
}
