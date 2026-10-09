import type { AgentUsage } from '@orchardworks/agent-provider-sdk';

/** The native snapshot already accumulates main-agent and sub-agent calls. */
export function copilotSessionUsage(data: Record<string, unknown>): AgentUsage | undefined {
  if (!isRecord(data.modelMetrics)) return undefined;
  const metrics = Object.values(data.modelMetrics);
  if (!metrics.length && data.totalUserRequests !== 0) return undefined;
  const rows = metrics.map(metric => isRecord(metric) && isRecord(metric.usage) ? metric.usage : {});
  const input = sum(rows, 'inputTokens');
  const output = sum(rows, 'outputTokens');
  const read = sum(rows, 'cacheReadTokens');
  const write = sum(rows, 'cacheWriteTokens');
  const usage: AgentUsage = {};
  if (tokens(output)) usage.outputTokens = output;
  if (tokens(read)) usage.cachedInputTokens = read;
  if (tokens(write)) usage.cacheCreationInputTokens = write;
  // Native input includes cache reads and writes; public input excludes both.
  if (tokens(input) && tokens(read) && tokens(write)) {
    const uncached = input - read - write;
    if (tokens(uncached)) usage.inputTokens = uncached;
  }
  if (tokens(input) && tokens(output)) {
    const total = input + output;
    if (tokens(total)) usage.totalTokens = total;
  }
  return Object.keys(usage).length ? {tokenScope: 'session', ...usage} : undefined;
}

export function copilotContextUsage(data: Record<string, unknown>): AgentUsage | undefined {
  const usage: AgentUsage = {};
  if (tokens(data.currentTokens)) usage.contextWindowUsedTokens = data.currentTokens;
  if (tokens(data.tokenLimit) && data.tokenLimit > 0) usage.contextWindowMaxTokens = data.tokenLimit;
  return Object.keys(usage).length ? { contextScope: 'current', ...usage } : undefined;
}

function tokens(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
function isRecord(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function sum(rows: Record<string, unknown>[], key: string): number | undefined {
  let total = 0;
  for (const row of rows) {
    const value = row[key];
    if (!tokens(value) || !tokens(total + value)) return undefined;
    total += value;
  }
  return total;
}
