/**
 * The account's chains (bots design 7), kept beside its Teams. A chain is named by its cause: the person's input to a session, a
 * timer of a bot, or a bot's turn whose cause the Relay cannot tell. A call finds its chain from the turn it is made in; what the call
 * did is added to the chain's counts. The account keeps at most `CHAIN_LIMIT` chains and none past `CHAIN_RETENTION_MS`: the oldest
 * go first.
 */
import { createHash, randomUUID } from 'node:crypto';
import { CHAIN_APPROVAL_LIMIT, CHAIN_BOT_LIMIT, CHAIN_LIMIT, CHAIN_RETENTION_MS, type BotChain, type ChainThresholds, type TurnCause } from '@orchardworks/agent-remote-protocol';
import type { SavedTeam } from './team-delivery.js';
import type { ChainScope } from './chain-scope.js';

export interface ChainStore { read(): readonly BotChain[]; change<T>(update: (chains: BotChain[]) => T): Promise<T>;
  thresholds(): ChainThresholds; setThresholds(thresholds: ChainThresholds): Promise<void> }
export type Passed = NonNullable<BotChain['passed']>[number];
type Session = { providerId: string; nativeSessionId: string };
const fail = (message: string): never => { throw new Error(message); };
const chainId = (parts: unknown[]) => 'c_' + createHash('sha256').update(JSON.stringify(parts)).digest('hex').slice(0, 16);
/** The chain of the person's input to a session, named by its message. */
export const personChainId = (session: Session, messageId: string) => chainId(['person', session.providerId, session.nativeSessionId, messageId]);
/** The chain the person's edit of a bot's board starts at that bot. */
export const editChainId = (botId: string, at: number) => chainId(['edit', botId, at]);
/** A chain a timer starts when it comes due. */
export const timerChainId = (inboxId: string, timer: string, at: number) => chainId(['timer', inboxId, timer, at]);

/** An in-memory store, for a broker without saved state. */
export function memoryChains(): ChainStore {
  let chains: BotChain[] = [], thresholds: ChainThresholds = {};
  return { read: () => chains, change: async update => { const draft = structuredClone(chains); const value = update(draft); chains = draft; return value; },
    thresholds: () => thresholds, setThresholds: async next => { thresholds = structuredClone(next); } };
}

