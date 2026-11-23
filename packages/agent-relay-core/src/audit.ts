/**
 * What the person does from the audit (bots design 7), applied to the Teams. Stopping a chain, or one bot's part of it, withdraws
 * the chain's waiting messages, asks the Hosts to stop the turns that run in it, and stops its temporary bots; the chain record says
 * it was stopped, so a bot's later call in it is refused. Pausing a standing bot holds its inbox until it is resumed. Nothing here
 * limits what bots do on their own: only the person's decisions act.
 */
import type { ChainAction } from '@orchardworks/agent-remote-protocol';
import { temporaryBotId } from './chain-scope.js';
import { taskAction } from './tasks.js';
import type { SavedTeam } from './team-delivery.js';

const fail = (message: string): never => { throw new Error(message); };
const running = (team: SavedTeam) => team.status === 'active' && (team.task?.state === 'working' || team.task?.state === 'needs_input');
/** The bot a Team belongs to: a standing bot's inbox, or a temporary bot's task. */
const botOf = (team: SavedTeam) => team.inbox?.botId ?? (team.task ? temporaryBotId(team.id) : undefined);

/** Stops a chain in the Teams, or one bot's part of it; returns how many messages were withdrawn and turns asked to stop. */
export function stopInTeams(teams: SavedTeam[], chainId: string, botId: string | undefined, now: number): { withdrawn: number; interrupted: number; stopped: number } {
  let withdrawn = 0, interrupted = 0, stopped = 0;
  for (const team of teams) {
    const mine = !botId || botOf(team) === botId;
    if (!mine) continue;
    for (const message of team.messages) if (message.chain === chainId && message.status === 'queued' && (!botId || !team.task || message.to === team.members[0]!.id)) { message.status = 'canceled'; withdrawn++; }
    for (const member of team.members) if (member.chain?.id === chainId && (!botId || !team.task || member.role === 'leader')) { member.interrupt = now; interrupted++; }
    // A temporary bot working in this chain stops with it.
    if (team.task && running(team) && team.members[0]!.chain?.id === chainId) { taskAction(team, 'cancel_task', now); stopped++; }
  }
  return { withdrawn, interrupted, stopped };
}
/** Pauses, resumes or retires one bot. */
export function actOnBot(teams: SavedTeam[], action: Extract<ChainAction, { botId: string; chainId?: never }>, now: number): { botId: string; state: string } {
  const team = teams.find(item => botOf(item) === action.botId && item.status !== 'archived') ?? fail('No bot of this account has that id.');
  if (action.action === 'retire_bot') {
    if (!team.task) fail('A standing bot is paused, or removed from its group in Chats; retiring ends a temporary bot.');
    if (running(team)) taskAction(team, 'mark_task_done', now);
    return { botId: action.botId, state: team.task!.state };
  }
  const inbox = team.inbox ?? fail('A temporary bot is stopped or retired, not paused.');
  if (action.action === 'pause_bot') inbox.paused = true; else delete inbox.paused;
  team.revision++; team.updatedAt = now;
  return { botId: action.botId, state: inbox.paused ? 'paused' : 'active' };
}
