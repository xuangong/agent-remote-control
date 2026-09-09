import type { ProviderObservation } from '@borgee/agent-provider-sdk';

import { isRecord, readNumber, readString, type JsonObject } from './native.js';
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
  }
  return observations;
}

export function collectCodexThreadHistoryItems(
  response: unknown,
  threadId: string,
): Map<string, JsonObject> {
  const thread = readThread(response, threadId);
  const itemsById = new Map<string, JsonObject>();
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  for (const turn of turns) {
    if (!isRecord(turn) || !Array.isArray(turn.items)) continue;
    for (const item of turn.items) {
      if (!isRecord(item)) continue;
      const itemId = readString(item.id);
      if (itemId) itemsById.set(itemId, item);
    }
  }
  return itemsById;
}

function readThread(response: unknown, threadId: string): JsonObject {
  if (!isRecord(response) || !isRecord(response.thread)) {
    throw new Error('Codex thread/read returned no thread');
  }
  const returnedThreadId = readString(response.thread.id);
  if (returnedThreadId !== threadId) {
    throw new Error(`Codex thread/read returned ${returnedThreadId ?? 'no id'} instead of ${threadId}`);
  }
  return response.thread;
}

function secondsToMilliseconds(value: number | undefined): number | undefined {
  return value === undefined ? undefined : value * 1000;
}
