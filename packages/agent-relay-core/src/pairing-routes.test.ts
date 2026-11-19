import { describe, expect, it } from 'vitest';

import { createAccess } from './access.js';
import { createBrokerState } from './broker-state.js';
import { createPairingRoutes } from './pairing-routes.js';
import { sequentialRelayIds } from './relay-ids.js';
import { hashOf } from './test-utils/fake-host-link.js';

const NOW = 1_000_000;

function setup(options: { accountBacked?: boolean; ownerSubject?: string; gatewaySetup?: boolean; keyLifetimeMs?: number; successionEnrollment?: boolean; journals?: boolean } = {}) {
  const accountBacked = options.accountBacked ?? false;
  const state = createBrokerState({ initialState: undefined, now: () => NOW, keepsAssociations: false, keepsSharing: options.ownerSubject !== undefined });
  const offered: Array<[string, number]> = [];
  const route = createPairingRoutes({
    options: { ...(options.gatewaySetup === undefined ? {} : { gatewaySetup: options.gatewaySetup }), ...(options.keyLifetimeMs === undefined ? {} : { keyLifetimeMs: options.keyLifetimeMs }),
      ...(options.ownerSubject ? { ownerSubject: options.ownerSubject } : {}), ...(options.successionEnrollment ? { successionEnrollment: {} as never } : {}), onPairing: (key, expiresAt) => { offered.push([key, expiresAt]); } },
    access: createAccess({ state, ownerSubject: options.ownerSubject }), brokerState: state, now: () => NOW, ids: sequentialRelayIds(), accountBacked, keyHash: hashOf,
    visibleHosts: subject => [{ id: 'h1', online: true, subject }] as never,
    rpc: async () => { throw new Error('No Controller.'); }, disconnected: () => undefined, previews: { forget: () => undefined } as never, deletion: { revoked: () => undefined, drain: () => undefined, deleteOne: async () => false },
    journals: options.journals ? {} as never : undefined, journalSessions: undefined, credentialExpiry: { expire: () => () => undefined, enforce: () => undefined }, sessionBindings: { forgetHost: () => undefined } as never,
  });
  const call = async (method: string, path: string, body?: unknown, subject?: string) => {
    const request = new Request(`https://relay.example${path}`, { method, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const response = await route(request, {}, new URL(request.url), subject);
    return response && { status: response.status, body: await response.json() as any };
  };
  return { state, call, offered };
}

describe('pairing keys', () => {
  it('creates a temporary key, saves only its hash, and offers the key once', async () => {
    const run = setup();
    const created = await run.call('POST', '/v1/remote/pairings', {});
    expect(created).toMatchObject({ status: 201 });
    const [key, expiresAt] = run.offered[0]!;
    expect(key).toMatch(/^arc_token-1$/);
    expect(expiresAt).toBe(NOW + 24 * 60 * 60 * 1000);
    expect([...run.state.keys.keys()]).toEqual([hashOf(key)]);
    expect(run.state.keys.get(hashOf(key))).toMatchObject({ expires: expiresAt, purpose: 'host-only' });
    expect(JSON.stringify(run.state.snapshot())).not.toContain(key);
    expect(run.state.pairings).toEqual([expect.objectContaining({ purpose: 'host-only', createdAt: NOW, expiresAt })]);
  });

  it('gives an account-backed Relay ten-minute keys that must rotate, and a configured lifetime wins', async () => {
    const backed = setup({ accountBacked: true });
    await backed.call('POST', '/v1/remote/pairings', {});
    expect(backed.offered[0]![1]).toBe(NOW + 10 * 60 * 1000);
    expect([...backed.state.keys.values()][0]).toMatchObject({ requiresRotation: true });
    const configured = setup({ accountBacked: true, keyLifetimeMs: 5_000 });
    await configured.call('POST', '/v1/remote/pairings', {});
    expect(configured.offered[0]![1]).toBe(NOW + 5_000);
  });

  it('lists the pairings newest first with the purposes this Relay can offer', async () => {
    const run = setup({ accountBacked: true });
    await run.call('POST', '/v1/remote/pairings', { purpose: 'gateway-setup' });
    const listed = await run.call('GET', '/v1/remote/pairings');
    expect(listed!.body.availablePurposes).toEqual(['host-only', 'gateway-setup']);
    expect(listed!.body.pairings).toHaveLength(1);
    await expect(setup({ accountBacked: true, gatewaySetup: false }).call('GET', '/v1/remote/pairings')).resolves.toMatchObject({ body: { availablePurposes: ['host-only'] } });
  });

  it('refuses a purpose the Relay cannot serve, and a body with anything else in it', async () => {
    await expect(setup().call('POST', '/v1/remote/pairings', { purpose: 'gateway-setup' })).rejects.toMatchObject({ status: 400, code: 'unsupported_purpose' });
    await expect(setup({ accountBacked: true, gatewaySetup: false }).call('POST', '/v1/remote/pairings', { purpose: 'gateway-setup' })).rejects.toMatchObject({ status: 403, code: 'unsupported_purpose' });
    await expect(setup().call('POST', '/v1/remote/pairings', { purpose: 'host-only', extra: 1 })).rejects.toMatchObject({ status: 400, code: 'invalid_request' });
    await expect(setup().call('POST', '/v1/remote/pairings', { purpose: 'unknown' })).rejects.toMatchObject({ status: 400, code: 'invalid_request' });
  });

  it('refuses recovery pairing unless the Relay is account-backed, owned and enrolling successions', async () => {
    await expect(setup().call('POST', '/v1/remote/pairings', { recoverHostId: 'h1' })).rejects.toMatchObject({ status: 400, code: 'host_recovery_unavailable' });
    await expect(setup({ accountBacked: true, ownerSubject: 'owner' }).call('POST', '/v1/remote/pairings', { recoverHostId: 'h1' }, 'owner')).rejects.toMatchObject({ code: 'host_recovery_unavailable' });
  });

  it('keeps at most 128 live keys, dropping the expired ones first', async () => {
    const run = setup();
    for (let index = 0; index < 128; index += 1) run.state.keys.set(`k${index}`, { expires: NOW + 1000 });
    await expect(run.call('POST', '/v1/remote/pairings', {})).rejects.toMatchObject({ status: 429, code: 'capacity_exceeded' });
    for (let index = 0; index < 100; index += 1) run.state.keys.set(`k${index}`, { expires: NOW });
    await expect(run.call('POST', '/v1/remote/pairings', {})).resolves.toMatchObject({ status: 201 });
    expect(run.state.keys.size).toBe(29);
  });

  it('lets only the owner manage keys, and lists Hosts for the asking subject', async () => {
    const run = setup({ ownerSubject: 'owner' });
    await expect(run.call('POST', '/v1/remote/pairings', {}, 'guest')).rejects.toMatchObject({ status: 403, code: 'owner_required' });
    expect(run.state.keys.size).toBe(0);
    await expect(run.call('GET', '/v1/remote/hosts', undefined, 'guest')).resolves.toMatchObject({ status: 200, body: { hosts: [{ id: 'h1', subject: 'guest' }] } });
    await expect(run.call('GET', '/v1/remote/unknown')).resolves.toBeUndefined();
  });
});

describe('smart reading and revocation', () => {
  const addHost = (state: ReturnType<typeof setup>['state']) => {
    state.hosts.set('h1', { id: 'h1', installationId: 'inst', name: 'Host', providers: [{ providerId: 'codex', displayName: 'Codex' }], legacyDsh: false, generation: 1, pending: new Map(), streams: new Map() });
    state.keys.set('device-hash', { expires: NOW + 1000, installationId: 'inst', kind: 'device' });
    state.keys.set('other-hash', { expires: NOW + 1000, installationId: 'other', kind: 'device' });
  };

  it('changes smart reading only for a body that names a provider and a boolean, and nothing else', async () => {
    const run = setup({ journals: true }); addHost(run.state);
    const bad = [{ providerId: 'codex' }, { providerId: 'codex', enabled: 'yes' }, { providerId: 'codex', enabled: true, extra: 1 }, { enabled: true }];
    for (const body of bad) await expect(run.call('PUT', '/v1/remote/hosts/h1/smart-reading', body)).rejects.toMatchObject({ status: 400 });
    expect(run.state.hosts.get('h1')!.smartReading).toBeUndefined();
    await expect(run.call('PUT', '/v1/remote/hosts/h1/smart-reading', { providerId: 'codex', enabled: true })).resolves.toMatchObject({ status: 200, body: { providers: ['codex'] } });
  });

  it('lets only the owner of a shared Relay revoke a Host, and takes the Host and its credentials away', async () => {
    const run = setup({ accountBacked: true, ownerSubject: 'owner' }); addHost(run.state);
    await expect(run.call('POST', '/v1/remote/hosts/h1/revoke', {}, 'guest')).rejects.toMatchObject({ status: 403, code: 'owner_required' });
    expect(run.state.hosts.has('h1')).toBe(true);
    expect(run.state.keys.has('device-hash')).toBe(true);
    await expect(run.call('POST', '/v1/remote/hosts/h1/revoke', {}, 'owner')).resolves.toMatchObject({ status: 200, body: { ok: true } });
    expect(run.state.hosts.has('h1')).toBe(false);
    expect([...run.state.keys.keys()]).toEqual(['other-hash']);
  });

  it('serves the account revocation only to an account-backed Relay, and only as a POST to a revoke path', async () => {
    const standalone = setup(); addHost(standalone.state);
    await expect(standalone.call('POST', '/v1/remote/hosts/h1/revoke', {})).resolves.toBeUndefined();
    expect(standalone.state.hosts.has('h1')).toBe(true);
    const backed = setup({ accountBacked: true }); addHost(backed.state);
    await expect(backed.call('GET', '/v1/remote/hosts/h1/revoke')).resolves.toBeUndefined();
    await expect(backed.call('GET', '/v1/remote/unknown')).resolves.toBeUndefined();
    expect(backed.state.hosts.has('h1')).toBe(true);
  });
});

