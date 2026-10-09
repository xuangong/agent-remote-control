import type { AgentUsage } from '@orchardworks/agent-provider-sdk';

/** Native call input includes cache reads and writes; public categories do not overlap. */
export function copilotCallUsage(data: Record<string, unknown>): AgentUsage | undefined {
  const usage: AgentUsage = {};
  if (tokens(data.outputTokens)) usage.outputTokens = data.outputTokens;
  if (tokens(data.cacheReadTokens)) usage.cachedInputTokens = data.cacheReadTokens;
  if (tokens(data.cacheWriteTokens)) usage.cacheCreationInputTokens = data.cacheWriteTokens;
  if (tokens(data.inputTokens) && tokens(data.cacheReadTokens) && tokens(data.cacheWriteTokens)) {
    const uncached = data.inputTokens - data.cacheReadTokens - data.cacheWriteTokens;
    if (tokens(uncached)) usage.inputTokens = uncached;
  }
  if (tokens(data.inputTokens) && tokens(data.outputTokens)) {
    const total = data.inputTokens + data.outputTokens;
    if (tokens(total)) usage.totalTokens = total;
  }
  return tokens(data.inputTokens) || Object.keys(usage).length ? { tokenScope: 'call', ...usage } : undefined;
}

export function copilotContextUsage(data: Record<string, unknown>): AgentUsage | undefined {
  const usage: AgentUsage = {};
  if (tokens(data.currentTokens)) usage.contextWindowUsedTokens = data.currentTokens;
  if (tokens(data.tokenLimit) && data.tokenLimit > 0) usage.contextWindowMaxTokens = data.tokenLimit;
  return Object.keys(usage).length ? { contextScope: 'current', ...usage } : undefined;
}

function tokens(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
