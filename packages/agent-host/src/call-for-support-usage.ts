import type { AgentUsage } from '@orchardworks/agent-remote-protocol';

/** Cumulative usage of one session, kept with its seat so a restart never counts twice. */
export interface SupportUsage {
  tokens: number;
  costUsd?: number;
  /** The last cumulative report and its scope, to count only increases. */
  last?: { scope: 'session' | 'runtime'; tokens: number; costUsd?: number };
}

const tokensOf = (usage: AgentUsage): number | undefined =>
  usage.totalTokens ?? (usage.inputTokens !== undefined || usage.outputTokens !== undefined ? (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) : undefined);

/**
 * Adds one native usage report to a session's total. Session totals count their increase; runtime totals count
 * their increase, and a decrease means a new runtime that started from zero; turn totals add when the turn
 * completes; call totals add as reported. Returns whether the total changed.
 */
export function accountUsage(total: SupportUsage, usage: AgentUsage, turnCompleted: boolean): boolean {
  const tokens = tokensOf(usage), cost = usage.totalCostUsd, scope = usage.tokenScope;
  if (tokens === undefined && cost === undefined) return false;
  let addTokens = 0, addCost = 0;
  if (scope === 'session' || scope === 'runtime') {
    const last = total.last?.scope === scope ? total.last : undefined;
    const restarted = (value: number | undefined, previous: number | undefined) => scope === 'runtime' && value !== undefined && previous !== undefined && value < previous;
    const fresh = restarted(tokens, last?.tokens) || restarted(cost, last?.costUsd);
    if (tokens !== undefined) addTokens = fresh || last === undefined ? tokens : Math.max(0, tokens - last.tokens);
    if (cost !== undefined) addCost = fresh || last?.costUsd === undefined ? cost : Math.max(0, cost - last.costUsd);
    total.last = { scope, tokens: tokens ?? last?.tokens ?? 0, ...(cost !== undefined ? { costUsd: cost } : last?.costUsd !== undefined ? { costUsd: last.costUsd } : {}) };
  } else if (scope === 'call' || scope === 'turn' && turnCompleted) {
    addTokens = tokens ?? 0; addCost = cost ?? 0;
  } else return false;
  if (!addTokens && !addCost) return false;
  total.tokens += addTokens;
  if (addCost) total.costUsd = (total.costUsd ?? 0) + addCost;
  return true;
}
