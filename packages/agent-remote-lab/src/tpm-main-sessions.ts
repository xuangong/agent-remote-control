import type { TpmItem } from './hooks/useTpmWork.js';
import { sessionKey, type SessionEntry } from './session-tree.js';

export type TpmMainSession = Pick<SessionEntry, 'hostId' | 'providerId' | 'nativeSessionId' | 'title'> & { workspace?: string };
export function tpmMainTarget(item: TpmItem) {
  const ref = item.work.mainSessionRef;
  return { hostId: item.hostId, providerId: ref?.providerId ?? item.work.providerId, nativeSessionId: ref?.nativeSessionId ?? item.work.mainNativeSessionId };
}

/** Group by native identity, including the current main reference after a Handoff. */
export function groupTpmWorks(items: readonly TpmItem[], sessions: ReadonlyMap<string, TpmMainSession>) {
  const groups = new Map<string, { key: string; main: TpmMainSession; hostName: string; works: TpmItem[] }>();
  for (const item of items) {
    const target = tpmMainTarget(item), key = sessionKey(target);
    let group = groups.get(key);
    if (!group) {
      group = { key, main: sessions.get(key) ?? { ...target, title: target.nativeSessionId }, hostName: item.hostName, works: [] };
      groups.set(key, group);
    }
    group.works.push(item);
  }
  return [...groups.values()];
}
