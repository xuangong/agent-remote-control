import { AgentOperationRejectedError, type AgentInputAcceptance, type AgentMessageOptions, type AgentPersistenceHandle, type AgentSessionConfig } from './provider.js';
import type { AgentInputPart } from './image-input.js';

export const AGENT_NATIVE_EVIDENCE_REASONS = Object.freeze({
  native_evidence_unavailable: 'Native evidence authority is unavailable.',
  native_evidence_invalid: 'Native evidence is malformed.',
  native_evidence_unsupported: 'The requested native evidence is unsupported.',
  native_evidence_limit: 'Native evidence exceeds its bounded encoding policy.',
  native_evidence_stale: 'Native evidence authority or observation changed.',
  native_evidence_admission: 'Native evidence input admission is unavailable.',
  native_evidence_identity_unusable: 'The native session identity cannot be retained safely.',
  native_evidence_outcome_unknown: 'The native operation outcome is unknown.',
  native_evidence_readback_missing: 'The exact native input is not available.',
  native_evidence_readback_mismatch: 'The native input does not match the prepared evidence.',
  native_evidence_readback_failed: 'The exact native input could not be inspected.',
});
/** The finite closed wrappers add to the complete encoded handle, not its raw opaque length. */
const creationBytes = Math.max(
  16384 + JSON.stringify({ status: 'created', handle: null }).length - 4,
  ...Object.entries(AGENT_NATIVE_EVIDENCE_REASONS).map(([code, reason]) =>
    16384 + JSON.stringify({ status: 'known_rejected', handle: null, code, reason }).length - 4),
);
/** Finite policy for optional evidence v2, not native runtime maxima. */
export const AGENT_NATIVE_EVIDENCE_LIMITS = Object.freeze({ providerBytes: 64, identityBytes: 256, selectionBytes: 512, cwdBytes: 4096, textBytes: 2097152, systemBytes: 16384, providerOptionsBytes: 16384, witnessBytes: 3145728, materializationBytes: 32768, handleBytes: 16384, creationBytes, reasonBytes: 512, codeBytes: 64 });
export type AgentNativeEvidenceCode = keyof typeof AGENT_NATIVE_EVIDENCE_REASONS;
export type AgentNativeEvidenceAvailability = { status: 'configured'; version: 2 } | { status: 'unavailable'; code: AgentNativeEvidenceCode; reason: string };
export type AgentEmptySessionConfig = Pick<AgentSessionConfig, 'sessionId' | 'cwd'> & {
  /** Same-provider native selection source only; never forks history or creates a parent relation. */
  selectionSourceSessionId?: string;
};
/** Created may be a prepared empty descriptor. It must retain the same native identity without input; resume never implies permission to initialize missing history. */
export type AgentEmptyCreationResult = { status: 'created'; handle: AgentPersistenceHandle } | { status: 'known_rejected'; handle: AgentPersistenceHandle; code: AgentNativeEvidenceCode; reason: string } | { status: 'unknown'; code: AgentNativeEvidenceCode; reason: string };
export interface AgentProviderNativeEvidence {
  availability(): AgentNativeEvidenceAvailability;
  createEmpty(config: AgentEmptySessionConfig): Promise<AgentEmptyCreationResult>;
}
export type AgentNativeAuthorityScope = Readonly<{ kind: 'trusted-service' | 'owned-runtime'; authorityId: string; namespaceId: string }>;
/** inputId is adapter-owned correlation, which need not be a preallocated native record ID. */
export type AgentPreparedTextInput = Readonly<{
  version: 2; providerId: string; nativeSessionId: string; inputId: string; cwd: string;
  authority: AgentNativeAuthorityScope;
  parts: readonly [Readonly<{ type: 'text'; text: string }>];
  content: Readonly<{ encoding: 'utf-8'; bytes: number; sha256: string }>;
  selections: Readonly<{ model?: string; agent?: string; variant?: string; system?: string; reasoningEffort?: string; providerOptions?: string; delivery?: 'immediate' }>;
}>;
export type AgentTextInputProof = Readonly<{
  version: 2; providerId: string; nativeSessionId: string; inputId: string; nativeInputId: string; cwd: string; authority: AgentNativeAuthorityScope;
  witnessSha256: string; contentSha256: string; nativeSelectionsSha256: string; nativePartIds?: readonly [string];
}>;
export type AgentNativeInputExecution = Readonly<{ disposition: 'started'; nativeExecutionId: string }>;
export type AgentInputMaterialization = { status: 'materialized'; proof: AgentTextInputProof; execution?: AgentNativeInputExecution } | { status: 'unknown'; code: AgentNativeEvidenceCode; reason: string };
declare const nativeValidityToken: unique symbol;
/** Process-local object identity owned by one attachment; never readiness or persistence. */
export interface AgentNativeValidityToken { readonly [nativeValidityToken]: true; }
export interface AgentNativeReadiness {
  cwd: string;
  idle: boolean;
  pendingInputs: number;
  pendingInteractions: number;
  activeChildren: number;
}
export interface AgentSessionNativeEvidence {
  availability(): AgentNativeEvidenceAvailability;
  /** Current adapter-owned observations; throws when required native facts are unavailable. */
  inspectReadiness(): Promise<AgentNativeReadiness>;
  prepareInput(parts: readonly AgentInputPart[], options?: AgentMessageOptions): Promise<AgentPreparedTextInput>;
  dispatchInput(witness: AgentPreparedTextInput): Promise<AgentInputAcceptance | void>;
  inspectInput(witness: AgentPreparedTextInput): Promise<AgentInputMaterialization>;
  captureValidity(): AgentNativeValidityToken;
  isCurrent(token: AgentNativeValidityToken): boolean;
}
/** Post-invocation uncertainty must not be treated as an effect-free rejection. */
export class AgentNativeEvidenceOutcomeUnknownError extends Error {
  readonly code = 'native_evidence_outcome_unknown';
  constructor() { super(AGENT_NATIVE_EVIDENCE_REASONS.native_evidence_outcome_unknown); this.name = 'AgentNativeEvidenceOutcomeUnknownError'; }
}
const limits = AGENT_NATIVE_EVIDENCE_LIMITS;
function reject(code: 'native_evidence_invalid' | 'native_evidence_limit' = 'native_evidence_invalid'): never { throw new AgentOperationRejectedError(code, AGENT_NATIVE_EVIDENCE_REASONS[code]); }
function unicode(value: string): boolean { return !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(value); }
function bytes(value: string): Uint8Array {
  const output = new Uint8Array(value.length * 3); let index = 0;
  for (const character of value) { const code = character.codePointAt(0)!;
    if (code < 0x80) output[index++] = code;
    else if (code < 0x800) { output[index++] = 0xc0 | code >>> 6; output[index++] = 0x80 | code & 63; }
    else if (code < 0x10000) { output[index++] = 0xe0 | code >>> 12; output[index++] = 0x80 | code >>> 6 & 63; output[index++] = 0x80 | code & 63; }
    else { output[index++] = 0xf0 | code >>> 18; output[index++] = 0x80 | code >>> 12 & 63; output[index++] = 0x80 | code >>> 6 & 63; output[index++] = 0x80 | code & 63; }
  }
  return output.subarray(0, index);
}
function string(value: unknown, max: number, empty = false): asserts value is string {
  if (typeof value !== 'string' || !unicode(value) || (!empty && !value)) reject();
  if (bytes(value).length > max) reject('native_evidence_limit');
}
function identity(value: unknown, max: number = limits.identityBytes): void { string(value, max); if (!/^[A-Za-z0-9][A-Za-z0-9._:-]*$/.test(value)) reject(); }
function digest(value: unknown): void { if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) reject(); }
function object(value: unknown, required: string[], optional: string[] = []): asserts value is Record<string, any> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) reject();
  const keys = Object.keys(value); if (required.some(key => !keys.includes(key)) || keys.some(key => !required.includes(key) && !optional.includes(key))) reject();
}
function validateIdentity(value: Record<string, any>): void {
  if (value.version !== 2) reject(); identity(value.providerId, limits.providerBytes); identity(value.nativeSessionId); identity(value.inputId);
  string(value.cwd, limits.cwdBytes); if (value.cwd.includes('\0')) reject();
  object(value.authority, ['kind', 'authorityId', 'namespaceId']); if (!['trusted-service', 'owned-runtime'].includes(value.authority.kind)) reject(); identity(value.authority.authorityId); identity(value.authority.namespaceId);
}
/** Copies only inert JSON data before schema access, rejecting accessors without invoking them. */
function copyJson(value: unknown, ancestors = new Set<object>(), depth = 0): any {
  if (depth > 16) reject();
  if (typeof value === 'string') { if (!unicode(value)) reject(); return value; }
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') { if (!Number.isFinite(value) || Object.is(value, -0)) reject(); return value; }
  if (!value || typeof value !== 'object' || ancestors.has(value)) reject();
  const array = Array.isArray(value); const prototype = Object.getPrototypeOf(value);
  if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) reject();
  if (Object.getOwnPropertySymbols(value).length) reject();
  ancestors.add(value);
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Object.values(descriptors).some(descriptor => !('value' in descriptor))) reject();
  let result: any;
  if (array) {
    const length = (value as unknown[]).length;
    if (Object.keys(descriptors).length !== length + 1) reject();
    result = [];
    for (let i = 0; i < length; i++) { const d = descriptors[String(i)]; if (!d?.enumerable) reject(); result.push(copyJson(d.value, ancestors, depth + 1)); }
  } else {
    result = Object.create(null);
    for (const key of Object.keys(descriptors).sort()) { const d = descriptors[key]!; if (!d.enumerable || !unicode(key)) reject(); result[key] = copyJson(d.value, ancestors, depth + 1); }
  }
  ancestors.delete(value); return result;
}
function freeze<T>(value: T): T { if (value && typeof value === 'object') { for (const child of Object.values(value)) freeze(child); Object.freeze(value); } return value; }
function encode(value: unknown, max: number, validate: (value: any) => void): string { const copy = copyJson(value); validate(copy); const result = JSON.stringify(copy); if (bytes(result).length > max) reject('native_evidence_limit'); return result; }
function parse<T>(encoded: string, max: number, validate: (value: any) => void): T {
  string(encoded, max); let value: unknown;
  try { value = JSON.parse(encoded); } catch { reject(); }
  if (encode(value, max, validate) !== encoded) reject(); return freeze(value as T);
}
function validateWitness(value: any): void {
  object(value, ['version', 'providerId', 'nativeSessionId', 'inputId', 'cwd', 'authority', 'parts', 'content', 'selections']); validateIdentity(value);
  if (!Array.isArray(value.parts) || value.parts.length !== 1) reject(); object(value.parts[0], ['type', 'text']); if (value.parts[0].type !== 'text') reject();
  string(value.parts[0].text, limits.textBytes, true);
  object(value.content, ['encoding', 'bytes', 'sha256']); if (value.content.encoding !== 'utf-8' || !Number.isSafeInteger(value.content.bytes) || value.content.bytes < 0 || value.content.bytes !== bytes(value.parts[0].text).length) reject();
  digest(value.content.sha256); if (value.content.sha256 !== sha256(bytes(value.parts[0].text))) reject();
  object(value.selections, [], ['model', 'agent', 'variant', 'system', 'reasoningEffort', 'providerOptions', 'delivery']);
  for (const key of ['model', 'agent', 'variant', 'reasoningEffort']) if (key in value.selections) { string(value.selections[key], limits.selectionBytes); if (/[\u0000-\u001f\u007f-\u009f]/u.test(value.selections[key])) reject(); }
  if ('system' in value.selections) string(value.selections.system, limits.systemBytes, true);
  if ('providerOptions' in value.selections) string(value.selections.providerOptions, limits.providerOptionsBytes, true);
  if ('delivery' in value.selections && value.selections.delivery !== 'immediate') reject();
}
function validateReason(value: Record<string, any>): void {
  string(value.code, limits.codeBytes); string(value.reason, limits.reasonBytes);
  if (!Object.hasOwn(AGENT_NATIVE_EVIDENCE_REASONS, value.code) || value.reason !== AGENT_NATIVE_EVIDENCE_REASONS[value.code as AgentNativeEvidenceCode]) reject();
}
function validateCreation(value: any): void {
  if (value?.status === 'unknown') { object(value, ['status', 'code', 'reason']); validateReason(value); return; }
  if (value?.status === 'created') object(value, ['status', 'handle']);
  else { object(value, ['status', 'handle', 'code', 'reason']); if (value.status !== 'known_rejected') reject(); validateReason(value); }
  object(value.handle, ['providerId', 'sessionId', 'opaque']);
  identity(value.handle.providerId, limits.providerBytes); identity(value.handle.sessionId);
  string(value.handle.opaque, limits.handleBytes, true);
  if (bytes(JSON.stringify(value.handle)).length > limits.handleBytes) reject('native_evidence_limit');
}
function validateMaterialization(value: any): void {
  if (value?.status === 'unknown') {
    object(value, ['status', 'code', 'reason']);
    validateReason(value);
    return;
  }
  object(value, ['status', 'proof'], ['execution']); if (value.status !== 'materialized') reject(); const proof = value.proof;
  object(proof, ['version', 'providerId', 'nativeSessionId', 'inputId', 'nativeInputId', 'cwd', 'authority', 'witnessSha256', 'contentSha256', 'nativeSelectionsSha256'], ['nativePartIds']); validateIdentity(proof); identity(proof.nativeInputId);
  if ('execution' in value) { object(value.execution, ['disposition', 'nativeExecutionId']); if (value.execution.disposition !== 'started') reject(); identity(value.execution.nativeExecutionId); }
  digest(proof.witnessSha256); digest(proof.contentSha256); digest(proof.nativeSelectionsSha256);
  if ('nativePartIds' in proof) { if (!Array.isArray(proof.nativePartIds) || proof.nativePartIds.length !== 1) reject(); identity(proof.nativePartIds[0]); }
}
export function serializeAgentEmptyCreationResult(value: AgentEmptyCreationResult): string { return encode(value, limits.creationBytes, validateCreation); }
export function parseAgentEmptyCreationResult(encoded: string): AgentEmptyCreationResult { return parse(encoded, limits.creationBytes, validateCreation); }
export function serializeAgentPreparedTextInput(value: AgentPreparedTextInput): string { return encode(value, limits.witnessBytes, validateWitness); }
export function parseAgentPreparedTextInput(encoded: string): AgentPreparedTextInput { return parse(encoded, limits.witnessBytes, validateWitness); }
export function serializeAgentInputMaterialization(value: AgentInputMaterialization): string { return encode(value, limits.materializationBytes, validateMaterialization); }
export function parseAgentInputMaterialization(encoded: string): AgentInputMaterialization { return parse(encoded, limits.materializationBytes, validateMaterialization); }

