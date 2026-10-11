import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import * as sdk from './index.js';

const api = sdk as unknown as Record<string, any>;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function witness(text = '你好\n"exact"') {
  return { version: 2, providerId: 'opencode', nativeSessionId: 'ses_B', inputId: 'msg_U', cwd: '/fixture', authority: { kind: 'trusted-service', authorityId: 'fixture', namespaceId: 'namespace' }, parts: [{ type: 'text', text }], content: { encoding: 'utf-8', bytes: Buffer.byteLength(text), sha256: hash(text) }, selections: { model: 'test/model', agent: 'build', system: '' } };
}
function canonical(value: any): string { return JSON.stringify(value, function(_key, v) { return v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v; }); }

test.each(['created', 'known_rejected', 'unknown'])('empty creation codec preserves the closed %s result and uninterpreted handle', status => {
  const result = { status, ...(status === 'unknown' ? {} : { handle: { providerId: 'provider', sessionId: 'native-B', opaque: 'not JSON: "原样"\n' } }), ...(status === 'created' ? {} : { code: 'native_evidence_stale', reason: 'Native evidence authority or observation changed.' }) };
  const encoded = api.serializeAgentEmptyCreationResult(result);
  expect(encoded).toBe(canonical(result));
  const parsed = api.parseAgentEmptyCreationResult(encoded);
  expect(parsed).toEqual(result); expect(Object.isFrozen(parsed)).toBe(true);
  if (status !== 'unknown') expect(Object.isFrozen(parsed.handle)).toBe(true);
});
test('empty creation codec measures the complete escaped handle at and beyond its bound', () => {
  const handle = { providerId: 'provider', sessionId: 'B', opaque: '' };
  const room = 16384 - Buffer.byteLength(JSON.stringify(handle));
  handle.opaque = '\n'.repeat(Math.floor(room / 2)) + 'x'.repeat(room % 2);
  expect(Buffer.byteLength(JSON.stringify(handle))).toBe(16384);
  const result = { status: 'known_rejected', handle, code: 'native_evidence_readback_mismatch', reason: 'The native input does not match the prepared evidence.' };
  expect(api.parseAgentEmptyCreationResult(api.serializeAgentEmptyCreationResult(result))).toEqual(result);
  expect(() => api.serializeAgentEmptyCreationResult({ ...result, handle: { ...handle, opaque: handle.opaque + 'x' } })).toThrow(sdk.AgentOperationRejectedError);
});
test('empty creation codec rejects ambiguous outcomes, malformed public handles and unsafe reasons', () => {
  const handle = { providerId: 'provider', sessionId: 'B', opaque: '' };
  expect(api.parseAgentEmptyCreationResult(api.serializeAgentEmptyCreationResult({ status: 'created', handle }))).toEqual({ status: 'created', handle });
  const bad = [
    { status: 'created' }, { status: 'created', handle, code: 'native_evidence_stale' },
    { status: 'unknown', handle, code: 'native_evidence_stale', reason: 'Native evidence authority or observation changed.' },
    { status: 'known_rejected', handle, code: 'native_evidence_stale', reason: 'private native secret' },
    { status: 'created', handle: { ...handle, providerId: 'p'.repeat(65) } },
    { status: 'created', handle: { ...handle, sessionId: 'b'.repeat(257) } },
    { status: 'created', handle: { ...handle, opaque: '\ud800' } },
    { status: 'created', handle: { ...handle, cwd: '/provider-private' } },
  ];
  for (const value of bad) expect(() => api.serializeAgentEmptyCreationResult(value)).toThrow(sdk.AgentOperationRejectedError);
  const encoded = canonical({ status: 'created', handle });
  for (const value of [' ' + encoded, encoded.replace('"created"', '"created","status":"created"')]) expect(() => api.parseAgentEmptyCreationResult(value)).toThrow(sdk.AgentOperationRejectedError);
});
test('empty creation codec rejects non-inert handle data without evaluating it', () => {
  let accessed = false;
  const handle = { providerId: 'provider', sessionId: 'B' };
  Object.defineProperty(handle, 'opaque', { enumerable: true, get() { accessed = true; return 'secret'; } });
  expect(() => api.serializeAgentEmptyCreationResult({ status: 'created', handle })).toThrow(sdk.AgentOperationRejectedError);
  expect(accessed).toBe(false);
});

