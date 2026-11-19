import type { AgentReplicaState } from '../replica/types.js';

/**
 * What a session's control lease means to a reader: one table from the replica's control state to the view reasons.
 * Pure. The renderer asks this and never reads `access`, `available` or `nativeOwner` itself.
 *
 * | control state                         | state              | readOnly | checking |
 * | none (no control channel)             | `unknown`          | no       | no       |
 * | `access: checking`                    | `checking`         | no       | yes      |
 * | `access: control`                     | `control`          | no       | no       |
 * | read-only, owner `native_cli`         | `native_cli`       | yes      | no       |
 * | read-only, another Controller owns it | `other_controller` | yes      | no       |
 * | read-only, nobody owns it             | `read_only`        | yes      | no       |
 */
export type LeaseState = 'unknown' | 'checking' | 'control' | 'native_cli' | 'other_controller' | 'read_only';

export interface LeaseView {
  readonly state: LeaseState;
  readonly readOnly: boolean;
  readonly checking: boolean;
  /** A terminal or another Controller holds the session natively, so taking control interrupts it. */
  readonly native: boolean;
}

export function leaseView(control: AgentReplicaState['sessionControl']): LeaseView {
  if (control === undefined) return { state: 'unknown', readOnly: false, checking: false, native: false };
  if (control.access === 'checking') return { state: 'checking', readOnly: false, checking: true, native: false };
  if (control.access === 'control') return { state: 'control', readOnly: false, checking: false, native: false };
  const owner = control.nativeOwner;
  const state: LeaseState = owner === undefined ? 'read_only' : owner.kind === 'native_cli' ? 'native_cli' : 'other_controller';
  return { state, readOnly: true, checking: false, native: owner !== undefined };
}

/** The words a read-only notice shows for a lease state. A control check says nothing: it is not a business fact (target T5). */
export function leaseNoticeLabel(state: Exclude<LeaseState, 'checking'>): string {
  switch (state) {
    case 'native_cli': return 'Native CLI has control';
    case 'other_controller': return 'Another Controller has control';
    default: return 'Ready to take control';
  }
}

/** The words the session's activity line shows when a native owner holds it; undefined for every other state. */
export function leaseActivityLabel(state: LeaseState): string | undefined {
  return state === 'native_cli' ? 'Native CLI has control' : state === 'other_controller' ? 'Native control transferred' : undefined;
}
