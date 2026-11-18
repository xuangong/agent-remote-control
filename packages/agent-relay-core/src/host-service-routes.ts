import { isHostStatus, ownerOnlyHostStatus, nativeSessionRefKey, isTpmAction, isTpmCreate, isTpmList, isTpmWork, isCodexDaemonRestart } from '@orchardworks/agent-remote-protocol';
import { SharingError } from './host-sharing.js';
import { required, readBody, principal, type RouteGroup } from './request-input.js';
import { json, rawJson } from './http-replies.js';
import { BrokerError, type Host } from './broker-types.js';
import { type Access } from './access.js';
import { type BrokerState } from './broker-state.js';
import { type HostSession } from './host-session.js';

/**
 * Routes that forward a Host service to its Controller: the TPM, Host status, the Codex daemon and the VS Code tunnel.
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
    const tpm = /^\/v1\/remote\/hosts\/([^/]+)\/tpm(?:\/(create|action|work))?$/.exec(url.pathname);
    if (tpm) {
      requireOwner(subject); requireAccess(tpm[1]!, subject);
      const host = requireHost(tpm[1]!);
      const generation = host.generation, installationId = host.installationId;
      const requireTpmLifetime = () => { brokerState.assertHostCurrent(host, generation); requireOwner(principal(context)); requireAccess(host.id, principal(context)); };
      if (!host.tpmManagement) return request.method === 'GET' && !tpm[2]
        ? json(200, { supported: false, supportedProviders: [], works: [] })
        : json(409, { error: 'Update the Controller to use TPM.' });
      const action = tpm[2];
      const method = action === 'create' || action === 'action' ? 'POST' : 'GET';
      if (request.method !== method) return json(405, { error: 'Method is not allowed.' });
      let body: string | undefined;
      let expectedId: string | undefined;
      if (action === 'work') {
        if (url.searchParams.size !== 1 || !url.searchParams.has('id')) throw new BrokerError(400, 'invalid_request', 'A TPM work ID is required.');
        expectedId = required(url.searchParams.get('id'), 'id');
        if (expectedId.length > 128) throw new BrokerError(400, 'invalid_request', 'The TPM work ID is invalid.');
      } else if (!action && url.searchParams.size) {
        const cursor = url.searchParams.get('cursor');
        if (url.searchParams.size !== 1 || !cursor || cursor.length > 128) throw new BrokerError(400, 'invalid_request', 'The TPM catalog cursor is invalid.');
      } else if (url.searchParams.size) throw new BrokerError(400, 'invalid_request', 'TPM query parameters are invalid.');
      if (method === 'POST') {
        const input = await readBody(request);
        requireTpmLifetime();
        if (action === 'create' ? !isTpmCreate(input) : !isTpmAction(input)) throw new BrokerError(400, 'invalid_request', 'The TPM request is invalid.');
        if (action === 'create' && !host.providers.some(provider => provider.providerId === input.providerId)) throw new BrokerError(400, 'invalid_provider', 'The selected provider is unavailable on this Host.');
        if (action === 'action') expectedId = input.id as string;
        body = JSON.stringify(input);
      }
      const path = `/remote/tpm${action ? '/' + action : ''}${action === 'work' ? '?' + new URLSearchParams({ id: expectedId! }) : !action && url.searchParams.has('cursor') ? '?' + new URLSearchParams({ cursor: url.searchParams.get('cursor')! }) : ''}`;
      requireTpmLifetime();
      const result = await rpc(host, method, path, undefined, body);
      requireTpmLifetime();
      if (!action && result.status === 404) return json(200, { supported: false, works: [] });
      if (result.status >= 200 && result.status < 300) {
        let value: unknown;
        try { value = JSON.parse(result.body); } catch { throw new BrokerError(502, 'invalid_host_response', 'The Host returned an invalid TPM response.'); }
        if (action ? !isTpmWork(value) || (expectedId !== undefined && value.id !== expectedId) : !isTpmList(value)) throw new BrokerError(502, 'invalid_host_response', 'The Host returned an invalid TPM response.');
        const works = isTpmWork(value) ? [value] : isTpmList(value) ? value.works : [];
        for (const work of works) {
          const main = work.mainSessionRef;
          const source = work.mainBinding?.kind === 'fixed' ? work.mainBinding.source : work.mainBinding?.origin;
          if (main && (main.controllerId !== installationId || main.nativeSessionId !== work.mainNativeSessionId)
            || source && source.controllerId !== installationId
            || main && work.mainBinding?.kind === 'fixed' && nativeSessionRefKey(main) !== nativeSessionRefKey(work.mainBinding.source)) {
            throw new BrokerError(502, 'invalid_host_response', 'The Host returned an invalid TPM reference.');
          }
        }
      }
      return rawJson(result);
    }
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
