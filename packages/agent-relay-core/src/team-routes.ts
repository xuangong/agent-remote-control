import { TeamBroker } from './teams.js';
import { CallForSupportProfileError, executeProfileCommand, isCallForSupportProfileCommand, projectEnablement, setEnablement, type CallForSupportState } from './call-for-support-profiles.js';
import { isChainAction, isTeamCreate, isTeamAction, isTeamDelete, type NativeSessionRef } from '@orchardworks/agent-remote-protocol';
import { SharingError } from './host-sharing.js';
import { readBody, principal, type RouteGroup } from './request-input.js';
import { json } from './http-replies.js';
import { BrokerError, type Host } from './broker-types.js';
import { type Access } from './access.js';
import { type BrokerState } from './broker-state.js';

/**
 * Team and Call For Support routes of the account.
 *
 * Contract: `createTeamRoutes` returns one function that is given each request after the Relay's common checks (available, permitted,
 * mutation allowed) and the caller's subject. It answers a `Response` when the path is one of its routes and `undefined` when it is not,
 * so the next group is tried. A failure is thrown as `BrokerError` or `SharingError` and the Relay turns it into the HTTP answer.
 * - Every read and change goes through the Team broker or the saved Call For Support state; a route only authorizes (owner or a subject with access to the Host) and translates the broker's errors to HTTP statuses.
 *
 * Ports: access, brokerState, now, teams, callForSupportChange, resolveRole. It keeps no state of its own beyond what is said above.
 */
export interface TeamRoutesPorts {
  access: Access;
  brokerState: BrokerState;
  now: () => number;
  teams: TeamBroker;
  callForSupportChange: <T>(update: (state: CallForSupportState) => T) => Promise<T>;
  resolveRole: (hostId: string, providerId: string, anchorNativeId: string) => NativeSessionRef;
}

export function createTeamRoutes(ports: TeamRoutesPorts): RouteGroup {
  const { access, brokerState, now, teams, callForSupportChange, resolveRole } = ports;
  const { hostAllowed, requireOwner, requireAccess } = access;
  return async (request, context, url, subject) => {
    if (url.pathname === '/v1/remote/teams' || url.pathname === '/v1/remote/teams/create' || url.pathname === '/v1/remote/teams/action' || url.pathname === '/v1/remote/teams/delete') {
      requireOwner(subject);
      const recipientAware = request.headers.get('x-arc-team-recipients') === '1';
      if (url.pathname === '/v1/remote/teams' && request.method === 'GET') {
        try { return json(200, { teams: brokerState.teams.filter(team => hostAllowed(team.source.hostId, subject)).map(team => teams.readForClient(team.id, recipientAware)) }); }
        catch (error) { return json(409, { error: error instanceof Error ? error.message : 'Team request failed.' }); }
      }
      if (request.method !== 'POST') return json(405, { error: 'Method is not allowed.' });
      const input = await readBody(request); requireOwner(principal(context));
      try {
        if (url.pathname.endsWith('/create') && isTeamCreate(input)) {
          requireAccess(input.source.hostId, principal(context));
          const result = await teams.create(input);
          requireOwner(principal(context)); requireAccess(input.source.hostId, principal(context));
          return json(200, teams.readForClient(result.id, recipientAware));
        }
        if (url.pathname.endsWith('/action') && isTeamAction(input)) {
          const team = brokerState.teams.find(team => team.id === input.teamId);
          if (!team) return json(404, { error: 'Team not found.' });
          requireAccess(team.source.hostId, principal(context));
          if (input.action === 'add_member') requireAccess(input.hostId, principal(context));
          const result = await teams.action(input);
          requireOwner(principal(context)); requireAccess(team.source.hostId, principal(context));
          if (input.action === 'add_member') requireAccess(input.hostId, principal(context));
          return json(200, teams.readForClient(result.id, recipientAware));
        }
        if (url.pathname.endsWith('/delete') && isTeamDelete(input)) {
          const team = brokerState.teams.find(team => team.id === input.teamId);
          if (!team) return json(404, { error: 'Team not found.' });
          requireAccess(team.source.hostId, principal(context));
          await teams.delete(input.teamId);
          return json(200, { teamId: input.teamId, deleted: true });
        }
        return json(400, { error: 'Invalid Team request.' });
      } catch (error) { return json(409, { error: error instanceof Error ? error.message : 'Team request failed.' }); }
    }
    // The account's chains, newest first, with the names of the bots they reached (bots design 7).
    if (url.pathname === '/v1/remote/chains') {
      requireOwner(subject);
      return request.method === 'GET' ? json(200, teams.chainView()) : json(405, { error: 'Method is not allowed.' });
    }
    if (url.pathname === '/v1/remote/chains/action') {
      requireOwner(subject);
      if (request.method !== 'POST') return json(405, { error: 'Method is not allowed.' });
      const input = await readBody(request); requireOwner(principal(context));
      if (!isChainAction(input)) return json(400, { error: 'Invalid audit request.' });
      try { return json(200, await teams.chainAction(input)); }
      catch (error) { return json(409, { error: error instanceof Error ? error.message : 'Audit request failed.' }); }
    }
    if (url.pathname === '/v1/remote/call-for-support' || url.pathname === '/v1/remote/call-for-support/profiles' || url.pathname === '/v1/remote/call-for-support/enablement') {
      requireOwner(subject);
      const resolveVisible = (hostId: string, providerId: string, nativeSessionId: string) => hostAllowed(hostId, subject) ? resolveRole(hostId, providerId, nativeSessionId) : undefined;
      const view = () => ({ profiles: structuredClone(brokerState.callForSupport?.profiles ?? []), enablement: projectEnablement(brokerState.callForSupport, resolveVisible) });
      if (url.pathname === '/v1/remote/call-for-support') return request.method === 'GET' ? json(200, view()) : json(405, { error: 'Method is not allowed.' });
      if (request.method !== 'POST') return json(405, { error: 'Method is not allowed.' });
      const input = await readBody(request); requireOwner(principal(context));
      try {
        if (url.pathname.endsWith('/profiles')) {
          if (!isCallForSupportProfileCommand(input)) return json(400, { error: 'Invalid support profile request.' });
          const profile = await callForSupportChange(state => executeProfileCommand(state, input, now()));
          requireOwner(principal(context));
          return json(200, { ...(profile ? { profile } : {}), ...view() });
        }
        const target = input as { hostId?: unknown; providerId?: unknown; nativeSessionId?: unknown; profileIds?: unknown };
        if (!target || typeof target !== 'object' || Object.keys(target).sort().join() !== 'hostId,nativeSessionId,profileIds,providerId' || typeof target.hostId !== 'string'
          || typeof target.providerId !== 'string' || typeof target.nativeSessionId !== 'string' || !Array.isArray(target.profileIds) || !target.profileIds.every(id => typeof id === 'string')) {
          return json(400, { error: 'Invalid Call For Support enablement.' });
        }
        requireAccess(target.hostId, principal(context));
        const worker = { hostId: target.hostId, providerId: target.providerId, nativeSessionId: target.nativeSessionId };
        await callForSupportChange(state => setEnablement(state, resolveRole, worker, target.profileIds as string[], now()));
        requireOwner(principal(context));
        return json(200, view());
      } catch (error) {
        if (error instanceof CallForSupportProfileError) return json(error.code === 'not_found' ? 404 : error.code === 'invalid' ? 400 : 409, { code: error.code, error: error.message });
        throw error;
      }
    }
    return undefined;
  };
}
