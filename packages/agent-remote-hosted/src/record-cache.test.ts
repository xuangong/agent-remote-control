import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { freeze } from 'immer';
import { encodeHostedSnapshot, decodeHostedSnapshot, HostedRecordCache, hostedRecordEncodingCosts, measureHostedSnapshot, type HostedChunk } from './record-codec.js';
import { createRelayState, emptyRelayState, type HostedRelayState } from './state.js';
import { hostedAuthNamespace } from './hosted-auth.js';

const auth = { origin: 'https://relay.example', issuer: 'https://gateway.example', secret: 'record-cache-secret-0123456789012345678901' };
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
/** Keys and text that JSON escapes, in several record kinds and two accounts. */
function relayState(): HostedRelayState {
  const state = emptyRelayState(auth);
  state.sessions = ['alice', 'bob'].map(subject => ({ hash: hash(subject), sessionExpiresAt: 2_000_000,
    grant: { subject, namespace: hostedAuthNamespace(auth, subject), ticket: 't', nonce: 'n', continuation: 'c', expiresAt: 0, sessionExpiresAt: 2_000_000 } }));
  state.consumedProofs = [['proof-"quoted"-\\-0001', 10], ['proof-😀-0000000002', 20]];
  state.tenants = ['alice', 'bob'].map(subject => ({ subject, namespace: hostedAuthNamespace(auth, subject), broker: {
    keys: [[hash(`${subject}-key`), { expires: 3_000_000, installationId: `${subject}-installation`, kind: 'device' }]],
    hosts: [{ id: `${subject}-host`, installationId: `${subject}-installation`, name: `Host "${subject}" \ud800 😀`, legacyDsh: false, providers: [{ providerId: 'fixture', displayName: 'Fixture' }] }],
    bindings: [{ hostId: `${subject}-host`, providerId: 'fixture', nativeSessionId: 'native\n"session"', agentId: `${subject}-agent`, creatorSubject: subject }],
    creations: [[`["${subject}-host","fixture","operation"]`, { fingerprint: '{"x":"\\u0000"}', agentId: `${subject}-agent` }]],
  } }));
  return state;
}
const manifests = (state: HostedRelayState, cache?: HostedRecordCache) => [...encodeHostedSnapshot(state, auth, undefined, cache).records.values()].map(record => record.manifest);

it('writes each record as JSON.stringify of its envelope and measures its payload as a JSON string', () => {
  const encoded = encodeHostedSnapshot(relayState(), auth);
  for (const [index, cost] of encoded.costs.entries()) {
    const record = [...encoded.records.values()][index]!;
    const bytes = Buffer.concat(record.chunks.map(chunk => chunk.bytes as Uint8Array));
    const envelope = JSON.parse(bytes.toString());
    expect(bytes.toString()).toBe(JSON.stringify(envelope));
    expect(Object.keys(envelope)).toEqual(['format', 'kind', 'owner', 'key', 'payload']);
    expect(cost.payloadStringBytes).toBe(new TextEncoder().encode(JSON.stringify(JSON.stringify(envelope.payload))).byteLength - 2);
    expect(cost.byteLength).toBe(bytes.byteLength);
  }
  expect(measureHostedSnapshot(relayState(), auth)).toEqual(encoded.costs);
});

it('reuses the encodings of unchanged frozen records and encodes the changed ones like a complete encoding', () => {
  const cache = new HostedRecordCache(), costs = new HostedRecordCache();
  const first = freeze(relayState(), true);
  expect(encodeHostedSnapshot(first, auth, undefined, cache).encoded).toBe(manifests(first).length);
  measureHostedSnapshot(first, auth, costs);
  expect(encodeHostedSnapshot(first, auth, undefined, cache).encoded).toBe(0);
  // A copy-on-write change: one binding and the headers that list it are new objects, everything else is shared.
  const tenant = first.tenants[1]!, binding = { ...tenant.broker.bindings[0]!, creatorSubject: 'bob' as const, parentNativeSessionId: 'parent' };
  const second = freeze({ ...first, tenants: [first.tenants[0]!, { ...tenant, broker: { ...tenant.broker, bindings: [binding] } }] }, true);
  const encoded = encodeHostedSnapshot(second, auth, undefined, cache);
  expect(encoded.encoded).toBe(1);
  expect([...encoded.records.values()].map(record => record.manifest)).toEqual(manifests(second));
  expect(measureHostedSnapshot(second, auth, costs)).toEqual(measureHostedSnapshot(second, auth));
});

