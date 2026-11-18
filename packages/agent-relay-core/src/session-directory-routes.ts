import { SharingError } from './host-sharing.js';
import { required, readBody, principal, type RouteGroup } from './request-input.js';
import { json, rawJson } from './http-replies.js';
import { BrokerError, type Host } from './broker-types.js';
import { type Access } from './access.js';
import { type BrokerState } from './broker-state.js';
import { type HostSession } from './host-session.js';
import { type SessionBindings } from './session-bindings.js';

/**
 * A Host's session directory: the catalog, workspaces, models, attach and create, references, calls and rename.
 *
 * Contract: `createSessionDirectoryRoutes` returns one function that is given each request after the Relay's common checks (available, permitted,
 * mutation allowed) and the caller's subject. It answers a `Response` when the path is one of its routes and `undefined` when it is not,
 * so the next group is tried. A failure is thrown as `BrokerError` or `SharingError` and the Relay turns it into the HTTP answer.
 * - A subject reaches the directory of a Host it may access; on a shared Host it sees only the sessions it created. Attach and create go through the session bindings; the rest is forwarded to the Controller and returned.
 *
 * Ports: access, brokerState, rpc, waitForCreation, userMutation, sharedCatalog. It keeps no state of its own beyond what is said above.
 */
export interface SessionDirectoryRoutesPorts {
  access: Access;
  brokerState: BrokerState;
  rpc: HostSession['rpc'];
  waitForCreation: SessionBindings['waitForCreation'];
  userMutation: SessionBindings['userMutation'];
  sharedCatalog: SessionBindings['sharedCatalog'];
}

