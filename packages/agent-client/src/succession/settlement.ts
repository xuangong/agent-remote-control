import { nativeSessionRefKey, type NativeSessionRef, type SessionSuccessionCurrent, type SessionSuccessionReplay } from '@orchardworks/agent-remote-protocol';
import { sessionKey, type SessionLocator } from './locator.js';

/** The evidence one role's discovery confirmed: the replays that lead to its current locator, and that locator. */
export interface RoleEvidence { replays: SessionSuccessionReplay[]; current: SessionSuccessionCurrent }
/** What a page has applied of one role: the revision its views follow, and the revision the Relay committed. */
export interface RoleProgress { key: string; appliedRevision: number; committedRevision: number; operationId?: string }

export type Settlement = { status: 'waiting' } | { status: 'settled' } | { status: 'failed'; message: string };

/** What a page can observe while it waits for a refreshed conversation to settle on its native session. */
export interface SettlementObservation {
  /** The page still holds the workspace authority it started with. */
  live: boolean;
  /** The session the page now wants to show; absent when navigation left. */
  target?: SessionLocator;
  /** The wanted session belongs to the conversation being refreshed. */
  related: boolean;
  discovering: boolean;
  /** The error the page currently shows. */
  error?: string;
  /** The composition of the conversation has been applied. */
  layoutApplied: boolean;
  /** The native binding is current, synchronized and for the wanted session. */
  nativeSettled: boolean;
  /** The caller's own condition (for example that a takeover finished) holds. */
  callerSettled: boolean;
  /** Navigation moving away is a failure instead of success: the caller expected to stay on its session. */
  mustRemain: boolean;
}

/**
 * Whether a refreshed conversation has settled. Checked at every change until it settles, fails, or `successionDeadlines.nativeConfirmation` passes.
 * Order matters: a lost authority fails first, a moved selection ends the wait, an unfinished discovery waits, an error or an
 * unapplied layout fails, and only a bound, synchronized native session for the wanted target settles.
 */
export function settlementOf(observation: SettlementObservation): Settlement {
  if (!observation.live) return { status: 'failed', message: 'Workspace access changed while refreshing this Handoff.' };
  if (!observation.target || !observation.related) {
    return observation.mustRemain ? { status: 'failed', message: 'Session navigation changed before native restoration was confirmed.' } : { status: 'settled' };
  }
  if (observation.discovering) return { status: 'waiting' };
  if (observation.error) return { status: 'failed', message: observation.error };
  if (!observation.layoutApplied) return { status: 'failed', message: 'The conversation layout still needs synchronization.' };
  return observation.nativeSettled && observation.callerSettled ? { status: 'settled' } : { status: 'waiting' };
}

/** The message when the native session is not confirmed before the deadline. */
export const nativeNotConfirmed = 'The current native session has not been confirmed. Retry the session connection.';
/** The message when a refresh keeps finding new evidence until its deadline. */
export const compositionStillChanging = 'Session composition is still changing. Retry synchronization.';

export type CommittedRefresh = { status: 'confirmed'; roleKey: string; evidence: RoleEvidence } | { status: 'failed'; message: string };

/**
 * Whether the Handoff with this operation id is committed and applied here. Exactly one role's evidence must contain the operation
 * (another role's, or none, is not proof), and the role's local checkpoint must have applied and committed the revision the Relay
 * confirms as current. `shown` is the error already on screen, which explains better than a generic message.
 */
export function committedRefreshOf({ operationId, evidence, roles, shown }: {
  operationId: string; evidence: ReadonlyMap<string, RoleEvidence>; roles: readonly RoleProgress[]; shown?: string;
}): CommittedRefresh {
  const matches = [...evidence.entries()].filter(([, item]) => item.replays.some(replay => replay.projection.receipt.operationId === operationId));
  if (matches.length !== 1) return { status: 'failed', message: shown ?? 'The committed Handoff could not be verified. Refresh its current role again.' };
  const [roleKey, confirmed] = matches[0]!;
  const checkpoint = roles.find(role => role.key === roleKey);
  if (!checkpoint || checkpoint.appliedRevision !== confirmed.current.role.revision || checkpoint.committedRevision !== confirmed.current.role.revision) {
    return { status: 'failed', message: shown ?? 'The committed Handoff still needs local synchronization.' };
  }
  return { status: 'confirmed', roleKey, evidence: confirmed };
}

/**
 * Whether a notice that a succession was committed (`session_succession_committed`) needs a discovery. Not when this page has
 * already confirmed that operation and applied its role's committed revision (`committedRefreshOf`): the discovery would find
 * nothing new, and while one runs it withholds every locator, which takes each view's operation authority away until it ends.
 * A notice of an operation the page has not applied, of one two roles hold, or of a role with no checkpoint still discovers.
 */
export function notificationNeedsDiscovery(replay: SessionSuccessionReplay, known: { evidence: ReadonlyMap<string, RoleEvidence>; roles: readonly RoleProgress[] }): boolean {
  return committedRefreshOf({ operationId: replay.projection.receipt.operationId, evidence: known.evidence, roles: known.roles }).status !== 'confirmed';
}

/** Which kind of Handoff outcome a refresh follows. */
export type HandoffOutcome = 'committed' | 'restore_source' | 'unconfirmed';
/**
 * A committed Handoff moves the conversation to its successor. A cancelled or rejected one restores the original, and only for
 * the session the person started from; any other phase, or another source, confirms nothing.
 */
export function handoffOutcome(phase: string, recordFrom: NativeSessionRef, source: SessionLocator): HandoffOutcome {
  if (phase === 'committed') return 'committed';
  if (!['cancelled', 'rejected'].includes(phase) || sessionKey({ hostId: source.hostId, providerId: recordFrom.providerId, nativeSessionId: recordFrom.nativeSessionId }) !== sessionKey(source)) return 'unconfirmed';
  return 'restore_source';
}
export const unconfirmedOutcome = 'The Handoff outcome does not confirm the original conversation.';

/**
 * After a cancelled or rejected Handoff: the original conversation is confirmed again if the role still points at it, or if the
 * refresh read the role's evidence (the role moved, and this page can follow it).
 */
export function restoredSourceOf({ roleCurrent, recordFrom, hasEvidence }: { roleCurrent: NativeSessionRef; recordFrom: NativeSessionRef; hasEvidence: boolean }): Settlement {
  return nativeSessionRefKey(roleCurrent) !== nativeSessionRefKey(recordFrom) && !hasEvidence
    ? { status: 'failed', message: 'The original conversation has moved. Refresh its current role before continuing.' } : { status: 'settled' };
}
