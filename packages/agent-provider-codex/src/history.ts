import { readThread } from '@orchardworks/codex-daemon-client';
export { collectCodexThreadHistoryItems } from '@orchardworks/codex-daemon-client';
import type { AgentRuntimeInfo, ProviderObservation } from '@orchardworks/agent-provider-sdk';

import { isRecord, readErrorMessage, readNumber, readString } from './native.js';
import { CodexEventProjector, type CodexEventProjectorOptions } from './projector.js';

export function projectCodexThreadHistory(
  response: unknown,
  threadId: string,
  options: Pick<CodexEventProjectorOptions, 'images' | 'cwd'> = {},
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
    const items = Array.isArray(value.items) ? value.items : [];
    for (const item of items) {
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
