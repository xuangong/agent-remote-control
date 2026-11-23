/**
 * The chain a bot's call works in (bots design 7). A call runs inside its chain's scope; what the call adds to the Teams is the
 * chain's: each message it queues carries the chain, the bots its messages reach and the bots it creates join it, and the replies it
 * adds deepen it. One wrapper of the Team change sees every addition, so no path that queues a message has to know about chains.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { SavedTeam } from './team-delivery.js';

export interface ChainScope { readonly id: string; readonly bots: Set<string>; messages: number; created: number; depth: number }
const scopes = new AsyncLocalStorage<ChainScope>();
/** Runs a call in a chain's scope. */
export const inChain = <T>(scope: ChainScope, run: () => Promise<T>): Promise<T> => scopes.run(scope, run);
export const chainScope = (id: string): ChainScope => ({ id, bots: new Set(), messages: 0, created: 0, depth: 0 });
/** A temporary bot's id, derived from its task. */
export const temporaryBotId = (teamId: string) => 'b_' + createHash('sha256').update(JSON.stringify(['temporary', teamId])).digest('hex').slice(0, 32);

type Seen = Map<string, { messages: Set<string>; recent: Set<string> }>;
/** What the Teams hold before a change, for `stampChain` to tell what it added. */
export function seenBefore(teams: readonly SavedTeam[]): Seen | undefined {
  if (!scopes.getStore() && !teams.some(team => team.room)) return undefined;
  return new Map(teams.map(team => [team.id, { messages: new Set(team.messages.map(message => message.id)), recent: new Set((team.inbox?.recent ?? []).map(item => item.id)) }]));
}
/**
 * Gives what a change added its chain. In a call's scope: the scope's chain, counted in the scope. Outside one, a room's new turn
 * keeps the chain of the room's latest message, so a room moving on time stays in the chain that opened it.
 */
export function stampChain(before: Seen | undefined, teams: SavedTeam[]): void {
  if (!before) return;
  const scope = scopes.getStore();
  for (const team of teams) {
    // A bot's standing instructions are the system's, sent when they change, not part of what a chain did.
    const seen = before.get(team.id), added = team.messages.filter(message => !seen?.messages.has(message.id) && !message.chain && !message.text.startsWith('[Your standing instructions'));
    if (!scope) {
      const chain = team.room && [...team.messages].reverse().find(message => message.chain)?.chain;
      if (chain) for (const message of added) message.chain = chain;
      continue;
    }
    if (!seen && (team.task || team.inbox)) { scope.created++; scope.bots.add(team.task ? temporaryBotId(team.id) : team.inbox!.botId); }
    for (const message of added) {
      message.chain = scope.id; scope.messages++;
      if (team.inbox) scope.bots.add(team.inbox.botId);
      else if (team.task && message.to === team.members[0]!.id) scope.bots.add(temporaryBotId(team.id));
    }
    for (const item of team.inbox?.recent ?? []) if (!seen?.recent.has(item.id)) scope.depth = Math.max(scope.depth, item.hop);
  }
}
