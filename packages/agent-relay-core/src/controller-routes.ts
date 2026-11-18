import { isHostProviderChange, controllerUpdateTarget, controllerUpgradeBridgeVersion, type ControllerRelease } from '@orchardworks/agent-remote-protocol';
import { controllerReleases } from './controller-releases.js';
import { SharingError } from './host-sharing.js';
import { readBody, principal, type RouteGroup } from './request-input.js';
import { json } from './http-replies.js';
import { BrokerError, type Host, type HostBrokerOptions } from './broker-types.js';
import { type Access } from './access.js';
import { type BrokerState } from './broker-state.js';
import { type HostSession } from './host-session.js';
import { type Succession } from './succession-service.js';

/**
 * Controller routes: the Controller's succession, its release lookup, its self-update and its provider settings.
 *
 * Contract: `createControllerRoutes` returns one function that is given each request after the Relay's common checks (available, permitted,
 * mutation allowed) and the caller's subject. It answers a `Response` when the path is one of its routes and `undefined` when it is not,
 * so the next group is tried. A failure is thrown as `BrokerError` or `SharingError` and the Relay turns it into the HTTP answer.
 * - Every route here is owner-only: it checks `requireOwner` and `requireAccess` before it asks the Host, and a Host that is offline answers 503 from `requireHost`.
 * - The release lookup caches the upgrade-bridge releases it fetched and forgets one on `refresh=1` or on failure, so a retry asks again.
 *
 * Ports: access, brokerState, rpc, successionAction, options. It keeps no state of its own beyond what is said above.
 */
export interface ControllerRoutesPorts {
  options: Pick<HostBrokerOptions, 'controllerReleases'>;
  access: Access;
  brokerState: BrokerState;
  rpc: HostSession['rpc'];
  successionAction: Succession['action'];
}

export function createControllerRoutes(ports: ControllerRoutesPorts): RouteGroup {
  const { access, brokerState, rpc, successionAction, options } = ports;
  const { requireOwner, requireAccess, requireHost } = access;
  const bridgeLookups = new Map<string, Promise<ControllerRelease>>();
  function readUpgradeBridge(version: string, refresh = false): Promise<ControllerRelease> {
    if (refresh) bridgeLookups.delete(version);
    let lookup = bridgeLookups.get(version);
    if (!lookup) {
      const releases = options.controllerReleases ?? controllerReleases;
      if (!releases.version) return Promise.reject(new Error('Upgrade component release discovery is unavailable.'));
      lookup = releases.version(version).catch(error => {
        if (bridgeLookups.get(version) === lookup) bridgeLookups.delete(version);
        throw error;
      });
      bridgeLookups.set(version, lookup);
    }
    return lookup;
  }
  return async (request, context, url, subject) => {
    const succession = /^\/v1\/remote\/hosts\/([^/]+)\/succession\/(describe|prepare|commit|cancel|status|reconcile)$/.exec(url.pathname);
    if (succession) {
      requireOwner(subject); requireAccess(succession[1]!, subject);
      if (request.method !== 'POST') return json(405, { error: 'Method is not allowed.' });
      return json(200, await successionAction(requireHost(succession[1]!), succession[2]!, await readBody(request)));
    }
    if (url.pathname === '/v1/remote/controller-release' && request.method === 'GET') {
      requireOwner(subject);
      const refresh = url.searchParams.get('refresh') === '1';
      const release = await (options.controllerReleases ?? controllerReleases).latest({ refresh });
      if (!release) return json(200, { release });
      const versions = [...new Set([...brokerState.hosts.values()].flatMap(host => {
        const version = host.controller?.remoteUpdate && controllerUpgradeBridgeVersion(release, host.controller);
        return version ? [version] : [];
      }))];
      const results = await Promise.allSettled(versions.map(version => readUpgradeBridge(version, refresh)));
      const bridges = results.flatMap(result => result.status === 'fulfilled' ? [result.value] : []);
      return json(200, { release, ...(bridges[0] ? { bridgeRelease: bridges[0] } : {}),
        ...(bridges.length > 1 ? { bridgeReleases: bridges } : {}),
        ...(results.some(result => result.status === 'rejected') ? { bridgeError: 'An upgrade component for older Controllers is unavailable. Refresh and retry after it is published.' } : {}) });
    }

    const controllerUpdate = /^\/v1\/remote\/hosts\/([^/]+)\/controller-update$/.exec(url.pathname);
    if (controllerUpdate) {
      requireOwner(subject); requireAccess(controllerUpdate[1]!, subject);
      const host = requireHost(controllerUpdate[1]!);
      if (!host.controller?.remoteUpdate) return json(409, { error: 'Install the release launcher locally before using remote updates.' });
      if (!['GET', 'POST'].includes(request.method)) return json(405, { error: 'Method is not allowed.' });
      let body: string | undefined;
      if (request.method === 'POST') {
        const input = await readBody(request);
        const release = await (options.controllerReleases ?? controllerReleases).latest();
        const bridgeVersion = release && controllerUpgradeBridgeVersion(release, host.controller);
        const bridge = bridgeVersion ? await readUpgradeBridge(bridgeVersion) : undefined;
        const target = release && controllerUpdateTarget(release, host.controller, bridge);
        if (!target || input.version !== target.version
          || typeof input.operationId !== 'string' || !/^[A-Za-z0-9_-]{8,128}$/.test(input.operationId)) return json(409, { error: 'Refresh the Controller release and Host list before confirming this update.' });
        body = JSON.stringify({ version: target.version, operationId: input.operationId });
      }
      const result = await rpc(host, request.method as 'GET' | 'POST', '/remote/controller-update', undefined, body);
      return new Response(result.body, { status: result.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    }
    const providerSettings = /^\/v1\/remote\/hosts\/([^/]+)\/provider-settings$/.exec(url.pathname);
    if (providerSettings) {
      requireOwner(subject); requireAccess(providerSettings[1]!, subject);
      if (!['GET', 'POST'].includes(request.method)) return json(405, { error: 'Method is not allowed.' });
      const host = requireHost(providerSettings[1]!);
      if (!host.providerManagement) return json(409, { error: 'Update the Controller to manage providers.' });
      let body: string | undefined;
      if (request.method === 'POST') {
        const input = await readBody(request);
        if (!isHostProviderChange(input)) return json(400, { error: 'Invalid provider preferences.' });
        body = JSON.stringify(input);
      }
      const result = await rpc(host, request.method as 'GET' | 'POST', '/remote/provider-settings', undefined, body);
      requireOwner(principal(context)); requireAccess(providerSettings[1]!, principal(context));
      return new Response(result.body, { status: result.status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
    }
    return undefined;
  };
}