/** Synchronous SHA-256 keeps the public codecs usable in browser and Node consumers. */
function sha256(input: Uint8Array): string {
  const constants = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  const data = new Uint8Array(Math.ceil((input.length + 9) / 64) * 64); data.set(input); data[input.length] = 128;
  const view = new DataView(data.buffer); view.setUint32(data.length - 8, Math.floor(input.length / 0x20000000)); view.setUint32(data.length - 4, input.length * 8);
  const state = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19]; const words = new Uint32Array(64);
  const rotate = (value: number, n: number) => value >>> n | value << 32 - n;
  for (let offset = 0; offset < data.length; offset += 64) {
    for (let i = 0; i < 16; i++) words[i] = view.getUint32(offset + i * 4);
    for (let i = 16; i < 64; i++) { const x = words[i - 15]!, y = words[i - 2]!; words[i] = words[i - 16]! + (rotate(x,7) ^ rotate(x,18) ^ x >>> 3) + words[i - 7]! + (rotate(y,17) ^ rotate(y,19) ^ y >>> 10); }
    let [a,b,c,d,e,f,g,h] = state as [number,number,number,number,number,number,number,number];
    for (let i = 0; i < 64; i++) { const t = h + (rotate(e,6) ^ rotate(e,11) ^ rotate(e,25)) + (e & f ^ ~e & g) + constants[i]! + words[i]!; const u = (rotate(a,2) ^ rotate(a,13) ^ rotate(a,22)) + (a & b ^ a & c ^ b & c); h=g;g=f;f=e;e=d+t|0;d=c;c=b;b=a;a=t+u|0; }
    for (const [i, value] of [a,b,c,d,e,f,g,h].entries()) state[i] = (state[i]! + value) >>> 0;
  }
  return state.map(value => value.toString(16).padStart(8,'0')).join('');
}
