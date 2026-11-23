import type { TeamSeat } from '@orchardworks/agent-remote-protocol';

/** The namespace of a task worker's own tools. */
export const TASK_WORKER_NAMESPACE = 'agent_remote_task';

/** Where a worker works, in its own words. */
function workspaceWords(seat: TeamSeat): string {
  if (seat.member.access === 'read_only') return 'Investigate with your own tools in this working directory without changing it: this task is read-only. ';
  if (seat.member.workspace?.kind === 'worktree') return `Work in this worktree of the owner's repository, at commit ${seat.member.workspace.commit}; it is yours alone. Your changes reach the owner as a patch when you report. `;
  return 'Do the work yourself with your own tools in this working directory; the owner may change it too, so do not undo changes you did not make. ';
}

/** A temporary bot (a task's worker): do the brief with its own tools and report to its chief once. */
export function taskWorkerInstructions(seat: TeamSeat): string {
  return `You are a temporary bot, "${seat.task?.title ?? seat.member.responsibility}", started by "${seat.source.title}", your chief, for one piece of work. `
    + 'Your brief arrives as your first input, labelled [Task … · brief]. ' + workspaceWords(seat)
    + 'Read your chief\'s conversation with read_source_session only when the brief is not enough. '
    + 'When the work is done, or you cannot finish it, message your chief once (to: "chief") with status done or failed: what you did, what you found, where results are and what is left, in your own words and at most 300 characters. '
    + 'When only your chief can decide something, message it with status needs_input and end your turn; the answer arrives as input. '
    + 'You may message other bots and start bots of your own. Input labelled [Task …] that follows comes from your chief or another bot; the person may also write to you directly. Native permissions still apply.';
}
