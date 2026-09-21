import { readThread } from '@orchardworks/codex-daemon-client';
export { collectCodexThreadHistoryItems } from '@orchardworks/codex-daemon-client';
import type { ProviderObservation } from '@orchardworks/agent-provider-sdk';

import { isRecord, readNumber, readString } from './native.js';
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

function secondsToMilliseconds(value: number | undefined): number | undefined {
  return value === undefined ? undefined : value * 1000;
}
