import { createHash } from 'node:crypto';
import {
  AGENT_NATIVE_EVIDENCE_LIMITS as limits, AGENT_NATIVE_EVIDENCE_REASONS as reasons, AgentOperationRejectedError, AgentNativeEvidenceOutcomeUnknownError,
  parseAgentPreparedTextInput, serializeAgentPreparedTextInput, parseAgentInputMaterialization, serializeAgentInputMaterialization,
  type AgentNativeEvidenceCode, type AgentNativeEvidenceAvailability, type AgentEmptySessionConfig, type AgentEmptyCreationResult,
  type AgentProviderNativeEvidence, type AgentSessionNativeEvidence, type AgentNativeStoreIdentity, type AgentNativeValidityToken,
  type AgentPreparedTextInput, type AgentInputMaterialization, type AgentInputPart, type AgentMessageOptions, type AgentPersistenceHandle,
} from '@orchardworks/agent-provider-sdk';
import type { GlobalEvent, Session } from '@opencode-ai/sdk/v2/client';
import { OpenCodeTransport, OpenCodeRequestError } from './transport.js';
import { openCodeModel } from './settings.js';

/** Private issuer contract. The issuer verifies this exact transport's durable store;
 * no production issuer is installed, and caller configuration cannot supply identity. */
export interface OpenCodeNativeEvidenceVerifier {
  captureStore(transport: OpenCodeTransport, cwd: string): { status: 'unavailable' } | { status: 'verified'; store: AgentNativeStoreIdentity; lease: object };
  isCurrent(lease: object): boolean;
  /** Scoped profile/observation continuity, distinct from durable store continuity. */
  isObservationCurrent(lease: object): boolean;
  subscribe(invalidate: () => void): () => void;
}
type Lease = { store: AgentNativeStoreIdentity; token: object };
function reject(code: AgentNativeEvidenceCode): never { throw new AgentOperationRejectedError(code, reasons[code]); }
const unknown = (code: AgentNativeEvidenceCode): AgentInputMaterialization & { status: 'unknown' } => ({ status: 'unknown', code, reason: reasons[code] });
const hash = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex');
function canonical(value: any): string { return JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item); }
function same(a: unknown, b: unknown): boolean { return canonical(a) === canonical(b); }
function wellFormed(value: string): boolean { return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value); }
function bounded(value: unknown, max: number, empty = false): asserts value is string { if (typeof value !== 'string' || !wellFormed(value) || (!empty && !value)) reject('native_evidence_invalid'); if (Buffer.byteLength(value) > max) reject('native_evidence_limit'); }
function identity(value: unknown, max: number = limits.identityBytes): asserts value is string { bounded(value, max); if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) reject('native_evidence_invalid'); }
function directory(value: unknown): asserts value is string { bounded(value, limits.cwdBytes); if (value.includes('\0')) reject('native_evidence_invalid'); }
function owned(value: unknown, required: string[], optional: string[] = []): asserts value is Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || ![Object.prototype, null].includes(Object.getPrototypeOf(value))) reject('native_evidence_invalid');
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.getOwnPropertySymbols(value).length || Object.values(descriptors).some(d => !('value' in d) || !d.enumerable)) reject('native_evidence_invalid');
  const keys = Object.keys(descriptors); if (required.some(key => !keys.includes(key)) || keys.some(key => !required.includes(key) && !optional.includes(key))) reject('native_evidence_invalid');
}
function store(value: unknown): AgentNativeStoreIdentity { owned(value, ['authorityId', 'storeId']); identity(value.authorityId); identity(value.storeId); return Object.freeze({ authorityId: value.authorityId, storeId: value.storeId }); }

