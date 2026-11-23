import type { HandoffAdmissionState } from '@orchardworks/agent-session-runtime';

/**
 * Native families and the quiescence rule that gates a succession.
 *
 * Contract.
 * - A native family is a session's binding, the children bound under it (`parentNativeSessionId`) and their children, all of one provider.
 *   `nativeFamily` returns them in discovery order, the session's own binding first when it is bound.
 * - A session is quiescent for a succession when its runtime is connected, synchronized, open, idle, with no active turn, no pending
 *   interaction, no command or setting work, and no unsettled Team recipient. Each child needs the same, except that a closed child does not
 *   block it: an unreadable child state does.
 * - `handoffRefusal` returns the first refusal and nothing when the session may proceed:
 *   `succession_not_quiescent` for work, `succession_boundary_changed` when the timeline cursor moved past a captured boundary.
 *   A session with no binding passes only when the caller allows it missing.
 *
 * Pure: no ports, no clock, no state.
 */
export interface FamilyBinding { agentId: string; providerId: string; nativeSessionId: string; parentNativeSessionId?: string }

export function nativeFamily<T extends FamilyBinding>(bindings: Iterable<T>, providerId: string, nativeSessionId: string): T[] {
  const all = [...bindings];
  const ids = new Set([nativeSessionId]);
  const family: T[] = [];
  for (;;) {
    const found = all.filter(binding => binding.providerId === providerId && !family.includes(binding)
      && (binding.nativeSessionId === nativeSessionId || binding.parentNativeSessionId && ids.has(binding.parentNativeSessionId)));
    if (!found.length) return family;
    for (const binding of found) { family.push(binding); ids.add(binding.nativeSessionId); }
  }
}

export interface HandoffRefusal { code: 'succession_not_quiescent' | 'succession_boundary_changed'; message: string }

export interface HandoffInput {
  /** The runtime state of the session itself; absent when it has no runtime. */
  own: HandoffAdmissionState | undefined;
  /** Whether the session is bound at all. */
  bound: boolean;
  ownCursor: { epoch: string; seq: number } | undefined;
  /** The boundary a prepared succession captured; absent when none was. */
  captured?: { epoch: string; seq: number };
  /** The state of each child's runtime, absent for a child with no runtime. */
  children: ReadonlyArray<HandoffAdmissionState | undefined>;
  unsettledRecipient: boolean;
  allowMissing?: boolean;
}

const busy = (state: HandoffAdmissionState): boolean => state.status !== 'idle' || state.activeTurn || !!state.pendingInteractions || !!state.commandWork || state.settingWork;

export function handoffRefusal(input: HandoffInput): HandoffRefusal | undefined {
  if (!input.bound && input.allowMissing) return undefined;
  const { own } = input;
  if (!own || !own.connected || !own.synchronized || own.closed || busy(own) || input.unsettledRecipient) {
    return { code: 'succession_not_quiescent', message: 'Session has active, unknown or unsynchronized Host work.' };
  }
  const cursor = input.ownCursor;
  if (input.captured && (!cursor || cursor.epoch !== input.captured.epoch || cursor.seq !== input.captured.seq)) {
    return { code: 'succession_boundary_changed', message: 'Source history changed beyond the captured handoff boundary.' };
  }
  for (const child of input.children) {
    if (!child || !child.connected || !child.synchronized || busy(child)) return { code: 'succession_not_quiescent', message: 'Session has unresolved child work.' };
  }
  return undefined;
}
