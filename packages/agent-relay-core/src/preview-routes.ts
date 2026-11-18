import { SharingError } from './host-sharing.js';
import { createHostPreviews } from './host-previews.js';
import { required, readBody, type RouteGroup } from './request-input.js';
import { json } from './http-replies.js';
import { BrokerError, type Host } from './broker-types.js';
import { type Access } from './access.js';
import { type BrokerState } from './broker-state.js';
import { type HostSession } from './host-session.js';

/**
 * Preview routes: registering, renewing and removing the previews of a Host's session, and reading what a session's page may open.
 *
 * Contract: `createPreviewRoutes` returns one function that is given each request after the Relay's common checks (available, permitted,
 * mutation allowed) and the caller's subject. It answers a `Response` when the path is one of its routes and `undefined` when it is not,
 * so the next group is tried. A failure is thrown as `BrokerError` or `SharingError` and the Relay turns it into the HTTP answer.
 * - The registry in `previews` owns the records; these routes authorize, translate and forward the Controller calls (register, renew, unregister).
 *
 * Ports: access, brokerState, now, rpc, previews. It keeps no state of its own beyond what is said above.
 */
export interface PreviewRoutesPorts {
  access: Access;
  brokerState: BrokerState;
  now: () => number;
  rpc: HostSession['rpc'];
  previews: ReturnType<typeof createHostPreviews>;
}

export function createPreviewRoutes(ports: PreviewRoutesPorts): RouteGroup {
  const { access, brokerState, now, rpc, previews } = ports;
  const { sessionAllowed, requireOwner, requireAccess, requireHost } = access;
  return async (request, context, url, subject) => {
    const previewSession = /^\/v1\/sessions\/([^/]+)\/previews$/.exec(url.pathname);
    if (previewSession && request.method === 'POST') {
      requireOwner(subject);
      const binding = brokerState.bindings.get(previewSession[1]!);
      if (!binding || !sessionAllowed(binding, subject)) throw new BrokerError(404, 'session_unavailable', 'Session is unavailable.');
      const body = await readBody(request);
      const target = required(body.target, 'target'); const itemId = required(body.itemId, 'itemId');
      if (body.pathMode !== undefined && body.pathMode !== 'strip' && body.pathMode !== 'preserve') throw new BrokerError(400, 'invalid_path_mode', 'Choose strip or preserve path mode.');
      const result = await rpc(requireHost(binding.hostId), 'POST', '/remote/previews', undefined,
        JSON.stringify({ target, source: { sessionId: binding.agentId, itemId }, pathMode: body.pathMode ?? 'strip' }));
      return new Response(result.body, { status: result.status, headers: { 'content-type': 'application/json' } });
    }
    const previewHost = /^\/v1\/remote\/hosts\/([^/]+)\/previews(?:\/([A-Za-z0-9_-]+)\/(unregister|renew))?$/.exec(url.pathname);
    if (previewHost) {
      requireOwner(subject); requireAccess(previewHost[1]!, subject);
      if (!previewHost[2] && request.method === 'GET') {
        const snapshot = previews.list(previewHost[1]!);
        return json(200, { ...snapshot, registrations: snapshot.registrations.filter(value => value.status === 'active') });
      }
      if (previewHost[2] && request.method === 'POST') {
        await readBody(request);
        if (previewHost[3] === 'renew') {
          const registration = previews.list(previewHost[1]!).registrations.find(value => value.id === previewHost[2]);
          if (!registration || registration.status === 'unregistered' || registration.pendingUnregister) return json(409, { error: 'Preview is unavailable or has been unregistered.' });
          const nameId = previews.nameId(previewHost[1]!, previewHost[2]);
          if (previews.list(previewHost[1]!).registrations.some(value => value.id !== registration.id && value.status === 'active'
            && value.expiresAt > now() && !value.pendingUnregister && previews.nameId(previewHost[1]!, value.id) === nameId))
            return json(409, { error: 'A newer registration uses this tunnel name. Open the current preview.' });
          const result = await rpc(requireHost(previewHost[1]!), 'POST', '/remote/previews/renew', undefined, JSON.stringify({ id: previewHost[2] }));
          return new Response(result.body, { status: result.status, headers: { 'content-type': 'application/json' } });
        }
        await previews.unregister(previewHost[1]!, previewHost[2]);
        return json(200, { registration: previews.list(previewHost[1]!).registrations.find(value => value.id === previewHost[2]) });
      }
      return json(405, { error: 'Method is not allowed.' });
    }
    return undefined;
  };
}
