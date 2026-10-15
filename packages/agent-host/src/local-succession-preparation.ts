import { isSuccessionDeliveryUnresolved, type SessionSuccessionContextStore, type SuccessionContextRecord, type SuccessionContextPreparation } from './session-succession-context.js';
import { realpath } from 'node:fs/promises';
import { type NativeSessionRef, type PreparedSuccession, type PrimaryRole, type NativePrefixSelection, type SuccessionRequest, nativeSessionRefKey } from '@orchardworks/agent-remote-protocol';
import { AGENT_NATIVE_EVIDENCE_LIMITS, parseAgentEmptyCreationResult, serializeAgentEmptyCreationResult, type AgentEmptyCreationResult, type AgentPersistenceHandle } from '@orchardworks/agent-provider-sdk';

export interface SuccessionVerification {
  assertCurrent(): void;
  release(): void;
}
export interface RetainedSuccessionVerification extends SuccessionVerification {
  inspect(session: NativeSessionRef): Promise<SuccessionReadiness>;
}
export type NativeSuccessionCreate = () => Promise<AgentEmptyCreationResult>;
/** Host-private envelope check. Opaque native contents remain adapter-owned. */
export function successionCreationHandle(providerId: string, nativeSessionId: string, result: AgentEmptyCreationResult): AgentPersistenceHandle {
  const saved = parseAgentEmptyCreationResult(serializeAgentEmptyCreationResult(result));
  if (saved.status !== 'created' || saved.handle.providerId !== providerId || saved.handle.sessionId !== nativeSessionId) {
    throw new SuccessionPreparationRejected('succession_creation_not_resumable', 'Native creation evidence does not authorize this attachment.');
  }
  return saved.handle;
}

/** Updated recovery configuration changes neither provider nor candidate identity. */
export function successionResumeHandle(providerId: string, nativeSessionId: string, creation: AgentEmptyCreationResult | undefined, updated?: AgentPersistenceHandle): AgentPersistenceHandle | undefined {
  if (!creation) {
    if (updated) throw new Error('Updated recovery configuration requires original creation evidence.');
    return undefined;
  }
  const original = successionCreationHandle(providerId, nativeSessionId, creation);
  return updated ? successionCreationHandle(providerId, nativeSessionId, { status: 'created', handle: updated }) : original;
}

