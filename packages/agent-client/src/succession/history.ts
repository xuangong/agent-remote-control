import { isSessionSuccessionCurrent, isSessionSuccessionReplay, nativeSessionRefKey, type SessionSuccessionCurrent, type SessionSuccessionReplay } from '@orchardworks/agent-remote-protocol';
import { canonicalJson, roleKey, sessionKey, type SessionLocator } from './locator.js';

export interface SuccessionHistoryEntry extends SessionLocator { title: string }
export interface SessionSuccessionHistoryNavigation {
  roleKey: string; history: boolean; session: SuccessionHistoryEntry; current: SuccessionHistoryEntry;
  predecessor?: SuccessionHistoryEntry; ancestors: SuccessionHistoryEntry[];
}

/**
 * Historical addresses of a conversation: the sessions it ran in, oldest first, read from the Relay's committed replays.
 *
 * Only a complete, authorized chain counts: every replay is valid, all name the confirmed current role and Host, their
 * revisions run 1, 2, 3 without a gap, each starts where the last ended, the first starts at the role's origin, and the last
 * equals the role the Relay confirmed. The selected session must be one of them; without `intent: 'history'` only the
 * newest may be selected (the older ones are reached as history). Anything else gives no navigation.
 */
export function sessionSuccessionHistory({ scope, replays, current, selected, intent, titles }: {
  scope: string; replays: readonly SessionSuccessionReplay[]; current?: SessionSuccessionCurrent;
  selected: SessionLocator; intent?: 'history'; titles?: ReadonlyMap<string, string>;
}): SessionSuccessionHistoryNavigation | undefined {
  if (!isSessionSuccessionCurrent(current)) return;
  const chain = replays.filter(replay => replay.projection.role.id === current.role.id && replay.to.hostId === current.locator.hostId
    && replay.projection.role.current.controllerId === current.role.current.controllerId).sort((left, right) => left.projection.role.revision - right.projection.role.revision);
  if (!chain.length || !chain.every(isSessionSuccessionReplay)) return;
  for (let index = 0; index < chain.length; index++) {
    const replay = chain[index]!, previous = chain[index - 1];
    if (canonicalJson(replay.projection.role.origin) !== canonicalJson(current.role.origin)
      || canonicalJson(replay.projection.role.workspace) !== canonicalJson(current.role.workspace)) return;
    if (previous ? previous.projection.role.revision !== replay.projection.receipt.expectedRevision
      || nativeSessionRefKey(previous.projection.role.current) !== nativeSessionRefKey(replay.projection.receipt.from)
      : replay.projection.receipt.expectedRevision !== 1 || nativeSessionRefKey(replay.projection.receipt.from) !== nativeSessionRefKey(current.role.origin)) return;
  }
  if (canonicalJson(chain.at(-1)!.projection.role) !== canonicalJson(current.role)) return;
  const targets = [chain[0]!.from, ...chain.map(replay => replay.to)];
  const keys = targets.map(sessionKey), index = keys.indexOf(sessionKey(selected));
  if (new Set(keys).size !== keys.length || index < 0 || intent !== 'history' && index !== targets.length - 1) return;
  const resolve = (target: typeof targets[number]): SuccessionHistoryEntry => ({ ...target, title: titles?.get(sessionKey(target))?.trim() || target.nativeSessionId });
  return { roleKey: roleKey({ scope, hostId: current.locator.hostId, controllerId: current.role.current.controllerId, roleId: current.role.id }),
    history: intent === 'history' && index < targets.length - 1, session: resolve(targets[index]!), current: resolve(current.locator),
    predecessor: index > 0 ? resolve(targets[index - 1]!) : undefined, ancestors: targets.slice(0, Math.max(0, index - 1)).reverse().map(resolve) };
}
