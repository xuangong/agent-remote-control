/**
 * Send and succession gates: when the Workbench may send for a conversation, offer a Handoff, or accept that a
 * Handoff reached the view that started it.
 *
 * Contract
 * - Pure. The shell reads its state into plain facts and acts on the answer (throws, hides a control, keeps a gate).
 * - `commandRefusal` names why a command may not go out, in this order: workspace access is restoring; the native
 *   session of a succession view is not confirmed yet; the client the action was built for is no longer the
 *   conversation's client. No refusal means the action may be sent.
 * - `conversationActionsAvailable`: every action is offered while the session is ready and its Host is reachable;
 *   otherwise only the message handlers stay, so the composer can wait for readiness.
 * - `canHandoffPrimary`: the main conversation offers Handoff when no Handoff dialog is open and every fact of a
 *   settled, owned, writable, ordinary main session holds: a directory, a signed-in user with access, a ready
 *   session on an online Host the person does not merely share, not mid-switch, no detached Side, not a fork, not
 *   read-only, not a subagent, not a history view.
 * - `handoffInputBlocker`: a Handoff of a conversation with unsent messages is blocked (the messages would be left
 *   behind). A group view counts its own pending inputs; the primary counts the main composer's.
 * - `primaryHandoffGated`: a started Handoff holds the main conversation while it is the Handoff's source, or the
 *   very operation that is being resumed.
 * - `successionAccessible`: a Handoff may continue only in the page scope it started in, with an authorized, online,
 *   not merely shared Host.
 * - `handoffCompletionMatches`: when a Handoff settles, its view must still be the source, or the view must already
 *   show the committed target and every identifier of the receipt, the pending intent, the role checkpoint and the
 *   role must agree on one operation and revision pair; once the checkpoint is applied (`requireVerified`) the
 *   verified context must name the same operation and target.
 */
import type { NativeSessionRef } from '@orchardworks/agent-remote-protocol';
import { nativeSessionRefKey } from '@orchardworks/agent-remote-protocol';
import { sessionKey } from '../kernel/session-tree.js';

export type CommandRefusal = 'access-restoring' | 'native-unconfirmed' | 'conversation-changed';

export function commandRefusal(facts: { readonly accessReady: boolean; readonly successionActive: boolean; readonly nativeConfirmed: boolean;
  readonly clientIsSubmitted: boolean }): CommandRefusal | undefined {
  if (!facts.accessReady) return 'access-restoring';
  if (facts.successionActive && !facts.nativeConfirmed) return 'native-unconfirmed';
  if (!facts.clientIsSubmitted) return 'conversation-changed';
  return undefined;
}

export function conversationActionsAvailable(facts: { readonly accessReady: boolean; readonly hostOffline: boolean; readonly status: string | undefined }): boolean {
  return facts.accessReady && !facts.hostOffline && facts.status === 'ready';
}

export function canHandoffPrimary(facts: { readonly dialogOpen: boolean; readonly hasDirectory: boolean; readonly userScoped: boolean; readonly accessReady: boolean;
  readonly hostOffline: boolean; readonly status: string | undefined; readonly primaryBound: boolean; readonly transitioning: boolean; readonly detachedSide: boolean;
  readonly fork: boolean; readonly readOnly: boolean; readonly hasPrimary: boolean; readonly isSubagent: boolean; readonly history: boolean;
  readonly hostAllowsHandoff: boolean }): boolean {
  return !facts.dialogOpen && facts.hasDirectory && facts.userScoped && facts.accessReady && !facts.hostOffline && facts.status === 'ready'
    && facts.primaryBound && !facts.transitioning && !facts.detachedSide && !facts.fork && !facts.readOnly && facts.hasPrimary && !facts.isSubagent
    && !facts.history && facts.hostAllowsHandoff;
}

export const pendingInputBlocker = 'Send or remove pending messages before handing off this conversation.';

export function handoffInputBlocker(facts: { readonly dialogOpen: boolean; readonly sourceIsGroupView: boolean; readonly groupPending: number;
  readonly sourceIsPrimary: boolean; readonly primaryPending: number }): string | undefined {
  if (!facts.dialogOpen) return undefined;
  const blocked = facts.sourceIsGroupView ? facts.groupPending > 0 : facts.sourceIsPrimary && facts.primaryPending > 0;
  return blocked ? pendingInputBlocker : undefined;
}

export function primaryHandoffGated(facts: { readonly gated: boolean; readonly dialogInScope: boolean; readonly hasPrimary: boolean;
  readonly primaryIsSource: boolean; readonly desiredIsResumed: boolean }): boolean {
  return facts.gated && facts.dialogInScope && facts.hasPrimary && (facts.primaryIsSource || facts.desiredIsResumed);
}

export function successionAccessible(facts: { readonly accessReady: boolean; readonly dialogInScope: boolean; readonly userScoped: boolean;
  readonly hostAllowsHandoff: boolean }): boolean {
  return facts.accessReady && facts.dialogInScope && facts.userScoped && facts.hostAllowsHandoff;
}

interface HandoffReceipt {
  readonly phase: string; readonly operationId: string; readonly roleId: string; readonly expectedRevision?: unknown; readonly committedRevision?: unknown;
  readonly from: NativeSessionRef; readonly to?: NativeSessionRef;
}

export function handoffCompletionMatches(facts: {
  readonly source: { readonly hostId?: string; readonly providerId: string; readonly nativeSessionId: string };
  readonly mappedKey: string | undefined;
  readonly receipt: HandoffReceipt;
  readonly role: { readonly id: string; readonly revision?: unknown; readonly current: NativeSessionRef };
  readonly checkpoint: { readonly roleId: string; readonly appliedRevision?: unknown;
    readonly desired: { readonly operationId: string; readonly expectedRevision?: unknown; readonly committedRevision?: unknown;
      readonly from: NativeSessionRef; readonly to: NativeSessionRef } } | undefined;
  readonly pending: { readonly operationId: string; readonly expectedRevision?: unknown } | undefined;
  readonly verified: { readonly operationId: string; readonly target: NativeSessionRef } | undefined;
  readonly requireVerified: boolean;
}): boolean {
  const { receipt, role, checkpoint, pending, verified, source } = facts;
  if (!facts.mappedKey || facts.mappedKey === sessionKey(source)) return true;
  if (receipt.phase !== 'committed' || !receipt.to || !checkpoint || !pending
    || pending.operationId !== receipt.operationId || pending.expectedRevision !== receipt.expectedRevision
    || checkpoint.desired.operationId !== receipt.operationId || checkpoint.roleId !== receipt.roleId || role.id !== receipt.roleId
    || checkpoint.desired.expectedRevision !== receipt.expectedRevision || checkpoint.desired.committedRevision !== receipt.committedRevision
    || role.revision !== receipt.committedRevision
    || nativeSessionRefKey(checkpoint.desired.from) !== nativeSessionRefKey(receipt.from)
    || sessionKey({ hostId: source.hostId, ...receipt.from }) !== sessionKey(source)
    || nativeSessionRefKey(checkpoint.desired.to) !== nativeSessionRefKey(receipt.to)
    || nativeSessionRefKey(role.current) !== nativeSessionRefKey(receipt.to)
    || sessionKey({ hostId: source.hostId, ...receipt.to }) !== facts.mappedKey
    || facts.requireVerified && (!verified || verified.operationId !== receipt.operationId || checkpoint.appliedRevision !== receipt.committedRevision
      || nativeSessionRefKey(verified.target) !== nativeSessionRefKey(receipt.to))) return false;
  return true;
}