export interface NativePromptEditTarget { nativeSessionId: string; turnId: string; messageId: string }
export interface NativePrefixCandidate { target: NativeSessionRef; handle: AgentPersistenceHandle }
/** Validate the complete bounded envelope without interpreting adapter-owned opaque contents. */
export function nativePrefixResumeHandle(providerId: string, nativeSessionId: string, value: AgentPersistenceHandle): AgentPersistenceHandle {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))
    || Object.getOwnPropertySymbols(value).length || Object.getOwnPropertyNames(value).length !== 3 || Object.keys(value).length !== 3
    || Object.keys(value).some(key => !['providerId', 'sessionId', 'opaque'].includes(key))
    || Object.values(Object.getOwnPropertyDescriptors(value)).some(property => !('value' in property))
    || value.providerId !== providerId || value.sessionId !== nativeSessionId || typeof value.opaque !== 'string'
    || Buffer.byteLength(JSON.stringify(value)) > AGENT_NATIVE_EVIDENCE_LIMITS.handleBytes) throw new Error('Invalid or oversized native prefix handle.');
  return structuredClone(value);
}

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
  inspect(session: NativeSessionRef, preparation?: NativePrefixSelection): Promise<SuccessionReadiness>;
  /** Certifies that preparation and idle creation never send input or start work. */
  supports(source: NativeSessionRef, targetProviderId: string): Promise<boolean>;
  /** Explicit producer certificate: every candidate ref field and capture string fits 512 UTF-16 units; capture seq is a nonnegative safe integer. */
  supportsBoundedProjection?(source: NativeSessionRef, targetProviderId: string): Promise<boolean>;
  supportsNativePrefix?(source: NativeSessionRef, selection: NativePrefixSelection): Promise<boolean>;
  createNativePrefix?(request: SuccessionRequest): Promise<NativePrefixCandidate>;
  verifyNativePrefix?(prepared: PreparedSuccession): Promise<void>;
  verifyAttachment(prepared: PreparedSuccession): Promise<void>;
  create(source: NativeSessionRef, operationId: string, targetProviderId: string): Promise<NativeSessionRef>;
  selectNativeCreation?(source: NativeSessionRef, operationId: string, targetProviderId: string): Promise<NativeSuccessionCreate | undefined>;
  retainVerification?(prepared: PreparedSuccession): Promise<RetainedSuccessionVerification>;
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
  async check(role: PrimaryRole, session = role.current, inspect: ((target: NativeSessionRef) => Promise<SuccessionReadiness>) | undefined = undefined, preparation?: NativePrefixSelection): Promise<SuccessionReadiness> {
    if (session.controllerId !== this.controllerId
      || role.current.controllerId !== this.controllerId
      || role.workspace.controllerId !== this.controllerId) throw new SuccessionPreparationRejected('succession_local_only', 'Handoff requires the same Host.');
    const state = await (inspect ? inspect(session) : this.access.inspect(session, preparation));
    const context = this.pendingContext(session);
    if (context?.deliveries.some(isSuccessionDeliveryUnresolved)) throw new SuccessionPreparationRejected('succession_context_unknown', 'Reconcile the first input before another succession.');
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
  async supports(role: PrimaryRole, targetProviderId = role.current.providerId, preparation?: NativePrefixSelection): Promise<void> {
    if (preparation) {
      if (targetProviderId !== role.current.providerId || !this.access.createNativePrefix || !this.access.verifyNativePrefix || !this.access.retainVerification
        || !await this.access.supportsNativePrefix?.(role.current, preparation)) throw new SuccessionPreparationRejected('succession_unsupported_provider', 'Native prefix preparation is unavailable for this provider.');
      return;
    }
    if (!await this.access.supports(role.current, targetProviderId)) throw new SuccessionPreparationRejected('succession_unsupported_provider', 'The selected provider pair does not support safe succession.');
  }
  async supportsBoundedProjection(role: PrimaryRole, targetProviderId = role.current.providerId, preparation?: NativePrefixSelection): Promise<void> {
    if (preparation) return this.supports(role, targetProviderId, preparation);
    if (await this.access.supportsBoundedProjection?.(role.current, targetProviderId) !== true) throw new SuccessionPreparationRejected('succession_bounded_producer_unavailable', 'The selected adapters have not certified bounded candidate and capture producers.');
  }
  createNativePrefix(request: SuccessionRequest): Promise<NativePrefixCandidate> {
    if (!request.preparation || !this.access.createNativePrefix) throw new Error('Native prefix creation is unavailable.');
    return this.access.createNativePrefix(request);
  }
  create(role: PrimaryRole, operationId: string, targetProviderId = role.current.providerId): Promise<NativeSessionRef> {
    return this.access.create(role.current, `${operationId}:create`, targetProviderId);
  }
  selectNativeCreation(role: PrimaryRole, operationId: string, targetProviderId = role.current.providerId): Promise<NativeSuccessionCreate | undefined> {
    return this.access.selectNativeCreation?.(role.current, `${operationId}:create`, targetProviderId) ?? Promise.resolve(undefined);
  }
  capture(role: PrimaryRole, operationId: string): Promise<SuccessionContextPreparation> { return this.access.capture(role.current, `${operationId}:context`); }
  saveContext(context: SuccessionContextPreparation): Promise<void> { return this.access.saveContext(context); }
  bind(operationId: string, target: NativeSessionRef): Promise<void> { return this.access.bind(operationId, target); }
  /** Consumers inherit these raw rows, never an already composed context prefix. */
  pendingContext(source: NativeSessionRef): SuccessionContextRecord | undefined {
    const context = this.contexts?.forTarget(source);
    return context?.state === 'materialized' && !context.deliveries.some(isSuccessionDeliveryUnresolved) ? undefined : context;
  }
  async verify(role: PrimaryRole, prepared: PreparedSuccession): Promise<SuccessionVerification> {
    if (role.id !== prepared.roleId || role.revision !== prepared.expectedRevision || nativeSessionRefKey(role.current) !== nativeSessionRefKey(prepared.from)) throw new SuccessionPreparationRejected('succession_role_changed', 'Primary role changed after preparation.');
    if (!prepared.preparation) await this.access.verifyAttachment(prepared);
    const retained = await this.access.retainVerification?.(prepared);
    try {
      if (prepared.preparation && !retained) throw new Error('Native prefix verification requires retained attachment evidence.');
      const inspect = retained ? (target: NativeSessionRef) => retained.inspect(target) : undefined;
      const source = await this.check(role, prepared.from, inspect, prepared.preparation);
      await this.check(role, prepared.to, inspect, prepared.preparation);
      if (source.boundary.epoch !== prepared.capture.epoch || source.boundary.seq !== prepared.capture.seq) {
        throw new SuccessionPreparationRejected('succession_boundary_changed', 'Source history changed beyond the captured handoff boundary.');
      }
      retained?.assertCurrent();
      if (prepared.preparation) {
        if (!this.access.verifyNativePrefix) throw new Error('Native prefix verification is unavailable.');
        try { await this.access.verifyNativePrefix(prepared); }
        catch (error) { throw new SuccessionPreparationRejected('succession_prefix_verification_failed', error instanceof Error ? error.message : 'Native prefix readback could not be verified.'); }
        retained!.assertCurrent();
      }
      return retained ?? { assertCurrent() {}, release() {} };
    } catch (error) { retained?.release(); throw error; }
  }
}
