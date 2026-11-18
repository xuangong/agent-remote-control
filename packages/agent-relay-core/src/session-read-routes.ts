import { SharingError } from './host-sharing.js';
import { rawJson } from './http-replies.js';
import { BrokerError, type Host } from './broker-types.js';
import { type Access } from './access.js';
import { type BrokerState } from './broker-state.js';
import { type SessionBindings } from './session-bindings.js';
import { type RouteGroup } from './request-input.js';

/**
 * Reads of a bound session (snapshot, timeline) answered by its Controller.
 *
 * Contract: `createSessionReadRoutes` returns one function that is given each request after the Relay's common checks (available, permitted,
 * mutation allowed) and the caller's subject. It answers a `Response` when the path is one of its routes and `undefined` when it is not,
 * so the next group is tried. A failure is thrown as `BrokerError` or `SharingError` and the Relay turns it into the HTTP answer.
 * - The session binding is recovered first, access is checked before and after the Host answers, and the answer keeps the public session id.
 *
 * Ports: access, brokerState, sessionBindings. It keeps no state of its own beyond what is said above.
 */
export interface SessionReadRoutesPorts {
  access: Access;
  brokerState: BrokerState;
  sessionBindings: SessionBindings;
}

export function createSessionReadRoutes(ports: SessionReadRoutesPorts): RouteGroup {
  const { access, brokerState, sessionBindings } = ports;
  const { sessionAllowed, requireHost } = access;
  return async (request, context, url, subject) => {
    const session = /^\/v1\/sessions\/([^/]+)\/(snapshot|timeline)$/.exec(url.pathname);
    const binding = session && brokerState.bindings.get(session[1]!);
    if (binding && request.method === 'GET') {
      if (!sessionAllowed(binding, subject)) throw new SharingError(403, 'session_forbidden', 'Session access is unavailable.');
      const host = requireHost(binding.hostId); await sessionBindings.recoverBinding(host, binding);
      const result = await sessionBindings.sessionRead(host, binding, url.pathname + url.search);
      if (!sessionAllowed(binding, subject)) throw new SharingError(403, 'session_forbidden', 'Session access is unavailable.');
      return rawJson(result);
    }
    return undefined;
  };
}
