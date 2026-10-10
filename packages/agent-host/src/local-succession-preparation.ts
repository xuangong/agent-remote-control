import type { SessionSuccessionContextStore, SuccessionContextRecord, SuccessionContextPreparation } from './session-succession-context.js';
import { realpath } from 'node:fs/promises';
import { type NativeSessionRef, type PreparedSuccession, type PrimaryRole } from '@orchardworks/agent-remote-protocol';

export interface SuccessionReadiness {
  cwd: string;
  idle: boolean;
  managed: boolean;
  pendingInputs: number;
  inFlightInputs: number;
  pendingInteractions: number;
  activeChildren: number;
  boundary: { epoch: string; seq: number };
}
export interface LocalSuccessionAccess {
  /** Unknown ownership, pending input or child state must not be reported as quiescent. */
  inspect(session: NativeSessionRef): Promise<SuccessionReadiness>;
  /** Certifies that preparation and idle creation never send input or start work. */
  supports(source: NativeSessionRef, targetProviderId: string): Promise<boolean>;
  /** Explicit producer certificate: every candidate ref field and capture string fits 512 UTF-16 units; capture seq is a nonnegative safe integer. */
  supportsBoundedProjection?(source: NativeSessionRef, targetProviderId: string): Promise<boolean>;
  verifyAttachment(prepared: PreparedSuccession): Promise<void>;
  create(source: NativeSessionRef, operationId: string, targetProviderId: string): Promise<NativeSessionRef>;
  capture(source: NativeSessionRef, operationId: string): Promise<SuccessionContextPreparation>;
  saveContext(context: SuccessionContextPreparation): Promise<void>;
  bind(operationId: string, target: NativeSessionRef): Promise<void>;
}
export class SuccessionPreparationRejected extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/** Reuse this Controller and canonical workspace; adapter capabilities gate each provider pair. */
export class LocalSuccessionPreparation {
  constructor(private readonly controllerId: string, private readonly providerId: string, private readonly access: LocalSuccessionAccess, private readonly contexts?: SessionSuccessionContextStore) {}
  async check(role: PrimaryRole, session = role.current): Promise<SuccessionReadiness> {
    if (session.controllerId !== this.controllerId
      || role.current.controllerId !== this.controllerId
      || role.workspace.controllerId !== this.controllerId) throw new SuccessionPreparationRejected('succession_local_only', 'Handoff requires the same Host.');
    const context = this.pendingContext(session);
    if (context && ['dispatching', 'accepted', 'unknown'].includes(context.state)) throw new SuccessionPreparationRejected('succession_context_unknown', 'Reconcile the first input before another succession.');
    const state = await this.access.inspect(session);
    if (state.idle !== true || state.managed !== true || state.pendingInputs !== 0 || state.inFlightInputs !== 0 || state.pendingInteractions !== 0 || state.activeChildren !== 0) {
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
  async supports(role: PrimaryRole, targetProviderId = role.current.providerId): Promise<void> {
    if (!await this.access.supports(role.current, targetProviderId)) throw new SuccessionPreparationRejected('succession_unsupported_provider', 'The selected provider pair does not support safe succession.');
  }
  async supportsBoundedProjection(role: PrimaryRole, targetProviderId = role.current.providerId): Promise<void> {
    if (await this.access.supportsBoundedProjection?.(role.current, targetProviderId) !== true) throw new SuccessionPreparationRejected('succession_bounded_producer_unavailable', 'The selected adapters have not certified bounded candidate and capture producers.');
  }
  create(role: PrimaryRole, operationId: string, targetProviderId = role.current.providerId): Promise<NativeSessionRef> {
    return this.access.create(role.current, `${operationId}:create`, targetProviderId);
  }
  capture(role: PrimaryRole, operationId: string): Promise<SuccessionContextPreparation> { return this.access.capture(role.current, `${operationId}:context`); }
  saveContext(context: SuccessionContextPreparation): Promise<void> { return this.access.saveContext(context); }
  bind(operationId: string, target: NativeSessionRef): Promise<void> { return this.access.bind(operationId, target); }
  /** Consumers inherit these raw rows, never an already composed context prefix. */
  pendingContext(source: NativeSessionRef): SuccessionContextRecord | undefined {
    const context = this.contexts?.forTarget(source);
    return context?.state === 'materialized' ? undefined : context;
  }
  async verify(role: PrimaryRole, prepared: PreparedSuccession): Promise<void> {
    await this.access.verifyAttachment(prepared);
    const source = await this.check(role);
    await this.check(role, prepared.to);
    if (source.boundary.epoch !== prepared.capture.epoch || source.boundary.seq !== prepared.capture.seq) {
      throw new SuccessionPreparationRejected('succession_boundary_changed', 'Source history changed beyond the captured handoff boundary.');
    }
  }
}
