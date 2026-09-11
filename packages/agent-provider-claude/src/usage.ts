import type { AgentUsage } from '@borgee/agent-provider-sdk';
import { record } from './projector.js';

/** Query cost is cumulative; result token counts cover this turn's main loop only. */
export class ClaudeUsage {
  private previousCost: number | undefined = 0;
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
    const usage = { contextWindowUsedTokens: value.total_tokens, contextWindowMaxTokens: value.raw_max_tokens };
    this.context = { model, usage };
    return usage;
  }

  result(message: unknown, model: string | undefined): AgentUsage {
    if (!record(message)) return {};
    const usage: AgentUsage = {};
    if (record(message.usage)) {
      if (tokens(message.usage.input_tokens)) usage.inputTokens = message.usage.input_tokens;
      if (tokens(message.usage.output_tokens)) usage.outputTokens = message.usage.output_tokens;
      if (tokens(message.usage.cache_read_input_tokens)) usage.cachedInputTokens = message.usage.cache_read_input_tokens;
    }
    const cost = message.total_cost_usd;
    if (typeof cost !== 'number' || !Number.isFinite(cost) || cost < 0) this.previousCost = undefined;
    else if (!(message.is_error && this.previousCost !== undefined && cost < this.previousCost)) {
      if (this.previousCost !== undefined) usage.totalCostUsd = cost >= this.previousCost ? cost - this.previousCost : cost;
      this.previousCost = cost;
    }
    const nativeModel = model && record(message.modelUsage) ? message.modelUsage[model] : undefined;
    if (record(nativeModel) && tokens(nativeModel.contextWindow) && nativeModel.contextWindow > 0) usage.contextWindowMaxTokens = nativeModel.contextWindow;
    if (this.context && this.context.model === model) Object.assign(usage, this.context.usage);
    return usage;
  }
}

function tokens(value: unknown): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0; }