class Authority {
  constructor(readonly transport: OpenCodeTransport, readonly verifier?: OpenCodeNativeEvidenceVerifier) {}
  availability(): AgentNativeEvidenceAvailability { return this.verifier ? { status: 'configured', version: 1 } : { status: 'unavailable', code: 'native_evidence_unavailable', reason: reasons.native_evidence_unavailable }; }
  capture(cwd: string, observation = false): Lease {
    if (!this.verifier) reject('native_evidence_unavailable');
    let result: ReturnType<OpenCodeNativeEvidenceVerifier['captureStore']>;
    try { result = this.verifier.captureStore(this.transport, cwd); } catch { reject('native_evidence_unavailable'); }
    if (result.status !== 'verified' || !result.lease || typeof result.lease !== 'object') reject('native_evidence_unavailable');
    const lease = { store: store(result.store), token: result.lease }; if (!this.current(lease, observation)) reject('native_evidence_stale'); return lease;
  }
  current(lease: Lease, observation = false): boolean { try { return !!this.verifier?.isCurrent(lease.token) && (!observation || this.verifier.isObservationCurrent(lease.token)); } catch { return false; } }
  check(lease: Lease, observation = false): void { if (!this.current(lease, observation)) reject('native_evidence_stale'); }
}
interface EmptyHandle { version: 1; kind: 'opencode.empty'; cwd: string; store: AgentNativeStoreIdentity; }
function creationHandle(id: string, metadata: EmptyHandle | { version: 1; kind: 'opencode.empty-recovery'; expectedCwd: string; expectedStore: AgentNativeStoreIdentity; failureCode: AgentNativeEvidenceCode }): AgentPersistenceHandle {
  const handle = { providerId: 'opencode', sessionId: id, opaque: canonical(metadata) }; if (Buffer.byteLength(canonical(handle)) > limits.handleBytes) reject('native_evidence_limit'); return handle;
}
export class OpenCodeProviderNativeEvidence implements AgentProviderNativeEvidence {
  private readonly authority: Authority;
  constructor(private readonly transport: OpenCodeTransport, verifier: OpenCodeNativeEvidenceVerifier | undefined, private readonly canonicalDirectory: (cwd: string) => Promise<string>, private readonly isOpen: () => boolean) { this.authority = new Authority(transport, verifier); }
  availability(): AgentNativeEvidenceAvailability { return this.authority.availability(); }
  async createEmpty(config: AgentEmptySessionConfig): Promise<AgentEmptyCreationResult> {
    owned(config, ['sessionId'], ['cwd']); identity(config.sessionId); if (config.cwd !== undefined) directory(config.cwd);
    if (!this.isOpen() || this.transport.restricted) reject('native_evidence_admission');
    if (!this.authority.verifier) reject('native_evidence_unavailable');
    let cwd: string; try { cwd = await this.canonicalDirectory(config.cwd ?? process.cwd()); } catch { reject('native_evidence_invalid'); } directory(cwd);
    const lease = this.authority.capture(cwd);
    // Escaping inside opaque is included before the sole effect, with the largest legal B/code.
    for (const failureCode of Object.keys(reasons) as AgentNativeEvidenceCode[]) creationHandle('B'.repeat(limits.identityBytes), { version: 1, kind: 'opencode.empty-recovery', expectedCwd: cwd, expectedStore: lease.store, failureCode });
    creationHandle('B'.repeat(limits.identityBytes), { version: 1, kind: 'opencode.empty', cwd, store: lease.store });
    this.authority.check(lease); if (!this.isOpen()) reject('native_evidence_admission');
    let retained: string | undefined;
    try {
      const native = await this.transport.request(() => this.transport.client.session.create({ directory: cwd }));
      try { identity(native?.id); retained = native.id; } catch { return unknown('native_evidence_identity_unusable'); }
      this.authority.check(lease); if (!this.isOpen()) reject('native_evidence_admission');
      if (!native || typeof native.directory !== 'string') reject('native_evidence_invalid');
      const actual = await this.canonicalDirectory(native.directory); this.authority.check(lease);
      if (!this.isOpen() || actual !== cwd) reject('native_evidence_invalid');
      return { status: 'created', handle: creationHandle(retained, { version: 1, kind: 'opencode.empty', cwd, store: lease.store }) };
    } catch (error) {
      if (!retained) return unknown('native_evidence_outcome_unknown');
      const code: AgentNativeEvidenceCode = error instanceof AgentOperationRejectedError && Object.hasOwn(reasons, error.code) ? error.code as AgentNativeEvidenceCode : 'native_evidence_invalid';
      return { status: 'known_rejected', handle: creationHandle(retained, { version: 1, kind: 'opencode.empty-recovery', expectedCwd: cwd, expectedStore: lease.store, failureCode: code }), code, reason: reasons[code] };
    }
  }
  /** Returns undefined only for an ordinary legacy handle. Recovery envelopes never attach. */
  async resume(handle: AgentPersistenceHandle, parsed: unknown): Promise<{ native: Session; cwd: string; validate(): void } | undefined> {
    if (!parsed || typeof parsed !== 'object' || !('kind' in parsed)) return;
    if ((parsed as any).kind !== 'opencode.empty') reject('native_evidence_invalid');
    owned(handle, ['providerId', 'sessionId', 'opaque']); identity(handle.sessionId); bounded(handle.opaque, limits.handleBytes);
    owned(parsed, ['version', 'kind', 'cwd', 'store']); const metadata: Record<string, any> = parsed; if (metadata.version !== 1 || handle.providerId !== 'opencode' || canonical(parsed) !== handle.opaque) reject('native_evidence_invalid');
    directory(metadata.cwd); const expectedStore = store(metadata.store); creationHandle(handle.sessionId, { version: 1, kind: 'opencode.empty', cwd: metadata.cwd, store: expectedStore });
    const lease = this.authority.capture(metadata.cwd); if (!same(lease.store, expectedStore)) reject('native_evidence_stale');
    const cwd = await this.canonicalDirectory(metadata.cwd); this.authority.check(lease); if (cwd !== metadata.cwd || !this.isOpen()) reject('native_evidence_stale');
    const native = await this.transport.request(() => this.transport.client.session.get({ sessionID: handle.sessionId, directory: cwd })); this.authority.check(lease);
    if (native.id !== handle.sessionId) reject('native_evidence_invalid');
    const actual = await this.canonicalDirectory(native.directory); this.authority.check(lease); if (actual !== cwd || !this.isOpen()) reject('native_evidence_stale');
    return { native, cwd, validate: () => { this.authority.check(lease); if (!this.isOpen()) reject('native_evidence_stale'); } };
  }
}

