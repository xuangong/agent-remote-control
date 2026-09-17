import { isDeepStrictEqual } from 'node:util';
import { isRecord, readString, type JsonObject } from './native.js';
import type { CodexRawNotification } from './types.js';

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

export function readThread(response: unknown, threadId: string): JsonObject {
  if (!isRecord(response) || !isRecord(response.thread)) {
    throw new Error('Codex thread/read returned no thread');
  }
  const returnedThreadId = readString(response.thread.id);
  if (returnedThreadId !== threadId) {
    throw new Error(`Codex thread/read returned ${returnedThreadId ?? 'no id'} instead of ${threadId}`);
  }
  return response.thread;
}


export function historyOverlapsNotifications(history: unknown, threadId: string, notifications: readonly CodexRawNotification[]): boolean {
  const items = collectCodexThreadHistoryItems(history, threadId);
  return notifications.some(({ method, params }) => (
    method === 'item/agentMessage/delta' || method === 'item/reasoning/summaryTextDelta' || method === 'item/plan/delta'
  ) && isRecord(params) && typeof params.itemId === 'string' && items.has(params.itemId));
}

/** Discovery preserves control events and items absent from history while removing covered item data. */
export function reconcileCodexHistoryNotifications(history: unknown, threadId: string, notifications: readonly CodexRawNotification[]): CodexRawNotification[] {
  const items = collectCodexThreadHistoryItems(history, threadId);
  return notifications.filter(({ method, params }) => {
    if (!isRecord(params)) return true;
    const item = isRecord(params.item) ? params.item : undefined;
    const id = readString(params.itemId) ?? (item ? readString(item.id) : undefined);
    const historical = id ? items.get(id) : undefined;
    if (!historical) return true;
    if (method === 'item/started' || method === 'item/agentMessage/delta' || method === 'item/reasoning/summaryTextDelta' || method === 'item/plan/delta') return false;
    return method !== 'item/completed' || !isDeepStrictEqual(item, historical);
  });
}
