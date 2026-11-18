import { SharingError } from './host-sharing.js';
import type { BrokerState } from './broker-state.js';
import { BrokerError, type Binding, type Host } from './broker-types.js';
import { RELAY_SOCKET_OPEN } from './transport.js';

/**
 * Who may see and act on what. The account has one owner (when `ownerSubject` is set); a Host the owner shared with another subject
 * is visible to that subject, and on it the subject reaches only the sessions it created. Without an owner subject (the standalone
 * workbench) every caller is the owner.
 *
 * Contract: every function is a pure read of `BrokerState` (Hosts, bindings, sharing grants) and throws `SharingError` (403, 404) or
 * `BrokerError`. `hostAllowed` and `sessionAllowed` are false while the state is unavailable, and a binding that is no longer the
 * registered one is never allowed. `requireHost` is the one way to reach a Host's connection: it fails with `host_not_found`,
 * `state_unavailable` or `host_offline` before any Host call is made.
 */
export interface Access {
  owner(subject?: string): boolean;
  hostAllowed(hostId: string, subject?: string): boolean;
  sessionAllowed(binding: Binding, subject?: string): boolean;
  requireOwner(subject?: string): void;
  requireAccess(hostId: string, subject?: string): void;
  /** The Host with this id when it is online and registered. */
  requireHost(id: string): Host;
}

export function createAccess(ports: { state: Pick<BrokerState, 'hosts' | 'bindings' | 'sharing' | 'unavailable' | 'assertAvailable'>; ownerSubject: string | undefined }): Access {
  const { state, ownerSubject } = ports;
  const owner = (subject?: string) => ownerSubject === undefined || subject === ownerSubject;
  const hostAllowed = (hostId: string, subject?: string) => !state.unavailable && state.hosts.has(hostId) && (owner(subject) || (subject !== undefined && state.sharing.allowed(hostId, subject)));
  return {
    owner, hostAllowed,
    sessionAllowed: (binding, subject) => state.bindings.get(binding.agentId) === binding && hostAllowed(binding.hostId, subject) && (owner(subject) || binding.creatorSubject === subject),
    requireOwner(subject) { if (!owner(subject)) throw new SharingError(403, 'owner_required', 'Only the Host owner can manage this Host.'); },
    requireAccess(hostId, subject) {
      if (!state.hosts.has(hostId)) throw new SharingError(404, 'host_not_found', 'Host is unavailable.');
      if (!hostAllowed(hostId, subject)) throw new SharingError(403, 'host_forbidden', 'Host access is unavailable.');
    },
    requireHost(id) {
      const host = state.hosts.get(id);
      if (!host) throw new BrokerError(404, 'host_not_found', 'The Remote Host is unknown.');
      state.assertAvailable();
      if (!host.ready || host.socket?.readyState !== RELAY_SOCKET_OPEN) throw new BrokerError(503, 'host_offline', 'The Remote Host is offline.', true);
      return host;
    },
  };
}
