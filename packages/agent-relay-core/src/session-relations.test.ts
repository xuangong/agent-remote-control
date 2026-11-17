import { createHash } from 'node:crypto';
import { expect, it } from 'vitest';
import { emptyRelayState, validateRelayState } from './state.js';

const auth = { origin: 'https://relay.example', issuer: 'https://gateway.example', secret: 'relation-state-fixture-secret-01234567890123456789' };
function savedRelation(change: Record<string, unknown>) {
  const state = emptyRelayState(auth);
  const source = { hostId: 'host', providerId: 'codex', nativeSessionId: 'source', agentId: 'source-agent' };
  state.tenants.push({ subject: 'alice', namespace: createHash('sha256').update(JSON.stringify([auth.issuer, 'alice'])).digest('hex'), broker: {
    keys: [], hosts: [{ id: 'host', installationId: 'installation', name: 'Host', providers: [{ providerId: 'codex', displayName: 'Codex' }], legacyDsh: false }],
    creations: [], bindings: [source, { ...source, nativeSessionId: 'side', agentId: 'side-agent', sourceRelation: {
      id: 'relation', kind: 'side', sourceNativeSessionId: 'source', createdAt: '2026-10-02T00:00:00.000Z', ...change,
    } }],
  } });
  return state;
}

it('loads legacy relations and retains explicit unlink revisions during state recovery', () => {
  expect(() => validateRelayState(savedRelation({}), auth)).not.toThrow();
  const restored = validateRelayState(savedRelation({ linked: false, revision: 3 }), auth);
  expect(restored.tenants[0]?.broker.bindings[1]?.sourceRelation).toMatchObject({ id: 'relation', linked: false, revision: 3 });
}, 10000);

it.each([{ linked: 'false' }, { linked: null }, { revision: -1 }, { revision: 0.5 }, { revision: '1' },
  { revision: null }, { revision: Number.MAX_SAFE_INTEGER + 1 }])('rejects invalid persisted relation state: %j', change => {
  expect(() => validateRelayState(savedRelation(change), auth)).toThrow('Invalid or unsupported Relay state.');
}, 10000);
