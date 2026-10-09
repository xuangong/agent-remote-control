import type { AgentUsage } from './timeline.js';

const snapshotGroups = [
  ['tokenScope', 'inputTokens', 'cachedInputTokens', 'cacheCreationInputTokens', 'outputTokens', 'totalTokens'],
  ['contextScope', 'contextWindowUsedTokens', 'contextWindowMaxTokens'],
  ['totalCostUsd'],
] as const satisfies readonly (readonly (keyof AgentUsage)[])[];

/** Replace each reported measurement group, retaining independent groups. Usage is never additive. */
export function updateUsageSnapshot(previous: AgentUsage | undefined, update: AgentUsage): AgentUsage | undefined {
  let next = previous === undefined ? undefined : { ...previous };
  for (const group of snapshotGroups) {
    // Undefined native properties disappear on the wire and must have the same meaning here.
    const reported = group.filter(key => update[key] !== undefined);
    if (reported.length === 0) continue;
    next ??= {};
    for (const key of group) delete next[key];
    Object.assign(next, Object.fromEntries(reported.map(key => [key, update[key]])));
  }
  return next;
}