interface SessionEvidencePorts {
  cwd: string; nativeId: string;
  currentSession(): Session | undefined;
  selections(): AgentPreparedTextInput['selections'];
  messageId(): string;
  writable(): void;
  canCapture(): boolean;
  readable(): boolean;
  reserveInput(id: string): void;
  scheduleRefresh(): void;
  canonicalDirectory(cwd: string): Promise<string>;
}
type ReadFence = { revision: number; lease: Lease };
function relevantMetadata(session: Session): string {
  const value = { ...session } as Record<string, any>;
  if (typeof value.title === 'string') delete value.title;
  if (typeof value.cost === 'number' && Number.isFinite(value.cost)) delete value.cost;
  const strip = (source: any, fields: Record<string, 'number' | 'string'>) => {
    if (!source || typeof source !== 'object' || Array.isArray(source)) return source;
    const rest = { ...source };
    for (const [key, type] of Object.entries(fields)) if (typeof rest[key] === type && (type !== 'number' || Number.isFinite(rest[key]))) delete rest[key];
    return rest;
  };
  const finish = (key: string, item: any) => { if (item && typeof item === 'object' && !Array.isArray(item) && !Object.keys(item).length) delete value[key]; else if (item !== undefined) value[key] = item; };
  finish('share', strip(value.share, { url: 'string' }));
  const summary = strip(value.summary, { additions: 'number', deletions: 'number', files: 'number' });
  if (summary && Array.isArray(summary.diffs) && summary.diffs.every((diff: unknown) => {
    if (!diff || typeof diff !== 'object' || Array.isArray(diff)) return false;
    return Object.keys(strip(diff, { file: 'string', patch: 'string', additions: 'number', deletions: 'number', status: 'string' })).length === 0;
  })) delete summary.diffs;
  finish('summary', summary);
  const tokens = strip(value.tokens, { input: 'number', output: 'number', reasoning: 'number' });
  if (tokens && typeof tokens === 'object' && !Array.isArray(tokens) && tokens.cache) {
    const cache = strip(tokens.cache, { read: 'number', write: 'number' });
    if (cache && typeof cache === 'object' && !Array.isArray(cache) && !Object.keys(cache).length) delete tokens.cache; else tokens.cache = cache;
  }
  finish('tokens', tokens);
  if (value.time) value.time = strip(value.time, { updated: 'number' });
  return canonical(value);
}