test('exports optional bounded evidence codecs without changing legacy acceptance', () => {
  expect(api.AGENT_NATIVE_EVIDENCE_LIMITS).toMatchObject({ textBytes: 2097152, witnessBytes: 3145728, materializationBytes: 32768, handleBytes: 16384 });
  expect(api.AgentNativeEvidenceOutcomeUnknownError).toBeTypeOf('function');
});
test.each(['', 'abc', '你好\n"exact"', '🌷🌱', ...([55, 56, 63, 64, 65, 1000, 1048576].map(n => 'a'.repeat(n)))])('canonical witness validates exact UTF-8 and sha256', text => {
  const original = witness(text); const encoded = api.serializeAgentPreparedTextInput(original);
  expect(encoded).toBe(canonical(original));
  const parsed = api.parseAgentPreparedTextInput(encoded);
  expect(parsed).toEqual(original); expect(Object.isFrozen(parsed)).toBe(true); expect(Object.isFrozen(parsed.parts[0])).toBe(true);
});
test('rejects alternate JSON encodings, duplicate keys and digest lies', () => {
  const valid = canonical(witness());
  for (const input of [' ' + valid, valid.replace('"version":2', '"version":2,"version":2'), valid.replace('"opencode"', '"openco\\u0064e"')]) expect(() => api.parseAgentPreparedTextInput(input)).toThrow(sdk.AgentOperationRejectedError);
  const wrong = witness(); wrong.content.sha256 = '0'.repeat(64);
  expect(() => api.serializeAgentPreparedTextInput(wrong)).toThrow(sdk.AgentOperationRejectedError);
});
test('rejects non-JSON values and unknown fields without invoking accessors', () => {
  let accessed = false;
  const accessor = witness(); Object.defineProperty(accessor, 'extra', { enumerable: true, get() { accessed = true; return 'secret'; } });
  const sparse = witness(); sparse.parts = new Array(1);
  const cycle: any = witness(); cycle.extra = cycle;
  const symbol: any = witness(); symbol[Symbol('hidden')] = 1;
  for (const input of [accessor, sparse, cycle, symbol, { ...witness(), extra: undefined }, { ...witness(), cwd: new String('/fixture') }, { ...witness(), parts: [{ type: 'text', text: '\ud800' }] }]) expect(() => api.serializeAgentPreparedTextInput(input)).toThrow(sdk.AgentOperationRejectedError);
  expect(accessed).toBe(false);
});
test('enforces both raw and final escaped witness ceilings without truncation', () => {
  expect(() => api.serializeAgentPreparedTextInput(witness('a'.repeat(2097153)))).toThrow(sdk.AgentOperationRejectedError);
  expect(() => api.serializeAgentPreparedTextInput(witness('\u0000'.repeat(600000)))).toThrow(sdk.AgentOperationRejectedError);
  expect(() => api.parseAgentPreparedTextInput(' '.repeat(3145729))).toThrow(sdk.AgentOperationRejectedError);
});
test('materialization proofs preserve materialization separately from exact execution evidence', () => {
  const w = witness();
  const result = { status: 'materialized', proof: { version: 2, providerId: w.providerId, nativeSessionId: w.nativeSessionId, inputId: w.inputId, nativeInputId: 'native_U', cwd: w.cwd, authority: w.authority, witnessSha256: hash(canonical(w)), contentSha256: w.content.sha256, nativeSelectionsSha256: hash(canonical(w.selections)), nativePartIds: ['prt_P'] } };
  const encoded = api.serializeAgentInputMaterialization(result);
  expect(api.parseAgentInputMaterialization(encoded)).toEqual(result);
  const started = { ...result, execution: { disposition: 'started', nativeExecutionId: 'msg_R' } };
  expect(api.parseAgentInputMaterialization(api.serializeAgentInputMaterialization(started))).toEqual(started);
  for (const execution of [{ disposition: 'handled', nativeExecutionId: 'msg_R' }, { disposition: 'started' }, { disposition: 'started', nativeExecutionId: '' }]) {
    expect(() => api.serializeAgentInputMaterialization({ ...result, execution })).toThrow(sdk.AgentOperationRejectedError);
  }
  expect(() => api.serializeAgentInputMaterialization({ status: 'unknown', code: 'native_evidence_readback_missing', reason: sdk.AGENT_NATIVE_EVIDENCE_REASONS.native_evidence_readback_missing, execution: started.execution })).toThrow(sdk.AgentOperationRejectedError);
  for (const code of ['native_error', {}, ['native_evidence_readback_missing'], null]) expect(() => api.serializeAgentInputMaterialization({ status: 'unknown', code, reason: 'secret' })).toThrow(sdk.AgentOperationRejectedError);
});

