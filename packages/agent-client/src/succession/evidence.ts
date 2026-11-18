import { nativeSessionRefKey, resolveNativePrefix, type NativeSessionRef, type SessionSuccessionReplay } from '@orchardworks/agent-remote-protocol';
import { replayRoleKey, replayTouches, roleKey, sessionKey, type SessionLocator } from './locator.js';
import type { RoleEvidence, RoleProgress } from './settlement.js';

/** Why a session's locator cannot be resolved to the conversation's current one. */
export type LocatorRefusal =
  /** Discovery is not finished, or the evidence is the last confirmed one restored while the Relay is unreachable (`stale`). */
  | { kind: 'synchronizing'; stale: boolean }
  | { kind: 'error'; message: string };

export type LocatorResolution<Selection extends SessionLocator> =
  | { status: 'resolved'; target: Selection; historyRoleId?: string }
  | { status: 'refused'; refusal: LocatorRefusal };

/**
 * The locator a request for a session must use. A session that no replay mentions is itself. A session that a replay mentions
 * resolves, through the one role whose confirmed evidence names it, to the conversation's current locator; a history view keeps
 * its own locator and says which role it belongs to. Nothing resolves before discovery finished or while its evidence is stale.
 * A child session keeps its own locator. A mentioned session with no confirmed evidence, or in two roles, is refused.
 * With `nativePrefixOnly` the role's current session must be the target native prefix execution would reach.
 */
export function resolveLocator<Selection extends SessionLocator & { parentNativeSessionId?: string }>({ ready, evidenceStale, selection, viewIsHistory, nativePrefixOnly, evidence, replays }: {
  ready: boolean; evidenceStale: boolean; selection: Selection; viewIsHistory: boolean; nativePrefixOnly: boolean;
  evidence: readonly RoleEvidence[]; replays: readonly SessionSuccessionReplay[];
}): LocatorResolution<Selection> {
  if (!ready) return { status: 'refused', refusal: { kind: 'synchronizing', stale: false } };
  if (evidenceStale) return { status: 'refused', refusal: { kind: 'synchronizing', stale: true } };
  if (selection.parentNativeSessionId) return { status: 'resolved', target: selection };
  const matches = evidence.filter(item => item.replays.some(replay => replayTouches(replay, selection)));
  if (!matches.length) {
    if (replays.some(replay => replayTouches(replay, selection))) {
      return { status: 'refused', refusal: { kind: 'error', message: 'The current session locator could not be verified. The original history is preserved.' } };
    }
    return { status: 'resolved', target: selection };
  }
  if (matches.length !== 1) return { status: 'refused', refusal: { kind: 'error', message: 'The session has conflicting current role identities.' } };
  const confirmed = matches[0]!;
  if (viewIsHistory) return { status: 'resolved', target: selection, historyRoleId: confirmed.current.role.id };
  if (nativePrefixOnly) {
    const anchor = confirmed.replays.flatMap(replay => [replay.projection.receipt.from, replay.projection.receipt.to!])
      .find(ref => ref.providerId === selection.providerId && ref.nativeSessionId === selection.nativeSessionId)!;
    const resolved = resolveNativePrefix(anchor, confirmed.replays.map(replay => replay.projection.receipt));
    if (nativeSessionRefKey(resolved.target) !== nativeSessionRefKey(confirmed.current.role.current)) {
      return { status: 'refused', refusal: { kind: 'error', message: 'Native prefix execution routing is unavailable.' } };
    }
  }
  return { status: 'resolved', target: { ...selection, ...confirmed.current.locator } };
}

/**
 * The newest replay of each role, for roles `admit` lets through. The page applies one replay per role: the highest revision.
 */
export function latestReplayByRole(scope: string, replays: readonly SessionSuccessionReplay[], admit: (replay: SessionSuccessionReplay, key: string) => boolean = () => true): Map<string, SessionSuccessionReplay> {
  const latest = new Map<string, SessionSuccessionReplay>();
  for (const replay of replays) {
    const key = replayRoleKey(scope, replay);
    if (!admit(replay, key)) continue;
    if ((latest.get(key)?.projection.role.revision ?? 0) < replay.projection.role.revision) latest.set(key, replay);
  }
  return latest;
}

/**
 * Whether opening `selection` continues the conversation that is already shown (the same role), so the view keeps its place
 * instead of starting a navigation: the session is the shown target, or a replay of the shown role mentions it. A history view,
 * an explicit view id and a shown conversation without a role never continue.
 */
export function continuesRole({ scope, selection, desired, replays, explicitView, history }: {
  scope: string; selection: SessionLocator; explicitView: boolean; history: boolean;
  desired?: { roleKey?: string; hostId: string; providerId: string; nativeSessionId: string };
  replays: readonly SessionSuccessionReplay[];
}): boolean {
  if (explicitView || history || !desired?.roleKey) return false;
  return sessionKey(selection) === sessionKey(desired)
    || replays.some(replay => replayRoleKey(scope, replay) === desired.roleKey && replayTouches(replay, selection));
}

