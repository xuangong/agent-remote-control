import { TeamBroker } from './teams.js';
import { isChainAction, isTeamCreate, isTeamAction } from '@orchardworks/agent-remote-protocol';
import { SharingError } from './host-sharing.js';
import { readBody, principal, type RouteGroup } from './request-input.js';
import { json } from './http-replies.js';
import { BrokerError, type Host } from './broker-types.js';
import { type Access } from './access.js';
import { type BrokerState } from './broker-state.js';

/**
 * Team, chain and audit routes of the account.
 *
 * Contract: `createTeamRoutes` returns one function that is given each request after the Relay's common checks (available, permitted,
 * mutation allowed) and the caller's subject. It answers a `Response` when the path is one of its routes and `undefined` when it is not,
 * so the next group is tried. A failure is thrown as `BrokerError` or `SharingError` and the Relay turns it into the HTTP answer.
 * - Every read and change goes through the Team broker; a route only authorizes (owner or a subject with access to the Host) and translates the broker's errors to HTTP statuses.
 *
 * Ports: access, brokerState, teams. It keeps no state of its own beyond what is said above.
 */
export interface TeamRoutesPorts {
  access: Access;
  brokerState: BrokerState;
  teams: TeamBroker;
}

export function createTeamRoutes(ports: TeamRoutesPorts): RouteGroup {
  const { access, brokerState, teams } = ports;
  const { hostAllowed, requireOwner, requireAccess } = access;
  return async (request, context, url, subject) => {
    if (url.pathname === '/v1/remote/teams' || url.pathname === '/v1/remote/teams/create' || url.pathname === '/v1/remote/teams/action') {
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
          const result = input.bot ? await teams.startBot(input) : await teams.create(input);
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
    return undefined;
  };
}
