import { createHash } from 'node:crypto';
import { expect, test } from 'vitest';
import * as sdk from './index.js';

const api = sdk as unknown as Record<string, any>;
const hash = (text: string) => createHash('sha256').update(text).digest('hex');
function witness(text = '你好\n"exact"') {
  return { version: 1, providerId: 'opencode', nativeSessionId: 'ses_B', nativeInputId: 'msg_U', cwd: '/fixture', store: { authorityId: 'fixture', storeId: 'store' }, parts: [{ type: 'text', text }], content: { encoding: 'utf-8', bytes: Buffer.byteLength(text), sha256: hash(text) }, selections: { model: 'test/model', agent: 'build', system: '' } };
}
function canonical(value: any): string { return JSON.stringify(value, function(_key, v) { return v && typeof v === 'object' && !Array.isArray(v) ? Object.fromEntries(Object.keys(v).sort().map(k => [k, v[k]])) : v; }); }

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
  for (const input of [' ' + valid, valid.replace('"version":1', '"version":1,"version":1'), valid.replace('"opencode"', '"openco\\u0064e"')]) expect(() => api.parseAgentPreparedTextInput(input)).toThrow(sdk.AgentOperationRejectedError);
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
test('materialization proofs contain identity and digests, never copied text or disposition', () => {
  const w = witness();
  const result = { status: 'materialized', proof: { version: 1, providerId: w.providerId, nativeSessionId: w.nativeSessionId, nativeInputId: w.nativeInputId, cwd: w.cwd, store: w.store, witnessSha256: hash(canonical(w)), contentSha256: w.content.sha256, nativeSelectionsSha256: hash(canonical(w.selections)), nativePartIds: ['prt_P'] } };
  const encoded = api.serializeAgentInputMaterialization(result);
  expect(api.parseAgentInputMaterialization(encoded)).toEqual(result);
  expect(() => api.serializeAgentInputMaterialization({ ...result, disposition: 'started' })).toThrow(sdk.AgentOperationRejectedError);
  for (const code of ['native_error', {}, ['native_evidence_readback_missing'], null]) expect(() => api.serializeAgentInputMaterialization({ status: 'unknown', code, reason: 'secret' })).toThrow(sdk.AgentOperationRejectedError);
});

test.each([
  ['providerId', 'p'.repeat(65)], ['nativeSessionId', 's'.repeat(257)], ['nativeInputId', 'u'.repeat(257)], ['cwd', '/' + '路'.repeat(1366)],
])('enforces the finite %s field budget', (key, value) => {
  expect(() => api.serializeAgentPreparedTextInput({ ...witness(), [key]: value })).toThrow(sdk.AgentOperationRejectedError);
});
test.each(['model', 'agent', 'variant'])('validates the actual %s selection as bounded Unicode', key => {
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
  const bad: any[] = [{ ...witness(), selections: { system: 'x'.repeat(16385) } }, { ...witness(), content: { ...witness().content, bytes: Infinity } }, { ...witness(), store: new Date() }];
  const hidden = witness(); Object.defineProperty(hidden, 'hidden', { value: 'x' }); bad.push(hidden);
  for (const value of bad) expect(() => api.serializeAgentPreparedTextInput(value)).toThrow(sdk.AgentOperationRejectedError);
});
