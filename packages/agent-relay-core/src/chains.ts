/**
 * The account's chains (bots design 7), kept beside its Teams. A chain is named by its cause: the person's input to a session, a
 * timer of a bot, or a bot's turn whose cause the Relay cannot tell. A call finds its chain from the turn it is made in; what the call
 * did is added to the chain's counts. The account keeps at most `CHAIN_LIMIT` chains and none past `CHAIN_RETENTION_MS`: the oldest
 * go first.
 */
import { createHash, randomUUID } from 'node:crypto';
import { CHAIN_BOT_LIMIT, CHAIN_LIMIT, CHAIN_RETENTION_MS, type BotChain, type TurnCause } from '@orchardworks/agent-remote-protocol';
import type { SavedTeam } from './team-delivery.js';
import type { ChainScope } from './chain-scope.js';

export interface ChainStore { read(): readonly BotChain[]; change<T>(update: (chains: BotChain[]) => T): Promise<T> }
type Session = { providerId: string; nativeSessionId: string };
const chainId = (parts: unknown[]) => 'c_' + createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
/** A chain a timer starts when it comes due. */
export const timerChainId = (inboxId: string, timer: string, at: number) => chainId(['timer', inboxId, timer, at]);

/** An in-memory store, for a broker without saved state. */
export function memoryChains(): ChainStore {
  let chains: BotChain[] = [];
  return { read: () => chains, change: async update => { const draft = structuredClone(chains); const value = update(draft); chains = draft; return value; } };
}

export class BotChains {
  constructor(private readonly store: ChainStore, private readonly now: () => number, private readonly sameSession: (a: Session & { hostId: string }, b: Session & { hostId: string }) => boolean) {}
  /**
   * The chain of a bot's turn. The person's input names one by its message; input the Relay framed belongs to the chain of the latest
   * message the Relay handed to that session; a turn with neither starts a chain of its own.
   */
  find(teams: readonly SavedTeam[], session: Session & { hostId: string }, cause: TurnCause | undefined): { id: string; cause: BotChain['cause'] } {
    if (cause?.kind === 'person') return { id: chainId(['person', session.providerId, session.nativeSessionId, cause.messageId]), cause: 'person' };
    let latest: { id: string; at: number } | undefined;
    for (const team of teams) for (const member of team.members) {
      if (!member.chain || !member.nativeSessionId || latest && member.chain.at <= latest.at) continue;
      if (this.sameSession({ hostId: member.hostId, providerId: member.providerId, nativeSessionId: member.nativeSessionId }, session)) latest = member.chain;
    }
    return latest ? { id: latest.id, cause: 'bot' } : { id: chainId(['bot', randomUUID()]), cause: 'bot' };
  }
  /** Adds what a call in a chain did, starting the chain at this bot if it is new. */
  async record(scope: ChainScope, start: { cause: BotChain['cause']; bot: string }, turn?: { tokens: number; costUsd?: number }): Promise<void> {
    if (!turn && !scope.messages && !scope.created && !scope.bots.size) return;
    await this.store.change(chains => {
      const now = this.now();
      let chain = chains.find(item => item.id === scope.id);
      if (!chain) {
        chain = { id: scope.id, cause: start.cause, bot: start.bot, bots: [start.bot], messages: 0, turns: 0, created: 0, depth: 0, usage: { tokens: 0 }, startedAt: now, updatedAt: now };
        chains.push(chain);
      }
      for (const bot of scope.bots) if (!chain.bots.includes(bot) && chain.bots.length < CHAIN_BOT_LIMIT) chain.bots.push(bot);
      chain.messages += scope.messages; chain.created += scope.created; chain.depth = Math.max(chain.depth, scope.depth);
      if (turn) {
        chain.turns++; chain.usage.tokens += turn.tokens;
        if (turn.costUsd !== undefined) chain.usage.costUsd = (chain.usage.costUsd ?? 0) + turn.costUsd;
      }
      chain.updatedAt = now;
      prune(chains, now);
    });
  }
  list(): BotChain[] { return [...this.store.read()].sort((a, b) => b.updatedAt - a.updatedAt); }
}
function prune(chains: BotChain[], now: number): void {
  const kept = chains.filter(chain => now - chain.updatedAt <= CHAIN_RETENTION_MS).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, CHAIN_LIMIT);
  chains.splice(0, chains.length, ...kept);
}