test.each([
  ['providerId', 'p'.repeat(65)], ['nativeSessionId', 's'.repeat(257)], ['inputId', 'u'.repeat(257)], ['cwd', '/' + '路'.repeat(1366)],
])('enforces the finite %s field budget', (key, value) => {
  expect(() => api.serializeAgentPreparedTextInput({ ...witness(), [key]: value })).toThrow(sdk.AgentOperationRejectedError);
});
test.each(['model', 'agent', 'variant', 'reasoningEffort'])('validates the actual %s selection as bounded Unicode', key => {
  for (const value of ['a'.repeat(513), '', 'line\nbreak', null, undefined]) {
    const w = witness(); (w.selections as any)[key] = value;
    expect(() => api.serializeAgentPreparedTextInput(w)).toThrow(sdk.AgentOperationRejectedError);
  }
});
test('accepts maximum text bytes when the canonical witness fits and preserves null prototypes', () => {
  const w = witness('a'.repeat(2097152)); Object.setPrototypeOf(w, null);
  expect(api.parseAgentPreparedTextInput(api.serializeAgentPreparedTextInput(w)).content.bytes).toBe(2097152);
});
test('rejects system overflow, nonfinite metadata, nonplain and hidden data', () => {
  const bad: any[] = [{ ...witness(), selections: { system: 'x'.repeat(16385) } }, { ...witness(), content: { ...witness().content, bytes: Infinity } }, { ...witness(), authority: new Date() }];
  const hidden = witness(); Object.defineProperty(hidden, 'hidden', { value: 'x' }); bad.push(hidden);
  for (const value of bad) expect(() => api.serializeAgentPreparedTextInput(value)).toThrow(sdk.AgentOperationRejectedError);
});


test('private runtimes bind caller correlation separately from native record and execution identities', () => {
  const input = { ...witness(), providerId: 'copilot', authority: { kind: 'owned-runtime', authorityId: 'owner', namespaceId: 'profile' },
    selections: { reasoningEffort: 'high', providerOptions: '{"permissionMode":"default"}' } };
  const saved = api.parseAgentPreparedTextInput(api.serializeAgentPreparedTextInput(input));
  expect(saved).toEqual(input);
  expect(saved).not.toHaveProperty('nativeInputId');
  const result = { status: 'materialized', proof: { version: 2, providerId: saved.providerId, nativeSessionId: saved.nativeSessionId,
    inputId: saved.inputId, nativeInputId: 'native_user_42', cwd: saved.cwd, authority: saved.authority,
    witnessSha256: hash(canonical(saved)), contentSha256: saved.content.sha256, nativeSelectionsSha256: hash(canonical(saved.selections)) },
    execution: { disposition: 'started', nativeExecutionId: 'native_turn_42' } };
  expect(api.parseAgentInputMaterialization(api.serializeAgentInputMaterialization(result))).toEqual(result);
  for (const nativeInputId of [undefined, '', 'u'.repeat(257)]) {
    expect(() => api.serializeAgentInputMaterialization({ ...result, proof: { ...result.proof, nativeInputId } })).toThrow(sdk.AgentOperationRejectedError);
  }
  expect(() => api.serializeAgentPreparedTextInput({ ...input, authority: { ...input.authority, kind: 'guessed' } })).toThrow(sdk.AgentOperationRejectedError);
});
test('provider option snapshots are opaque bounded bytes, not public permission interpretation', () => {
  const input = { ...witness(), selections: { providerOptions: 'x'.repeat(16384) } };
  expect(api.parseAgentPreparedTextInput(api.serializeAgentPreparedTextInput(input)).selections).toEqual(input.selections);
  expect(() => api.serializeAgentPreparedTextInput({ ...input, selections: { providerOptions: 'x'.repeat(16385) } })).toThrow(sdk.AgentOperationRejectedError);
});