/**
 * Whether a session's succession is fully applied here, so its saved entry may be pruned: every role that mentions it (by a
 * local role view or by a replay) has applied the revision it committed, and the favorites progress the Relay reports agrees
 * (same operation, same revision, applied).
 */
export function canPruneSession({ scope, session, viewRoleKeys, replays, roles, progress }: {
  scope: string; session: SessionLocator; viewRoleKeys: readonly string[]; replays: readonly SessionSuccessionReplay[];
  roles: readonly RoleProgress[];
  progress?: ReadonlyArray<{ hostId: string; controllerId: string; roleId: string; roleRevision: number; operationId: string; status: string }>;
}): boolean {
  const keys = new Set([...viewRoleKeys, ...replays.filter(replay => replayTouches(replay, session)).map(replay => replayRoleKey(scope, replay))]);
  return [...keys].every(key => {
    const role = roles.find(candidate => candidate.key === key);
    return !!role && role.appliedRevision === role.committedRevision && !!progress?.some(checkpoint => roleKey({ scope, hostId: checkpoint.hostId, controllerId: checkpoint.controllerId, roleId: checkpoint.roleId }) === role.key
      && checkpoint.roleRevision === role.committedRevision && checkpoint.operationId === role.operationId && checkpoint.status === 'applied');
  });
}

export interface FavoritesHint { revision: number; operationId: string; status: string }
/**
 * Which roles the favorites progress reports ahead of this page: a progress whose revision is newer than the role's applied one,
 * unless an equal or newer hint for it was already seen. Returns the hints to remember; a non-empty result means the page
 * missed a succession and discovers again, once per new hint.
 */
export function newerFavoritesHints({ scope, roles, progress, seen }: {
  scope: string; roles: readonly RoleProgress[]; seen: ReadonlyMap<string, FavoritesHint>;
  progress: ReadonlyArray<{ hostId: string; controllerId: string; roleId: string; roleRevision: number; operationId: string; status: string }>;
}): Array<[string, FavoritesHint]> {
  const updates: Array<[string, FavoritesHint]> = [];
  const latest = new Map(seen);
  for (const item of progress) {
    const key = roleKey({ scope, hostId: item.hostId, controllerId: item.controllerId, roleId: item.roleId });
    const role = roles.find(candidate => candidate.key === key);
    if (!role || item.roleRevision <= role.appliedRevision) continue;
    const previous = latest.get(key);
    if (previous && (previous.revision > item.roleRevision || previous.revision === item.roleRevision
      && previous.operationId === item.operationId && previous.status === item.status)) continue;
    const hint = { revision: item.roleRevision, operationId: item.operationId, status: item.status };
    latest.set(key, hint); updates.push([key, hint]);
  }
  return updates;
}

/** Why a view's source is not its current native session: the page lost authority, the view moved, or the session is still connecting or reattached. */
export type SourceStaleness = 'inactive' | 'view' | 'connecting' | 'agent' | 'native';
/**
 * Whether the source a request was made from is still the native session of its view, and if not, why. The first reason that
 * holds wins; a view bound to exactly this source's current binding is never stale.
 */
export function sourceStaleness({ inactive, viewMatches, bound, agent, source }: {
  inactive: boolean; viewMatches: boolean; bound: boolean;
  agent?: { id: string; providerId: string; runtimeInfo: { providerId: string; sessionId: string } };
  source: SessionLocator & { agentId?: string };
}): SourceStaleness | undefined {
  if (inactive) return 'inactive';
  if (!viewMatches) return 'view';
  if (bound) return;
  if (!agent) return 'connecting';
  if (agent.id !== source.agentId) return 'agent';
  if (agent.providerId !== source.providerId || agent.runtimeInfo.providerId !== source.providerId || agent.runtimeInfo.sessionId !== source.nativeSessionId) return 'native';
}

/**
 * The Handoff a role view stands on, once it is confirmed: the Relay's current role is at the revision the view follows, the
 * local checkpoint applied and committed it, and the view's session is the role's current one.
 */
export function roleContextOf({ viewRevision, viewTarget, viewSession, evidence, checkpoint }: {
  viewRevision: number; viewTarget: NativeSessionRef; viewSession: SessionLocator;
  evidence?: RoleEvidence;
  checkpoint?: RoleProgress & { operationId: string; to: NativeSessionRef };
}): { operationId: string; target: NativeSessionRef } | undefined {
  if (!checkpoint || !evidence || evidence.current.role.revision !== viewRevision
    || checkpoint.appliedRevision !== viewRevision || checkpoint.committedRevision !== viewRevision
    || sessionKey(evidence.current.locator) !== sessionKey(viewSession)
    || nativeSessionRefKey(checkpoint.to) !== nativeSessionRefKey(viewTarget)) return;
  return { operationId: checkpoint.operationId, target: checkpoint.to };
}
