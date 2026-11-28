import type { AgentUsage } from '@orchardworks/agent-remote-protocol';

export interface UsageParts { input?: number; cachedInput?: number; cacheCreation?: number; output?: number }
const PART_KEYS = ['input', 'cachedInput', 'cacheCreation', 'output'] as const;
const partsOf = (usage: AgentUsage): UsageParts => ({ ...(usage.inputTokens !== undefined ? { input: usage.inputTokens } : {}), ...(usage.cachedInputTokens !== undefined ? { cachedInput: usage.cachedInputTokens } : {}),
  ...(usage.cacheCreationInputTokens !== undefined ? { cacheCreation: usage.cacheCreationInputTokens } : {}), ...(usage.outputTokens !== undefined ? { output: usage.outputTokens } : {}) });
/** Cumulative usage of one session over its turns. */
export interface SessionUsage {
  tokens: number;
  costUsd?: number;
  /** The four parts a provider reports, each counted like the total (input excludes cached and cache-written tokens): what the cost estimate prices. */
  parts?: UsageParts;
  lastParts?: { scope: 'session' | 'runtime'; parts: UsageParts };
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
export function accountUsage(total: SessionUsage, usage: AgentUsage, turnCompleted: boolean): boolean {
  const tokens = tokensOf(usage), cost = usage.totalCostUsd, scope = usage.tokenScope;
  if (tokens === undefined && cost === undefined) return false;
  let addTokens = 0, addCost = 0;
  const given = partsOf(usage), addParts: UsageParts = {};
  if (scope === 'session' || scope === 'runtime') {
    const last = total.last?.scope === scope ? total.last : undefined;
    const restarted = (value: number | undefined, previous: number | undefined) => scope === 'runtime' && value !== undefined && previous !== undefined && value < previous;
    const fresh = restarted(tokens, last?.tokens) || restarted(cost, last?.costUsd);
    if (tokens !== undefined) addTokens = fresh || last === undefined ? tokens : Math.max(0, tokens - last.tokens);
    if (cost !== undefined) addCost = fresh || last?.costUsd === undefined ? cost : Math.max(0, cost - last.costUsd);
    total.last = { scope, tokens: tokens ?? last?.tokens ?? 0, ...(cost !== undefined ? { costUsd: cost } : last?.costUsd !== undefined ? { costUsd: last.costUsd } : {}) };
    const lastParts = total.lastParts?.scope === scope ? total.lastParts.parts : undefined;
    for (const key of PART_KEYS) if (given[key] !== undefined) addParts[key] = fresh || lastParts?.[key] === undefined ? given[key]! : Math.max(0, given[key]! - lastParts[key]!);
    total.lastParts = { scope, parts: { ...lastParts, ...given } };
  } else if (scope === 'call' || scope === 'turn' && turnCompleted) {
    addTokens = tokens ?? 0; addCost = cost ?? 0;
    for (const key of PART_KEYS) if (given[key] !== undefined) addParts[key] = given[key]!;
  } else return false;
  for (const key of PART_KEYS) if (addParts[key]) (total.parts ??= {})[key] = (total.parts?.[key] ?? 0) + addParts[key]!;
  if (!addTokens && !addCost) return false;
  total.tokens += addTokens;
  if (addCost) total.costUsd = (total.costUsd ?? 0) + addCost;
  return true;
}
