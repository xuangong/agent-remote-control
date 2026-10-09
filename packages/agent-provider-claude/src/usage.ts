import type { AgentUsage } from '@orchardworks/agent-provider-sdk';
import { record } from './projector.js';

/** Native model accounting and cost are latest cumulative snapshots for one query. */
export class ClaudeUsage {
  private previousCost: number | undefined;
  private previousTokens: AgentUsage | undefined;
  private context: { model: string; usage: AgentUsage } | undefined;
  private readonly seenContext = new Set<string>();

  startTurn(): void { this.context = undefined; }

  observe(message: unknown, model: string | undefined): AgentUsage | undefined {
    if (!record(message) || message.type !== 'assistant' || message.parent_tool_use_id || !record(message.context_usage)) return;
    const value = message.context_usage;
    if (!model || value.model !== model || !tokens(value.total_tokens) || !tokens(value.raw_max_tokens) || value.raw_max_tokens === 0) return;
    if (typeof message.uuid === 'string') {
      if (this.seenContext.has(message.uuid)) return;
      this.seenContext.add(message.uuid);
    }
    const usage: AgentUsage = { contextScope: 'current', contextWindowUsedTokens: value.total_tokens, contextWindowMaxTokens: value.raw_max_tokens };
    this.context = { model, usage };
    return usage;
  }

  result(message: unknown, model: string | undefined): AgentUsage {
    if (!record(message)) return {};
    const usage: AgentUsage = {};
    const failed = message.is_error === true || typeof message.subtype === 'string' && message.subtype.startsWith('error_');
    const accounting = modelAccounting(message.modelUsage, message.subtype === 'success' && !failed);
    // Fatal native results may contain a zeroed placeholder instead of an accounting snapshot.
    if (accounting && !(failed && (zeroed(accounting) || regressed(accounting, this.previousTokens)))) {
      Object.assign(usage, accounting);
      this.previousTokens = accounting;
    }
    const cost = message.total_cost_usd;
    if (typeof cost === 'number' && Number.isFinite(cost) && cost >= 0
      && !(failed && (cost === 0 || this.previousCost !== undefined && cost < this.previousCost))) {
      usage.totalCostUsd = cost;
      this.previousCost = cost;
    }
    if (this.context && this.context.model === model) Object.assign(usage, this.context.usage);
    return usage;
  }
}

const buckets = {
  inputTokens: 'inputTokens', outputTokens: 'outputTokens',
  cachedInputTokens: 'cacheReadInputTokens', cacheCreationInputTokens: 'cacheCreationInputTokens',
} as const;

function modelAccounting(value: unknown, successful: boolean): AgentUsage | undefined {
  if (!record(value)) return;
  const models = Object.values(value);
  if (!models.length && !successful) return;
  const usage: AgentUsage = {};
  for (const key of Object.keys(buckets) as (keyof typeof buckets)[]) {
    const counts = models.map((model) => record(model) ? model[buckets[key]] : undefined);
    if (!counts.every(tokens)) continue;
    const count = counts.reduce((sum, amount) => sum + amount, 0);
    if (tokens(count)) usage[key] = count;
  }
  if (!Object.keys(usage).length) return;
  usage.tokenScope = 'runtime';
  const counts = Object.keys(buckets).map((key) => usage[key as keyof typeof buckets]);
  if (counts.every(tokens)) {
    const total = counts.reduce((sum, count) => sum + count, 0);
    if (tokens(total)) usage.totalTokens = total;
  }
  return usage;
}

function zeroed(usage: AgentUsage): boolean {
  return !Object.keys(buckets).some((key) => (usage[key as keyof typeof buckets] ?? 0) > 0);
}

function regressed(usage: AgentUsage, previous: AgentUsage | undefined): boolean {
  return previous !== undefined && Object.keys(buckets).some((key) => {
    const current = usage[key as keyof typeof buckets], before = previous[key as keyof typeof buckets];
    return current !== undefined && before !== undefined && current < before;
  });
}

function tokens(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