const supportedEvents = new Set(['message.updated', 'message.part.updated', 'message.part.delta', 'message.removed', 'message.part.removed', 'session.status', 'session.idle', 'session.error', 'todo.updated', 'session.compacted', 'permission.asked', 'question.asked', 'permission.replied', 'question.rejected', 'question.replied', 'session.updated', 'session.deleted', 'session.next.agent.switched', 'session.next.model.switched']);
export class OpenCodeSessionNativeEvidence implements AgentSessionNativeEvidence {
  private readonly authority: Authority;
  private revision = 0;
  private baseline = -1;
  private baselineLease?: Lease;
  private unsupported = false;
  private disposed = false;
  private work = 0;
  private localEffects = 0;
  private readonly tokens = new WeakMap<object, ReadFence>();
  private readonly unsubscribe?: () => void;
  constructor(private readonly transport: OpenCodeTransport, verifier: OpenCodeNativeEvidenceVerifier | undefined, private readonly ports: SessionEvidencePorts) {
    this.authority = new Authority(transport, verifier);
    this.unsubscribe = verifier?.subscribe(() => { this.invalidate(); this.ports.scheduleRefresh(); });
  }
  availability(): AgentNativeEvidenceAvailability { return this.authority.availability(); }
  invalidate(unsupported = false): void { if (this.revision === Number.MAX_SAFE_INTEGER) this.unsupported = true; else this.revision++; this.baseline = -1; this.unsupported ||= unsupported; }
  noteSession(native: Session, previous: Session | undefined): void {
    if (!this.authority.verifier || !previous) return;
    if (relevantMetadata(native) !== relevantMetadata(previous)) { this.invalidate(native.id !== this.ports.nativeId || native.directory !== this.ports.cwd); this.ports.scheduleRefresh(); }
  }
  readFailed(): void { if (this.authority.verifier) { this.invalidate(); this.ports.scheduleRefresh(); } }
  beginObservedRead(): () => void {
    if (!this.authority.verifier) return () => {};
    this.invalidate(); this.beginWork();
    return () => { this.endWork(); this.ports.scheduleRefresh(); };
  }
  beginWork(): void { this.work++; }
  endWork(): void { this.work--; }
  beginEffect(): () => void { if (!this.authority.verifier) return () => {}; this.invalidate(); this.localEffects++; return () => { this.localEffects--; this.ports.scheduleRefresh(); }; }
  receive(global: GlobalEvent, current: Session | undefined, childIds: readonly string[]): void {
    if (!this.authority.verifier || this.disposed) return;
    const event = global.payload as { type?: string; properties?: Record<string, any> } | undefined;
    if (!event || typeof event.type !== 'string') { this.invalidate(true); return; }
    if (event.type === 'server.connected' || event.type === 'server.heartbeat') return;
    const p = event.properties ?? {}; const nested = p.info ?? p.part;
    const sessionId = p.sessionID ?? nested?.sessionID ?? (event.type.startsWith('session.') ? nested?.id : undefined);
    if (sessionId !== this.ports.nativeId) {
      if (nested?.parentID === this.ports.nativeId || childIds.includes(sessionId)) { this.invalidate(true); this.ports.scheduleRefresh(); return; }
      // Without verified ancestry, a different session ID cannot prove irrelevance.
      this.invalidate(true); return;
    }
    if (event.type === 'session.updated' && current && p.info) {
      try { if (relevantMetadata(current) === relevantMetadata(p.info)) return; } catch { /* Unknown metadata remains relevant. */ }
    }
    const unsupported = !supportedEvents.has(event.type) || event.type === 'session.deleted' || (event.type === 'session.updated' && (!p.info || p.info.id !== this.ports.nativeId || p.info.directory !== this.ports.cwd));
    this.invalidate(unsupported); this.ports.scheduleRefresh();
  }
  readFence(): ReadFence | undefined {
    try { if (this.disposed || this.unsupported || !this.ports.readable()) return; return { revision: this.revision, lease: this.authority.capture(this.ports.cwd, true) }; } catch { return; }
  }
  readCurrent(fence: ReadFence | undefined): fence is ReadFence { return !!fence && !this.disposed && !this.unsupported && this.ports.readable() && this.revision === fence.revision && this.authority.current(fence.lease, true); }
  completeBaseline(fence: ReadFence | undefined, native: Session): void {
    if (this.readCurrent(fence) && native.id === this.ports.nativeId && native.directory === this.ports.cwd) { this.baseline = fence.revision; this.baselineLease = fence.lease; }
  }
  private clean(): boolean { return !this.disposed && !this.unsupported && this.baseline === this.revision && !!this.baselineLease && this.authority.current(this.baselineLease, true) && this.work === 0 && this.localEffects === 0 && this.ports.canCapture(); }
  captureValidity(): AgentNativeValidityToken {
    const lease = this.authority.capture(this.ports.cwd, true); if (!this.clean()) reject('native_evidence_stale');
    const token = Object.freeze(Object.create(null)) as AgentNativeValidityToken; this.tokens.set(token, { revision: this.revision, lease }); return token;
  }
  isCurrent(token: AgentNativeValidityToken): boolean { if (!token || typeof token !== 'object') return false; const fence = this.tokens.get(token); return !!fence && this.clean() && this.readCurrent(fence); }
  private witness(value: AgentPreparedTextInput): AgentPreparedTextInput { return parseAgentPreparedTextInput(serializeAgentPreparedTextInput(value)); }
  private selections(delivery?: 'immediate'): AgentPreparedTextInput['selections'] {
    const values = this.ports.selections();
    if (!values.model || !values.agent) reject('native_evidence_unsupported');
    try { openCodeModel(values.model); } catch { reject('native_evidence_unsupported'); }
    for (const key of ['model', 'agent', 'variant'] as const) if (values[key] !== undefined) { bounded(values[key], limits.selectionBytes); if (/[\u0000-\u001f\u007f-\u009f]/u.test(values[key])) reject('native_evidence_invalid'); }
    if (values.system !== undefined) bounded(values.system, limits.systemBytes, true);
    return { ...values, ...(delivery === undefined ? {} : { delivery }) };
  }
  async prepareInput(parts: readonly AgentInputPart[], options?: AgentMessageOptions): Promise<AgentPreparedTextInput> {
    if (!Array.isArray(parts) || Object.getPrototypeOf(parts) !== Array.prototype || parts.length !== 1 || Object.getOwnPropertySymbols(parts).length || Object.getOwnPropertyNames(parts).length !== 2) reject('native_evidence_invalid');
    const descriptor = Object.getOwnPropertyDescriptor(parts, '0'); if (!descriptor || !('value' in descriptor)) reject('native_evidence_invalid');
    owned(descriptor.value, ['type', 'text']); if (descriptor.value.type !== 'text') reject('native_evidence_unsupported'); bounded(descriptor.value.text, limits.textBytes, true);
    const text = descriptor.value.text;
    if (options !== undefined) { owned(options, [], ['delivery']); if (options.delivery !== undefined && options.delivery !== 'immediate') reject('native_evidence_unsupported'); }
    const lease = this.authority.capture(this.ports.cwd, true); this.captureValidity();
    const selections = this.selections(options?.delivery as 'immediate' | undefined);
    const input = this.witness({ version: 1, providerId: 'opencode', nativeSessionId: this.ports.nativeId, nativeInputId: this.ports.messageId(), cwd: this.ports.cwd, store: lease.store, parts: [{ type: 'text', text }], content: { encoding: 'utf-8', bytes: Buffer.byteLength(text), sha256: hash(text) }, selections });
    this.authority.check(lease, true); return input;
  }
  private matches(witness: AgentPreparedTextInput, lease: Lease): void { if (witness.providerId !== 'opencode' || witness.nativeSessionId !== this.ports.nativeId || witness.cwd !== this.ports.cwd || !same(witness.store, lease.store)) reject('native_evidence_stale'); }
  async dispatchInput(value: AgentPreparedTextInput): Promise<void> {
    const witness = this.witness(value); const lease = this.authority.capture(this.ports.cwd, true); this.matches(witness, lease);
    this.captureValidity(); if (!same(witness.selections, this.selections(witness.selections.delivery))) reject('native_evidence_stale');
    this.ports.writable(); this.authority.check(lease, true); this.ports.reserveInput(witness.nativeInputId);
    const finish = this.beginEffect();
    try {
      await this.transport.request(() => this.transport.client.session.promptAsync({ sessionID: this.ports.nativeId, directory: this.ports.cwd, messageID: witness.nativeInputId, parts: [{ type: 'text', text: witness.parts[0].text }], model: openCodeModel(witness.selections.model), agent: witness.selections.agent, ...(witness.selections.variant === undefined ? {} : { variant: witness.selections.variant }), ...(witness.selections.system === undefined ? {} : { system: witness.selections.system }) }));
      if (this.disposed || !this.authority.current(lease, true)) throw new AgentNativeEvidenceOutcomeUnknownError();
    } catch { throw new AgentNativeEvidenceOutcomeUnknownError(); } finally { finish(); }
  }
  async inspectInput(value: AgentPreparedTextInput): Promise<AgentInputMaterialization> {
    const witness = this.witness(value); const fence = this.readFence();
    const inconclusive = (code: AgentNativeEvidenceCode) => { this.invalidate(); this.ports.scheduleRefresh(); return unknown(code); };
    if (!fence) return unknown('native_evidence_unavailable');
    this.beginWork();
    try {
      this.matches(witness, fence.lease);
      const native = await this.transport.request(() => this.transport.client.session.get({ sessionID: this.ports.nativeId, directory: this.ports.cwd }));
      if (!this.readCurrent(fence)) return inconclusive('native_evidence_stale');
      this.noteSession(native, this.ports.currentSession());
      if (!this.readCurrent(fence)) return inconclusive('native_evidence_stale');
      if (native.id !== witness.nativeSessionId) return inconclusive('native_evidence_readback_mismatch');
      const cwd = await this.ports.canonicalDirectory(native.directory); if (!this.readCurrent(fence)) return inconclusive('native_evidence_stale');
      if (cwd !== witness.cwd) return inconclusive('native_evidence_readback_mismatch');
      const message = await this.transport.request(() => this.transport.client.session.message({ sessionID: this.ports.nativeId, messageID: witness.nativeInputId, directory: this.ports.cwd }));
      if (!this.readCurrent(fence)) return inconclusive('native_evidence_stale');
      owned(message, ['info', 'parts']); owned(message.info, ['id', 'sessionID', 'role', 'time', 'agent', 'model'], ['system', 'summary']);
      const info = message.info;
      if (info.id !== witness.nativeInputId || info.sessionID !== witness.nativeSessionId || info.role !== 'user') return inconclusive('native_evidence_readback_mismatch');
      owned(info.model, ['providerID', 'modelID'], ['variant']); owned(info.time, ['created']); if (!Number.isSafeInteger(info.time.created) || info.time.created < 0) return inconclusive('native_evidence_readback_mismatch');
      const selections = { model: `${info.model.providerID}/${info.model.modelID}`, agent: info.agent, ...('variant' in info.model ? { variant: info.model.variant } : {}), ...('system' in info ? { system: info.system } : {}) };
      const { delivery: _delivery, ...expected } = witness.selections;
      if (!same(selections, expected) || !same(openCodeModel(witness.selections.model), { providerID: info.model.providerID, modelID: info.model.modelID })) return inconclusive('native_evidence_readback_mismatch');
      if (!Array.isArray(message.parts) || message.parts.length !== 1) return inconclusive('native_evidence_readback_mismatch');
      const part: unknown = message.parts[0]; owned(part, ['id', 'sessionID', 'messageID', 'type', 'text'], ['synthetic', 'ignored', 'time']); identity(part.id);
      if (part.synthetic !== undefined && part.synthetic !== false || part.ignored !== undefined && part.ignored !== false) return inconclusive('native_evidence_readback_mismatch');
      if (part.time !== undefined) { owned(part.time, ['start'], ['end']); for (const time of Object.values(part.time)) if (!Number.isSafeInteger(time) || (time as number) < 0) return inconclusive('native_evidence_readback_mismatch'); }
      if (part.type !== 'text' || part.sessionID !== witness.nativeSessionId || part.messageID !== witness.nativeInputId || part.text !== witness.parts[0].text) return inconclusive('native_evidence_readback_mismatch');
      bounded(part.text, limits.textBytes, true); if (Buffer.byteLength(part.text) !== witness.content.bytes || hash(part.text) !== witness.content.sha256) return inconclusive('native_evidence_readback_mismatch');
      const result: AgentInputMaterialization = { status: 'materialized', proof: { version: 1, providerId: witness.providerId, nativeSessionId: witness.nativeSessionId, nativeInputId: witness.nativeInputId, cwd: witness.cwd, store: witness.store, witnessSha256: hash(serializeAgentPreparedTextInput(witness)), contentSha256: witness.content.sha256, nativeSelectionsSha256: hash(canonical(expected)), nativePartIds: [part.id] } };
      return parseAgentInputMaterialization(serializeAgentInputMaterialization(result));
    } catch (error) {
      if (!this.readCurrent(fence)) return inconclusive('native_evidence_stale');
      if (error instanceof OpenCodeRequestError) return inconclusive(error.status === 404 ? 'native_evidence_readback_missing' : 'native_evidence_readback_failed');
      return inconclusive('native_evidence_readback_mismatch');
    } finally { this.endWork(); }
  }
  dispose(): void { this.disposed = true; this.invalidate(); this.unsubscribe?.(); }
}