export function createSessionDirectoryRoutes(ports: SessionDirectoryRoutesPorts): RouteGroup {
  const { access, brokerState, rpc, waitForCreation, userMutation, sharedCatalog } = ports;
  const { owner, sessionAllowed, requireOwner, requireAccess, requireHost } = access;
  return async (request, context, url, subject) => {
    const refs = /^\/v1\/remote\/hosts\/([^/]+)\/session\/refs$/.exec(url.pathname);
    if (refs && (request.method === 'GET' || request.method === 'POST')) {
      requireAccess(refs[1]!, subject);
      const host = requireHost(refs[1]!);
      const input = request.method === 'POST' ? await readBody(request) : { providerId: url.searchParams.get('providerId'), nativeSessionId: url.searchParams.get('nativeSessionId') };
      const providerId = required(input.providerId, 'providerId'), nativeSessionId = required(input.nativeSessionId, 'nativeSessionId');
      // References name other sessions, so a page may change them only where it may open both sessions.
      const allowed = (provider: string, session: string) => {
        const binding = brokerState.nativeBindings.get(JSON.stringify([host.id, provider, session]));
        return owner(subject) || !!binding && sessionAllowed(binding, subject);
      };
      if (!allowed(providerId, nativeSessionId)) throw new SharingError(403, 'session_forbidden', 'Session access is unavailable.');
      // Older Controllers refuse the route and close their uplink, so only Controllers that declare references are asked.
      if (!host.providers.some(provider => provider.providerId === providerId && provider.sessionReferences)) throw new BrokerError(400, 'unsupported_configuration', 'Session references are unavailable. Update the Controller.');
      if (request.method === 'GET') return rawJson(await rpc(host, 'GET', `/remote/session/refs?${new URLSearchParams({ providerId, nativeSessionId })}`));
      const target = input.target as { providerId?: unknown; nativeSessionId?: unknown } | undefined;
      if ((input.action !== 'add' && input.action !== 'remove') || typeof target?.providerId !== 'string' || typeof target.nativeSessionId !== 'string'
        || Object.keys(input).some(key => !['providerId', 'nativeSessionId', 'action', 'target'].includes(key))) throw new BrokerError(400, 'invalid_request', 'Name the reference to add or remove.');
      if (input.action === 'add' && !allowed(target.providerId, target.nativeSessionId)) throw new SharingError(403, 'session_forbidden', 'Session access is unavailable.');
      return rawJson(await rpc(host, 'POST', '/remote/session/refs', undefined, JSON.stringify({ providerId, nativeSessionId, action: input.action,
        target: { providerId: target.providerId, nativeSessionId: target.nativeSessionId } })));
    }
    const call = /^\/v1\/remote\/hosts\/([^/]+)\/session\/call$/.exec(url.pathname);
    if (call && request.method === 'POST') {
      // Session commands reach every session of a Host, so only its owner sends them.
      if (!owner(subject)) throw new SharingError(403, 'session_forbidden', 'Session commands are available to the Host owner.');
      requireAccess(call[1]!, subject);
      const host = requireHost(call[1]!);
      if (!host.providers.some(provider => provider.sessionCommands)) throw new BrokerError(400, 'unsupported_configuration', 'Session commands are unavailable. Update the Controller.');
      const input = await readBody(request);
      const command = input.request as Record<string, unknown> | undefined;
      if (!command || typeof command !== 'object' || Array.isArray(command) || Object.keys(input).some(key => key !== 'request')) throw new BrokerError(400, 'invalid_request', 'A session command is required.');
      // Permission settings need a recent sign-in in the website; the same holds for commands.
      const settings = command.command === 'set' && command.settings && typeof command.settings === 'object' ? Object.keys(command.settings) : [];      if (settings.some(settingId => context.authorizeMessage?.(JSON.stringify({ type: 'set_session_setting', payload: { settingId } })) === false)) {
        throw new BrokerError(403, 'reauthentication_required', 'Sign in again in the website before changing permission settings.');
      }
      return rawJson(await rpc(host, 'POST', '/remote/session/call', undefined, JSON.stringify({ request: command })));
    }
    const rename = /^\/v1\/remote\/hosts\/([^/]+)\/session\/rename$/.exec(url.pathname);
    if (rename && request.method === 'POST') {
      requireAccess(rename[1]!, subject);
      const host = requireHost(rename[1]!);
      const input = await readBody(request);
      const providerId = required(input.providerId, 'providerId'), nativeSessionId = required(input.nativeSessionId, 'nativeSessionId');
      const binding = brokerState.nativeBindings.get(JSON.stringify([host.id, providerId, nativeSessionId]));
      if (!owner(subject) && (!binding || !sessionAllowed(binding, subject))) throw new SharingError(403, 'session_forbidden', 'Session access is unavailable.');
      if (!host.providers.some(provider => provider.providerId === providerId && provider.sessionRename)) throw new BrokerError(400, 'unsupported_configuration', 'Native session renaming is unavailable. Update the Controller.');
      const title = required(input.title, 'title').trim();
      if (!title || title.length > 512 || /[\u0000-\u001f\u007f]/.test(title) || Object.keys(input).some(key => !['providerId', 'nativeSessionId', 'title', 'operationId'].includes(key))) throw new BrokerError(400, 'invalid_request', 'Enter a session name of up to 512 characters.');
      const result = await rpc(host, 'POST', '/remote/session/rename', undefined, JSON.stringify({ providerId, nativeSessionId, title, operationId: required(input.operationId, 'operationId') }));
      requireAccess(host.id, subject);
      if (!owner(subject) && (!binding || !sessionAllowed(binding, subject))) throw new SharingError(403, 'session_forbidden', 'Session access is unavailable.');
      return rawJson(result);
    }
    const listing = /^\/v1\/remote\/hosts\/([^/]+)\/catalog\/listing$/.exec(url.pathname);
    if (listing) {
      requireOwner(subject); requireAccess(listing[1]!, subject);
      const host = requireHost(listing[1]!);
      if (request.method !== 'GET' && request.method !== 'POST') throw new BrokerError(405, 'method_not_allowed', 'Use GET or POST.');
      const input = request.method === 'POST' ? await readBody(request) : undefined;
      const providerId = required(input?.providerId ?? url.searchParams.get('providerId'), 'providerId');
      if (host.legacyDsh || !host.providers.some(provider => provider.providerId === providerId)) throw new BrokerError(400, 'invalid_provider', 'The selected provider is unavailable on this Host.');
      if (input && Object.keys(input).some(key => key !== 'providerId')) throw new BrokerError(400, 'invalid_request', 'Only providerId is accepted.');
      const result = await rpc(host, request.method, `/remote/catalog/listing${input ? '' : '?' + new URLSearchParams({ providerId })}`, undefined, input ? JSON.stringify({ providerId }) : undefined);
      requireOwner(principal(context)); requireAccess(host.id, principal(context));
      return rawJson(result);
    }
    const directory = /^\/v1\/remote\/hosts\/([^/]+)\/(catalog(?:\/revision)?|workspaces|workspace-folders(?:\/create)?|models|child\/attach|attach|create)$/.exec(url.pathname);
    if (directory) {
      requireAccess(directory[1]!, subject);
      const action = directory[2]!;
      if (action.startsWith('workspace-folders')) requireOwner(subject);
      const host = requireHost(directory[1]!);
      if (action === 'models' && request.method === 'GET' && host.legacyDsh) return json(200, { models: [] });
      if (['catalog', 'catalog/revision', 'workspaces', 'workspace-folders', 'models'].includes(action) && request.method === 'GET') {
        const query = new URLSearchParams(url.search);
        const providerId = query.get('providerId');
        if (!host.legacyDsh && (!providerId || !host.providers.some((provider) => provider.providerId === providerId))) throw new BrokerError(400, 'invalid_provider', 'The selected provider is unavailable on this Host.');
        if (host.legacyDsh) query.delete('providerId');
        if (!owner(subject) && action.startsWith('catalog')) {
          return rawJson(await sharedCatalog(host, action, query, subject!));
        }
        const result = await rpc(host, 'GET', `/remote/${action}${query.size ? '?' + query : ''}`);
        requireAccess(host.id, subject);
        return rawJson(result);
      }
      if (action === 'workspace-folders/create' && request.method === 'POST') {
        const payload = await readBody(request);
        const providerId = required(payload.providerId, 'providerId');
        if (host.legacyDsh || !host.providers.some(provider => provider.providerId === providerId)) throw new BrokerError(400, 'invalid_provider', 'The selected provider is unavailable on this Host.');
        const result = await rpc(host, 'POST', '/remote/workspace-folders/create', undefined, JSON.stringify({
          providerId, parentPath: required(payload.parentPath, 'parentPath'), name: required(payload.name, 'name'),
        }));
        requireAccess(host.id, subject); requireOwner(subject);
        return rawJson(result);
      }
      if (['attach', 'child/attach', 'create'].includes(action) && request.method === 'POST') {
        const operation = userMutation(host, action, await readBody(request), subject);
        const binding = await (action === 'create' ? waitForCreation(operation) : operation);
        if (!sessionAllowed(binding, subject)) throw new SharingError(403, 'session_forbidden', 'Session access is unavailable.');
        return json(200, { agentId: binding.agentId, nativeSessionId: binding.nativeSessionId }); }
    }
    return undefined;
  };
}
