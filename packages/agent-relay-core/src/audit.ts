/**
 * What the person does from the audit (bots design 7), applied to the Teams. Stopping a chain, or one bot's part of it, withdraws
 * the chain's waiting messages, asks the Hosts to stop the turns that run in it, and stops its temporary bots; the chain record says
 * it was stopped, so a bot's later call in it is refused. Pausing a standing bot holds its inbox until it is resumed. Nothing here
 * limits what bots do on their own: only the person's decisions act.
 */
import type { ChainAction } from '@orchardworks/agent-remote-protocol';
import type { SavedTeam } from './team-delivery.js';

const fail = (message: string): never => { throw new Error(message); };
const running = (team: SavedTeam) => team.status === 'active' && !!team.task && team.task.state !== 'ended';
/** The bot a Team belongs to: a standing bot's inbox. */
const botOf = (team: SavedTeam) => team.inbox?.botId;

/** Stops a chain in the Teams, or one bot's part of it; returns how many messages were withdrawn and turns asked to stop. */
export function stopInTeams(teams: SavedTeam[], chainId: string, botId: string | undefined, now: number): { withdrawn: number; interrupted: number; stopped: number } {
  let withdrawn = 0, interrupted = 0, stopped = 0;
  for (const team of teams) {
    const mine = !botId || botOf(team) === botId;
    if (!mine) continue;
    for (const message of team.messages) if (message.chain === chainId && message.status === 'queued' && (!botId || !team.task || message.to === team.members[0]!.id)) { message.status = 'canceled'; withdrawn++; }
    for (const member of team.members) if (member.chain?.id === chainId && (!botId || !team.task || member.role === 'leader')) { member.interrupt = now; interrupted++; }
    // A sub-session whose turn runs in this chain is interrupted and stays, idle, with its context; the person ends it with Stop.
    if (team.task && running(team) && team.members[0]!.chain?.id === chainId) stopped++;
  }
  return { withdrawn, interrupted, stopped };
}
/** Pauses or resumes one standing bot. */
export function actOnBot(teams: SavedTeam[], action: Exclude<Extract<ChainAction, { botId: string; chainId?: never }>, { action: 'set_chief' | 'set_primary' | 'update_board' }>, now: number): { botId: string; state: string } {
  const team = teams.find(item => botOf(item) === action.botId && item.status !== 'archived') ?? fail('No bot of this account has that id.');
  const inbox = team.inbox ?? fail('Only a standing bot is paused or resumed.');
  if (action.action === 'pause_bot') inbox.paused = true; else delete inbox.paused;
  team.revision++; team.updatedAt = now;
  return { botId: action.botId, state: inbox.paused ? 'paused' : 'active' };
}