export class BotChains {
  constructor(private readonly store: ChainStore, private readonly now: () => number, private readonly sameSession: (a: Session & { hostId: string }, b: Session & { hostId: string }) => boolean,
    /** A chain passed one of the person's thresholds: told once for each. */
    private readonly passed: (chain: BotChain, passed: Passed[]) => void = () => {}) {}
  /**
   * The chain of a bot's turn. The person's input names one by its message; input the Relay framed belongs to the chain of the latest
   * message the Relay handed to that session; a turn with neither starts a chain of its own.
   */
  find(teams: readonly SavedTeam[], session: Session & { hostId: string }, cause: TurnCause | undefined): { id: string; cause: BotChain['cause'] } {
    if (cause?.kind === 'person') return { id: personChainId(session, cause.messageId), cause: 'person' };
    let latest: { id: string; at: number } | undefined;
    for (const team of teams) for (const member of team.members) {
      if (!member.chain || !member.nativeSessionId || latest && member.chain.at <= latest.at) continue;
      if (this.sameSession({ hostId: member.hostId, providerId: member.providerId, nativeSessionId: member.nativeSessionId }, session)) latest = member.chain;
    }
    return latest ? { id: latest.id, cause: 'bot' } : { id: chainId(['bot', randomUUID()]), cause: 'bot' };
  }
  /** Adds what a call in a chain did, starting the chain at this bot if it is new. */
  async record(scope: ChainScope, start: { cause: BotChain['cause']; bot: string }, turn?: { tokens: number; costUsd?: number }): Promise<void> {
    if (!turn && !scope.messages && !scope.created && !scope.subSessions && !scope.bots.size) return;
    const limits = this.store.thresholds();
    const crossed = await this.store.change(chains => {
      const now = this.now();
      const chain = chains.find(item => item.id === scope.id) ?? began(chains, scope.id, start, now);
      for (const bot of scope.bots) if (!chain.bots.includes(bot) && chain.bots.length < CHAIN_BOT_LIMIT) chain.bots.push(bot);
      chain.messages += scope.messages; chain.created += scope.created; if (scope.subSessions) chain.subSessions = (chain.subSessions ?? 0) + scope.subSessions; chain.depth = Math.max(chain.depth, scope.depth);
      if (turn) {
        chain.turns++; chain.usage.tokens += turn.tokens;
        if (turn.costUsd !== undefined) chain.usage.costUsd = (chain.usage.costUsd ?? 0) + turn.costUsd;
      }
      chain.updatedAt = now;
      // What the chain passed for the first time, measured against the person's thresholds as they are now.
      const over = { tokens: limits.tokens !== undefined && chain.usage.tokens >= limits.tokens, depth: limits.depth !== undefined && chain.depth >= limits.depth,
        minutes: limits.minutes !== undefined && now - chain.startedAt >= limits.minutes * 60_000 };
      const passed = (Object.keys(over) as Passed[]).filter(key => over[key] && !chain!.passed?.includes(key));
      if (passed.length) chain.passed = [...chain.passed ?? [], ...passed];
      const found = structuredClone(chain);
      prune(chains, now);
      return passed.length ? { chain: found, passed } : undefined;
    });
    if (crossed) this.passed(crossed.chain, crossed.passed);
  }
  /** The person allowed tool use in a folder for the rest of a chain, which starts at this bot if it is new; the same choice twice is one. */
  async approve(id: string, start: { cause: BotChain['cause']; bot: string }, cwd: string): Promise<void> {
    await this.store.change(chains => {
      const now = this.now(), chain = chains.find(item => item.id === id) ?? began(chains, id, start, now);
      if (chain.approvals?.some(item => item.cwd === cwd)) return;
      if ((chain.approvals?.length ?? 0) >= CHAIN_APPROVAL_LIMIT) fail('This chain already holds the most standing approvals; revoke one first.');
      (chain.approvals ??= []).push({ cwd, at: now, applied: 0 });
      chain.updatedAt = now;
    });
  }
  /**
   * Whether a standing approval of this chain covers tool use in this folder, counting the use. A chain the person stopped, or
   * stopped for this bot, answers nothing; a chain past its retention is gone, and so are its approvals.
   */
  async covers(id: string, bot: string, cwd: string): Promise<boolean> {
    if (this.stopped(id, bot) || !this.store.read().some(chain => chain.id === id && chain.approvals?.some(item => item.cwd === cwd))) return false;
    await this.store.change(chains => { chains.find(item => item.id === id)!.approvals!.find(item => item.cwd === cwd)!.applied++; });
    return true;
  }
  /** The person ends a standing approval: tool use in that folder asks again. */
  async revoke(id: string, cwd: string): Promise<void> {
    await this.store.change(chains => {
      const chain = chains.find(item => item.id === id) ?? fail('No chain of this account has that id.');
      const kept = (chain.approvals ?? []).filter(item => item.cwd !== cwd);
      if (kept.length === (chain.approvals?.length ?? 0)) fail('That approval is not standing in this chain.');
      if (kept.length) chain.approvals = kept; else delete chain.approvals;
    });
  }
  thresholds(): ChainThresholds { return this.store.thresholds(); }
  setThresholds(thresholds: ChainThresholds): Promise<void> { return this.store.setThresholds(thresholds); }
  /** Marks a chain, or one bot's part of it, as stopped by the person. */
  async stop(id: string, botId?: string): Promise<void> {
    await this.store.change(chains => {
      const chain = chains.find(item => item.id === id) ?? fail('No chain of this account has that id.');
      if (botId) { if (!(chain.stoppedBots ??= []).includes(botId)) chain.stoppedBots.push(botId); } else chain.stopped = this.now();
      chain.updatedAt = this.now();
    });
  }
  /** Whether the person stopped this chain, or this bot's part of it. */
  stopped(id: string, botId: string): boolean {
    const chain = this.store.read().find(item => item.id === id);
    return !!chain && (chain.stopped !== undefined || !!chain.stoppedBots?.includes(botId));
  }
  list(): BotChain[] { return [...this.store.read()].sort((a, b) => b.updatedAt - a.updatedAt); }
}
function began(chains: BotChain[], id: string, start: { cause: BotChain['cause']; bot: string }, now: number): BotChain {
  const chain: BotChain = { id, cause: start.cause, bot: start.bot, bots: [start.bot], messages: 0, turns: 0, created: 0, depth: 0, usage: { tokens: 0 }, startedAt: now, updatedAt: now };
  chains.push(chain);
  return chain;
}
function prune(chains: BotChain[], now: number): void {
  const kept = chains.filter(chain => now - chain.updatedAt <= CHAIN_RETENTION_MS).sort((a, b) => b.updatedAt - a.updatedAt).slice(0, CHAIN_LIMIT);
  chains.splice(0, chains.length, ...kept);
}
