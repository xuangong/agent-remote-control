import { describe, expect, it } from 'vitest';

import { createAccess } from './access.js';
import { createBrokerState } from './broker-state.js';
import type { Binding, Host } from './broker-types.js';
import { HostSharing } from './host-sharing.js';
import { RELAY_SOCKET_OPEN } from './transport.js';

const host = (id: string, online = true): Host => ({ id, installationId: `i-${id}`, name: id, providers: [], legacyDsh: false, generation: 1, pending: new Map(), streams: new Map(),
  ...(online ? { ready: true, socket: { readyState: RELAY_SOCKET_OPEN } as never } : {}) });
const binding = (agentId: string, hostId: string, creatorSubject?: string): Binding => ({ hostId, providerId: 'codex', nativeSessionId: agentId, agentId, generation: 1, ...(creatorSubject ? { creatorSubject } : {}) });

function setup(ownerSubject: string | undefined) {
  const state = createBrokerState({ initialState: undefined, now: () => 0, keepsAssociations: false, keepsSharing: ownerSubject !== undefined });
  state.hosts.set('h1', host('h1'));
  state.hosts.set('offline', host('offline', false));
  return { state, access: createAccess({ state, ownerSubject }) };
}

describe('access without an owner subject', () => {
  it('treats every caller as the owner', () => {
    const { access } = setup(undefined);
    expect(access.owner('anyone')).toBe(true);
    expect(access.owner(undefined)).toBe(true);
    expect(access.hostAllowed('h1', undefined)).toBe(true);
    expect(() => access.requireOwner(undefined)).not.toThrow();
  });
});

describe('access with an owner subject', () => {
  it('lets the owner reach every Host and session, and refuses another subject a Host nobody shared', () => {
    const { state, access } = setup('owner');
    const mine = binding('a1', 'h1');
    state.bindings.set('a1', mine);
    expect(access.hostAllowed('h1', 'owner')).toBe(true);
    expect(access.sessionAllowed(mine, 'owner')).toBe(true);
    expect(access.hostAllowed('h1', 'guest')).toBe(false);
    expect(() => access.requireAccess('h1', 'guest')).toThrow(expect.objectContaining({ status: 403, code: 'host_forbidden' }));
    expect(() => access.requireAccess('unknown', 'owner')).toThrow(expect.objectContaining({ status: 404, code: 'host_not_found' }));
    expect(() => access.requireOwner('guest')).toThrow(expect.objectContaining({ status: 403, code: 'owner_required' }));
  });

  it('lets a subject the Host was shared with reach only the sessions it created', () => {
    const { state, access } = setup('owner');
    state.sharing = new HostSharing({ grants: [{ hostId: 'h1', subject: 'guest', sessionQuota: 5 } as never], reservations: [] }, () => {});
    const ownersSession = binding('a1', 'h1'), guests = binding('a2', 'h1', 'guest');
    state.bindings.set('a1', ownersSession); state.bindings.set('a2', guests);
    expect(access.hostAllowed('h1', 'guest')).toBe(true);
    expect(access.sessionAllowed(guests, 'guest')).toBe(true);
    expect(access.sessionAllowed(ownersSession, 'guest')).toBe(false);
  });

  it('never allows a binding that is no longer the registered one, nor anything once the state is unavailable', () => {
    const { state, access } = setup('owner');
    const current = binding('a1', 'h1');
    state.bindings.set('a1', current);
    expect(access.sessionAllowed({ ...current }, 'owner')).toBe(false);
    state.close();
    expect(access.hostAllowed('h1', 'owner')).toBe(false);
    expect(access.sessionAllowed(current, 'owner')).toBe(false);
  });
});

describe('access requireHost', () => {
  it('returns an online Host and says why it cannot otherwise', () => {
    const { state, access } = setup('owner');
    expect(access.requireHost('h1').id).toBe('h1');
    expect(() => access.requireHost('missing')).toThrow(expect.objectContaining({ status: 404, code: 'host_not_found' }));
    expect(() => access.requireHost('offline')).toThrow(expect.objectContaining({ status: 503, code: 'host_offline', creationRejected: true }));
    state.close();
    expect(() => access.requireHost('h1')).toThrow(expect.objectContaining({ code: 'state_unavailable' }));
  });
});
