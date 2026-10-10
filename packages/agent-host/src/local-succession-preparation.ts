import { realpath } from 'node:fs/promises';
import { nativeSessionRefKey, type NativeSessionRef, type PreparedSuccession, type PrimaryRole } from '@orchardworks/agent-remote-protocol';

export interface SuccessionReadiness {
  cwd: string;
  idle: boolean;
  managed: boolean;
  pendingInputs: number;
  pendingInteractions: number;
  activeChildren: number;
  boundary: { epoch: string; seq: number };
}
export interface LocalSuccessionAccess {
  /** Unknown ownership, pending input or child state must not be reported as quiescent. */
  inspect(session: NativeSessionRef): Promise<SuccessionReadiness>;
  /** Creates only a candidate. Neither this call nor transfer may start implementation work. */
  create(source: NativeSessionRef, operationId: string): Promise<NativeSessionRef>;
  /** Must settle context preparation before returning; thrown unknown effects are never replayed. */
  transfer(source: NativeSessionRef, target: NativeSessionRef, operationId: string): Promise<PreparedSuccession['capture']>;
}
export class SuccessionPreparationRejected extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/** The sole V1 policy: reuse one provider and one canonical directory on this Controller. */
export class LocalSuccessionPreparation {
  constructor(private readonly controllerId: string, private readonly providerId: string, private readonly access: LocalSuccessionAccess) {}
  async check(role: PrimaryRole, session = role.current): Promise<SuccessionReadiness> {
    if (session.controllerId !== this.controllerId || session.providerId !== this.providerId
      || role.current.controllerId !== this.controllerId || role.current.providerId !== this.providerId
      || role.workspace.controllerId !== this.controllerId) throw new SuccessionPreparationRejected('succession_local_only', 'Handoff requires the same Host and provider.');
    const state = await this.access.inspect(session);
    if (state.idle !== true || state.managed !== true || state.pendingInputs !== 0 || state.pendingInteractions !== 0 || state.activeChildren !== 0) {
      throw new SuccessionPreparationRejected('succession_not_quiescent', 'Finish pending input, approvals and child work before handoff. Native ownership must be confirmed.');
    }
    if (typeof state.boundary?.epoch !== 'string' || !state.boundary.epoch || !Number.isSafeInteger(state.boundary.seq) || state.boundary.seq < 0) {
      throw new SuccessionPreparationRejected('succession_boundary_unavailable', 'The session history boundary is unavailable.');
    }
    let actual: string;
    try { actual = await realpath(state.cwd); }
    catch { throw new SuccessionPreparationRejected('succession_workspace_unavailable', 'The working directory is unavailable.'); }
    if (actual !== role.workspace.canonicalCwd) throw new SuccessionPreparationRejected('succession_workspace_changed', 'Handoff requires the same canonical working directory.');
    return state;
  }
  async create(role: PrimaryRole, operationId: string): Promise<NativeSessionRef> {
    const target = await this.access.create(role.current, `${operationId}:create`);
    if (nativeSessionRefKey(target) === nativeSessionRefKey(role.current)) throw new SuccessionPreparationRejected('succession_identity_conflict', 'The successor must be an independent session.');
    return target;
  }
  transfer(role: PrimaryRole, target: NativeSessionRef, operationId: string): Promise<PreparedSuccession['capture']> {
    return this.access.transfer(role.current, target, `${operationId}:context`);
  }
  async verify(role: PrimaryRole, prepared: PreparedSuccession): Promise<void> {
    const source = await this.check(role);
    await this.check(role, prepared.to);
    if (source.boundary.epoch !== prepared.capture.epoch || source.boundary.seq !== prepared.capture.seq) {
      throw new SuccessionPreparationRejected('succession_boundary_changed', 'Source history changed beyond the captured handoff boundary.');
    }
  }
}
