import type { AgentReplicaState } from '../replica/types.js';
import { translator, type Translate } from '../presentation/messages.js';

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
 * | read-only, the CLI refuses the Controller (`nativeRefusal`) | `cli_refused` | yes | no |
 *
 * A refusal is the CLI's own rule (another process writes the session): nothing takes such a session over, a retry asks the CLI again.
 */
export type LeaseState = 'unknown' | 'checking' | 'control' | 'native_cli' | 'other_controller' | 'read_only' | 'cli_refused';
export type NativeRefusalReason = NonNullable<NonNullable<AgentReplicaState['sessionControl']>['nativeRefusal']>['reason'];

export interface LeaseView {
  readonly state: LeaseState;
  readonly readOnly: boolean;
  readonly checking: boolean;
  /** A terminal or another Controller holds the session natively, so taking control interrupts it. */
  readonly native: boolean;
  /** Why the CLI refuses the Controller, for `cli_refused`. */
  readonly refusal?: NativeRefusalReason;
}

export function leaseView(control: AgentReplicaState['sessionControl']): LeaseView {
  if (control === undefined) return { state: 'unknown', readOnly: false, checking: false, native: false };
  if (control.access === 'checking') return { state: 'checking', readOnly: false, checking: true, native: false };
  if (control.access === 'control') return { state: 'control', readOnly: false, checking: false, native: false };
  if (control.nativeRefusal) return { state: 'cli_refused', readOnly: true, checking: false, native: false, refusal: control.nativeRefusal.reason };
  const owner = control.nativeOwner;
  const state: LeaseState = owner === undefined ? 'read_only' : owner.kind === 'native_cli' ? 'native_cli' : 'other_controller';
  return { state, readOnly: true, checking: false, native: owner !== undefined };
}

/** The words a read-only notice shows for a lease state. A control check says nothing: it is not a business fact (target T5). */
export function leaseNoticeLabel(state: Exclude<LeaseState, 'checking'>, t: Translate = translator('en'), refusal?: NativeRefusalReason): string {
  switch (state) {
    case 'native_cli': return t('client.lease.nativeCli');
    case 'other_controller': return t('client.lease.otherController');
    case 'cli_refused': return t(refusal === 'turn_running' ? 'client.lease.turnRunning' : 'client.lease.writerElsewhere');
    default: return t('client.lease.readOnly');
  }
}
