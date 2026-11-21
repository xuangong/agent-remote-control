import { readThread } from '@orchardworks/codex-daemon-client';
export { collectCodexThreadHistoryItems } from '@orchardworks/codex-daemon-client';
import type { AgentRuntimeInfo, ProviderObservation } from '@orchardworks/agent-provider-sdk';

import { isRecord, readErrorMessage, readNumber, readString } from './native.js';
import { CodexEventProjector, type CodexEventProjectorOptions } from './projector.js';

export function projectCodexThreadHistory(
  response: unknown,
  threadId: string,
  options: Pick<CodexEventProjectorOptions, 'images' | 'cwd' | 'diagnostic'> = {},
): ProviderObservation[] {
  const thread = readThread(response, threadId);
  const projector = new CodexEventProjector(threadId, { ...options, cwd: options.cwd ?? readString(thread.cwd), delivery: 'history' });
  const observations: ProviderObservation[] = [];
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  for (const value of turns) {
    if (!isRecord(value)) continue;
    const turnId = readString(value.id);
    const startedAt = secondsToMilliseconds(readNumber(value.startedAt));
    const completedAt = secondsToMilliseconds(readNumber(value.completedAt)) ?? startedAt;
    for (const item of inStartOrder(Array.isArray(value.items) ? value.items : [])) {
      const userItem = isRecord(item) && item.type === 'userMessage';
      const observation = projector.projectHistoryItem(
        item,
        turnId,
        userItem ? startedAt : completedAt,
      );
      if (observation) observations.push(observation);
    }
    if (value.status === 'failed' && turnId) {
      observations.push(projector.projectTurnFailure(readErrorMessage(value.error)?.trim() || 'Codex turn failed without an error detail.', turnId, completedAt));
    }
  }
  return observations;
}

/**
 * Native history lists a turn's items in the order they finished; a live stream shows them in the order they started. They differ when
 * lifetimes overlap, as a plan item and the message it was cut from do. The journal keys items by first appearance, so history is
 * read in the order a stream shows. Items without a start time keep the native order.
 */
function inStartOrder(items: unknown[]): unknown[] {
  const started = items.map(item => isRecord(item) ? readNumber(item.startedAtMs) : undefined);
  if (started.some(at => at === undefined)) return items;
  return items.map((item, index) => ({ item, index, at: started[index]! })).sort((a, b) => a.at - b.at || a.index - b.index).map(({ item }) => item);
}

/** Only the latest turn can explain the current failure; older failures remain timeline history. */
export function latestCodexTurnFailure(response: unknown): AgentRuntimeInfo['failure'] {
  if (!isRecord(response) || !isRecord(response.thread) || !Array.isArray(response.thread.turns)) return undefined;
  const turn: unknown = response.thread.turns.at(-1);
  if (!isRecord(turn) || turn.status !== 'failed') return undefined;
  const message = readErrorMessage(turn.error)?.trim();
  const turnId = readString(turn.id);
  return message ? { message, ...(turnId ? { turnId } : {}) } : undefined;
}

function secondsToMilliseconds(value: number | undefined): number | undefined {
  return value === undefined ? undefined : value * 1000;
}
