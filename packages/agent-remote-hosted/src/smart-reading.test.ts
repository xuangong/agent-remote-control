import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { emptyRelayState, validateRelayState } from './state.js';

const auth = { origin: 'https://relay.example', issuer: 'https://issuer.example', secret: 'test-secret' };
const state = (host: Record<string, unknown> = {}, broker: Record<string, unknown> = {}) => ({
  ...emptyRelayState(auth),
  tenants: [{ subject: 'owner', namespace: createHash('sha256').update(JSON.stringify([auth.issuer, 'owner'])).digest('hex'), broker: {
    keys: [], bindings: [], creations: [],
    hosts: [{ id: 'host', installationId: 'machine', name: 'Machine', providers: [{ providerId: 'codex', displayName: 'Codex' }], legacyDsh: false, ...host }],
    ...broker,
  } }],
});

describe('the smart reading switch in saved state', () => {
  it('accepts a Host without the switch and a Host with distinct providers', () => {
    expect(() => validateRelayState(state(), auth)).not.toThrow();
    expect(() => validateRelayState(state({ smartReading: ['claude', 'codex'] }), auth)).not.toThrow();
  });

  it.each([
    ['an empty list', []],
    ['a repeated provider', ['codex', 'codex']],
    ['a provider that is not a string', [1]],
    ['an empty provider id', ['']],
    ['something that is not a list', 'codex'],
    ['more than 64 providers', Array.from({ length: 65 }, (_, at) => `provider-${at}`)],
  ])('rejects %s', (_name, value) => {
    expect(() => validateRelayState(state({ smartReading: value }), auth)).toThrow();
  });
});

describe('the pending journal deletions in saved state', () => {
  it('accepts none and a list of distinct Host ids', () => {
    expect(() => validateRelayState(state({}, { journalDeletions: ['gone-1', 'gone-2'] }), auth)).not.toThrow();
  });

  it.each([
    ['an empty list', []],
    ['a repeated id', ['gone', 'gone']],
    ['an id that is not a string', [1]],
    ['something that is not a list', 'gone'],
    ['more than 128 ids', Array.from({ length: 129 }, (_, at) => `gone-${at}`)],
  ])('rejects %s', (_name, value) => {
    expect(() => validateRelayState(state({}, { journalDeletions: value }), auth)).toThrow();
  });
});