it('never trusts the identity of an object that can still change', () => {
  const cache = new HostedRecordCache(), costs = new HostedRecordCache(), state = relayState();
  encodeHostedSnapshot(state, auth, undefined, cache); measureHostedSnapshot(state, auth, costs);
  state.tenants[0]!.broker.hosts[0]!.name = 'Changed in place';
  state.sessions[1]!.label = 'Changed in place';
  expect(manifests(state, cache)).toEqual(manifests(state));
  expect(measureHostedSnapshot(state, auth, costs)).toEqual(measureHostedSnapshot(state, auth));
});

it('verification finds a cached encoding that differs from a complete one, reports it and uses the complete one', () => {
  const mismatches: string[][] = [];
  const cache = new HostedRecordCache({ verifyEvery: 1, onMismatch: kinds => mismatches.push(kinds) });
  const state = freeze(relayState(), true);
  encodeHostedSnapshot(state, auth, undefined, cache);
  expect(mismatches).toEqual([]);
  // A defect stands in for a cache that kept a stale encoding of a session.
  const entry = [...cache.entries.values()].find(entry => entry.cost.kind === 'session')!;
  const other = [...cache.entries.values()].find(other => other.cost.kind === 'session' && other !== entry)!;
  entry.encoded = other.encoded; entry.cost = other.cost;
  const result = encodeHostedSnapshot(state, auth, undefined, cache);
  expect(mismatches).toEqual([['session']]);
  expect([...result.records.values()].map(record => record.manifest)).toEqual(manifests(state));
  encodeHostedSnapshot(state, auth, undefined, cache);
  expect(mismatches).toHaveLength(1);
});

it('a cache filled by decoding serves the first encoding after a restart', () => {
  const state = relayState(), records = [...encodeHostedSnapshot(state, auth).records.values()];
  const cache = new HostedRecordCache();
  const decoded = decodeHostedSnapshot(records.map(record => record.manifest), records.flatMap(record => record.chunks as HostedChunk[]), auth, undefined, cache);
  expect(encodeHostedSnapshot(decoded, auth, undefined, cache).encoded).toBe(0);
});

it('commits copy only what a change touches, keep the committed state frozen and return results from drafts', async () => {
  const committed: HostedRelayState[] = [];
  const state = createRelayState(auth, { initial: relayState(), commit: async value => { committed.push(value); } }, () => {}, () => {}, hostedRecordEncodingCosts(auth));
  const before = state.read();
  expect(Object.isFrozen(before.tenants[0]!.broker.hosts[0]!.providers[0])).toBe(true);
  expect(() => { (before.tenants[0]!.broker.hosts[0] as { name: string }).name = 'In place'; }).toThrow(TypeError);
  const host = await state.mutate(draft => { const host = draft.tenants[1]!.broker.hosts[0]!; host.name = 'Renamed'; return host; });
  expect(host).toMatchObject({ name: 'Renamed' });
  const after = state.read();
  expect(committed.at(-1)).toBe(after);
  expect(after.tenants[0]).toBe(before.tenants[0]);
  expect(after.sessions).toBe(before.sessions);
  expect(after.tenants[1]!.broker.bindings).toBe(before.tenants[1]!.broker.bindings);
  expect(after.tenants[1]!.broker.hosts[0]).not.toBe(before.tenants[1]!.broker.hosts[0]);
  expect(Object.isFrozen(after.tenants[1]!.broker.hosts[0])).toBe(true);
});
