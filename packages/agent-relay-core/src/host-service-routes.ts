import { isHostStatus, ownerOnlyHostStatus, isCodexDaemonRestart } from '@orchardworks/agent-remote-protocol';
import { SharingError } from './host-sharing.js';
import { readBody, principal, type RouteGroup } from './request-input.js';
import { json } from './http-replies.js';
import { BrokerError } from './broker-types.js';
import { type Access } from './access.js';
import { type BrokerState } from './broker-state.js';
import { type HostSession } from './host-session.js';

/**
 * Routes that forward a Host service to its Controller: Host status, the Codex daemon and the VS Code tunnel.
 *
 * Contract: `createHostServiceRoutes` returns one function that is given each request after the Relay's common checks (available, permitted,
 * mutation allowed) and the caller's subject. It answers a `Response` when the path is one of its routes and `undefined` when it is not,
 * so the next group is tried. A failure is thrown as `BrokerError` or `SharingError` and the Relay turns it into the HTTP answer.
 * - Owner-only. A route validates its input here, forwards it as one rpc to the Controller and returns the Controller's answer; the Relay keeps no state for them. A Controller that did not advertise the service answers 409 before any rpc.
 *
 * Ports: access, brokerState, rpc. It keeps no state of its own beyond what is said above.
 */
export interface HostServiceRoutesPorts {
  access: Access;
  brokerState: BrokerState;
  rpc: HostSession['rpc'];
}

export function createHostServiceRoutes(ports: HostServiceRoutesPorts): RouteGroup {
  const { access, brokerState, rpc } = ports;
  const { owner, requireOwner, requireAccess, requireHost } = access;
  return async (request, context, url, subject) => {
    const hostStatus = /^\/v1\/remote\/hosts\/([^/]+)\/status$/.exec(url.pathname);
    if (hostStatus) {
      requireAccess(hostStatus[1]!, subject);
      if (request.method !== 'GET') return json(405, { error: 'Method is not allowed.' });
      const target = requireHost(hostStatus[1]!);
      // A Controller that did not offer this read would treat the request as a protocol error and drop its connection.
      if (!target.hostStatus) throw new BrokerError(501, 'unsupported_command', 'Update the Controller on this Host to see its status.');
      const result = await rpc(target, 'GET', '/remote/host-status');
      requireAccess(hostStatus[1]!, principal(context));
      let value: unknown;
      try { value = JSON.parse(result.body); } catch { value = undefined; }
      if (result.status !== 200 || !isHostStatus(value)) throw new BrokerError(502, 'invalid_host_response', 'The Host returned an invalid status.');
      return new Response(JSON.stringify(ownerOnlyHostStatus(value, owner(principal(context)))), { status: 200, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    }
    const codexDaemon = /^\/v1\/remote\/hosts\/([^/]+)\/codex-daemon$/.exec(url.pathname);
    if (codexDaemon) {
      requireOwner(subject); requireAccess(codexDaemon[1]!, subject);
      if (!['GET', 'POST'].includes(request.method)) return json(405, { error: 'Method is not allowed.' });
      const host = requireHost(codexDaemon[1]!);
      if (!host.providers.some(provider => provider.providerId === 'codex' && provider.daemonControl)) {
        throw new BrokerError(400, 'unsupported_configuration', 'This Host does not support remote shared Codex daemon control.');
      }
      let body: string | undefined;
      if (request.method === 'POST') {
        const input = await readBody(request);
        if (!isCodexDaemonRestart(input)) throw new BrokerError(400, 'invalid_request', 'Refresh daemon state before confirming restart.');
        body = JSON.stringify(input);
      }
      const result = await rpc(host, request.method as 'GET' | 'POST', '/remote/codex-daemon', undefined, body);
      requireOwner(principal(context)); requireAccess(codexDaemon[1]!, principal(context));
      return new Response(result.body, { status: result.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    }
    const vscodeTunnel = /^\/v1\/remote\/hosts\/([^/]+)\/vscode-tunnel(?:\/(start|stop))?$/.exec(url.pathname);
    if (vscodeTunnel) {
      requireOwner(subject); requireAccess(vscodeTunnel[1]!, subject);
      const action = vscodeTunnel[2];
      if ((!action && request.method !== 'GET') || (action && request.method !== 'POST')) return json(405, { error: 'Method is not allowed.' });
      const body = action ? await readBody(request) : undefined;
      if (action === 'start' && body?.acceptLicense !== true) return json(400, { error: 'Accept the VS Code Server license terms before starting.' });
      const result = await rpc(requireHost(vscodeTunnel[1]!), action ? 'POST' : 'GET', `/remote/vscode-tunnel${action ? `/${action}` : ''}`, undefined,
        action ? JSON.stringify(action === 'start' ? { acceptLicense: true } : {}) : undefined);
      requireOwner(principal(context)); requireAccess(vscodeTunnel[1]!, principal(context));
      return new Response(result.body, { status: result.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    }
    return undefined;
  };
}
