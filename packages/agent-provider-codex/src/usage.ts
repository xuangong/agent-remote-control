import type { AgentUsage } from '@orchardworks/agent-provider-sdk';

import { isRecord } from './native.js';

function tokens(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Native totals and the latest context measurement have different scopes. */
export function codexUsage(value: unknown): AgentUsage | null {
  if (!isRecord(value)) return null;
  const usage: AgentUsage = {};
  if (isRecord(value.total)) {
    const total = value.total;
    const input = tokens(total.inputTokens);
    const cached = tokens(total.cachedInputTokens);
    const output = tokens(total.outputTokens);
    const count = tokens(total.totalTokens);
    // Codex's public TokenUsageBreakdown defaults this newer field to zero.
    const hasMeasurement = [input, cached, output, count].some(value => value !== undefined);
    const created = tokens(total.cacheWriteInputTokens === undefined && hasMeasurement ? 0 : total.cacheWriteInputTokens);
    if (input !== undefined && cached !== undefined && created !== undefined && input >= cached + created) {
      usage.inputTokens = input - cached - created;
    }
    if (cached !== undefined) usage.cachedInputTokens = cached;
    if (created !== undefined) usage.cacheCreationInputTokens = created;
    // Native outputTokens already includes reasoningOutputTokens.
    if (output !== undefined) usage.outputTokens = output;
    if (count !== undefined) usage.totalTokens = count;
    if (Object.keys(usage).length) usage.tokenScope = 'session';
  }
  const capacity = tokens(value.modelContextWindow);
  const used = isRecord(value.last) ? tokens(value.last.totalTokens) : undefined;
  if (capacity !== undefined && capacity > 0) usage.contextWindowMaxTokens = capacity;
  if (used !== undefined) usage.contextWindowUsedTokens = used;
  if (usage.contextWindowMaxTokens !== undefined || usage.contextWindowUsedTokens !== undefined) usage.contextScope = 'current';
  return Object.keys(usage).length ? usage : null;
}
