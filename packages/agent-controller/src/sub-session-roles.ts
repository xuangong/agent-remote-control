import type { TeamSeat } from '@orchardworks/agent-remote-protocol';

/** The namespace of a sub-session's own tools. */
export const TASK_WORKER_NAMESPACE = 'agent_remote_sub';

/** Where a sub-session works, in its own words. */
function workspaceWords(seat: TeamSeat): string {
  if (seat.member.access === 'read_only') return 'Investigate with your own tools in this working directory without changing it: this work is read-only. ';
  if (seat.member.workspace?.kind === 'worktree') return `Work in this worktree of your bot's repository, at commit ${seat.member.workspace.commit}; it is yours alone. Your changes reach your bot as a patch with your result. `;
  return 'Do the work yourself with your own tools in this working directory; your bot may change it too, so do not undo changes you did not make. ';
}

/**
 * A sub-session's instructions: the only instructions it has (it is no bot, so it gets neither the base instructions nor a mission).
 * It keeps what it learns for more work that may follow, and reports at the end of each piece of work.
 */
export function subSessionInstructions(seat: TeamSeat): string {
  return `You are a sub-session of the bot "${seat.source.title}", named "${seat.task?.title ?? seat.member.responsibility}": a working session of its own, not a bot. `
    + 'Work arrives as input labelled [Sub-session …]; the first is your prompt, and more related work may follow later, so keep what you learn in mind. '
    + workspaceWords(seat)
    + 'Your bot\'s board is shared with you: update the status, links and result of the items you own (board, update_board). '
    + 'At the end of each piece of work call communicate_update with a final_summary: what you did and found, where results are, what is left; only its first 300 characters reach your bot in the input, the rest it reads on request. Use current_step while you work. '
    + 'If you need a decision, say so first in the summary and stop; the answer arrives as the next input. You cannot message or create bots. '
    + 'Read the conversation you were started from with read_main_session only if the prompt is not enough. The person may also write to you directly. Native permissions still apply.';
}
