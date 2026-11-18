/**
 * Teams and Call For Support on the Relay: the `TeamBroker` wired to the Relay's saved state, and the one commit path for the Call For
 * Support record.
 *
 * Contract. `teams` changes only through `TeamBroker`'s `change`, which commits one draft of `BrokerState`: only the Teams a change touches
 * are copied, measured and validated; a Team over its bound first loses its oldest settled receipts; a change may shrink a Team or the
 * Relay's saved state but never grow either past its bound (`Team storage capacity reached.`), and an unchanged result commits nothing.
 * `callForSupportChange` commits one validated Call For Support state, or nothing when it is unchanged. `resolveRole` names the session
 * that holds a role on a Host now, across handoffs; it throws when the Host is not known. A Host that does not announce Team or Call For
 * Support support is refused with a 409 that says to update the Controller.
 */
import { isDeepStrictEqual } from 'node:util';
import { resolveRoleSuccession, type NativeSessionRef } from '@orchardworks/agent-remote-protocol';
import type { BrokerState } from './broker-state.js';
import { BrokerError, type Host, type HostBrokerOptions } from './broker-types.js';
import { emptyCallForSupportState, validCallForSupportState, type CallForSupportState } from './call-for-support-profiles.js';
import { committed, detached } from './drafts.js';
import { TEAM_RECORD_BYTES, teamBytes, teamStateBytes, trimTeamDeliveryReceipts, validSavedTeam, type SavedTeam } from './team-delivery.js';
import { TeamBroker, teamMessageBudgetBytes } from './teams.js';
import type { HostSession } from './host-session.js';
import type { Succession } from './succession-service.js';

export interface TeamServicePorts {
  brokerState: BrokerState;
  options: Pick<HostBrokerOptions, 'teamResources' | 'stateRoom'>;
  now: () => number;
  requireHost(hostId: string): Host;
  /** A Host call; read when used, because the Host session is built after the Teams. */
  rpc: HostSession['rpc'];
  assertAssociationOpen: Succession['assertOpen'];
  associationSource: Succession['source'];
  prefixRecords: Succession['prefixRecords'];
}

export function createTeamService(ports: TeamServicePorts) {
  const { brokerState, options, now } = ports;
  /** The session that holds the role of a session on a Host now, across handoffs. */
  function resolveRole(hostId: string, providerId: string, anchorNativeId: string): NativeSessionRef {
    const host = brokerState.hosts.get(hostId);
    if (!host) throw new Error('Team recipient Host is unavailable.');
    return resolveRoleSuccession(ports.associationSource(host, providerId, anchorNativeId), ports.prefixRecords(host)).target;
  }
  function callForSupportChange<T>(update: (state: CallForSupportState) => T): Promise<T> {
    return brokerState.commit(draft => {
      const next = structuredClone(brokerState.callForSupport ?? emptyCallForSupportState()), value = structuredClone(update(next));
      if (isDeepStrictEqual(next, brokerState.callForSupport ?? emptyCallForSupportState())) return { value, unchanged: true, publish() {} };
      if (!validCallForSupportState(next)) throw new Error('Invalid Call For Support state.');
      draft.callForSupport = next; return { value, publish() { brokerState.callForSupport = next; } };
    });
  }
  const teams = new TeamBroker({
    resolveSession: resolveRole,
    assertRecipient: target => ports.assertAssociationOpen(target),
    assertRecipientSupport(hostId, generic) {
      const host = ports.requireHost(hostId);
      if (host.teamRecipients !== 1) throw new BrokerError(409, 'team_recipients_upgrade_required', 'Update the Controller before replacing a Team recipient.');
      if (generic && host.teamSuccession !== 1) throw new BrokerError(409, 'team_succession_upgrade_required', 'Update the Controller to hand off Team members.');
    },
    resources: options.teamResources,
    now, read: () => brokerState.teams,
    ...(options.stateRoom ? { retention: () => options.stateRoom!().retention } : {}),
    change: update => brokerState.commit(draft => {
      // Only the Teams a change touches are copied, measured and validated; the others stay the committed objects.
      let value!: ReturnType<typeof update>;
      let next = committed.produce(brokerState.teams, teams => { value = structuredClone(detached(update(teams))); });
      const previous = new Map(brokerState.teams.map(team => [team.id, team]));
      const changed = (team: SavedTeam) => team !== previous.get(team.id);
      // A Team over its bound first loses its oldest settled receipts.
      if (next.some(team => changed(team) && teamBytes(team) > TEAM_RECORD_BYTES)) next = committed.produce(next, teams => {
        next.forEach((team, index) => { if (changed(team)) trimTeamDeliveryReceipts(teams[index]!, TEAM_RECORD_BYTES, teamBytes(team)); });
      });
      if (next === brokerState.teams || next.length === brokerState.teams.length && next.every((team, index) => team === brokerState.teams[index] || isDeepStrictEqual(team, brokerState.teams[index]))) return { value, unchanged: true, publish() {} };
      if (!next.every(team => brokerState.validTeams.has(team) || validSavedTeam(team) && teamMessageBudgetBytes(team) <= 128 * 1024 && brokerState.validTeams.add(team))) throw new Error('Team storage capacity reached.');
      // A change may not grow a Team beyond its bound, nor the Relay beyond its own; it may still shrink either.
      const grown = (team: SavedTeam) => teamBytes(team) > (previous.has(team.id) ? teamBytes(previous.get(team.id)!) : 0);
      if (next.some(team => changed(team) && teamBytes(team) > TEAM_RECORD_BYTES && grown(team))) throw new Error('Team storage capacity reached.');
      const growth = teamStateBytes(next) - teamStateBytes(brokerState.teams);
      if (growth > 0 && options.stateRoom && growth > options.stateRoom().growth) throw new Error('Team storage capacity reached.');
      draft.teams = next; return { value, publish() { brokerState.teams = next; } };
    }),
    assertHost(hostId, providerId) { const host = ports.requireHost(hostId); if (!host.teamManagement) throw new Error('Update the Controller to use Teams.'); if (!host.providers.some(provider => provider.providerId === providerId)) throw new Error('Provider is unavailable on this Host.'); },
    async createSeat(hostId, seat) {
      const result = await ports.rpc(ports.requireHost(hostId), 'POST', '/remote/team/create-seat', undefined, JSON.stringify(seat));
      const value = JSON.parse(result.body); if (result.status !== 200) throw new Error(value.error ?? 'Team session creation failed.'); return value;
    },
    callForSupport: {
      state: () => brokerState.callForSupport,
      capable: hostId => brokerState.hosts.get(hostId)?.callForSupport === 1,
      assertHost(hostId) { if (ports.requireHost(hostId).callForSupport !== 1) throw new BrokerError(409, 'call_for_support_upgrade_required', 'Update the Controller to use Call For Support.'); },
      readOnly: (hostId, providerId) => { const host = brokerState.hosts.get(hostId); return host?.callForSupport === 1 && !!host.readOnlyProviders?.includes(providerId) && host.providers.some(provider => provider.providerId === providerId); },
      async supportPatch(hostId, input) {
        const result = await ports.rpc(ports.requireHost(hostId), 'POST', '/remote/team/support-patch', undefined, JSON.stringify(input));
        const value = JSON.parse(result.body); if (result.status !== 200) throw new Error(value.error ?? 'The supporter patch failed.'); return value;
      },
      async supportBundle(hostId, input) {
        const result = await ports.rpc(ports.requireHost(hostId), 'POST', '/remote/team/support-bundle', undefined, JSON.stringify(input));
        const value = JSON.parse(result.body); if (result.status !== 200) throw new Error(value.error ?? 'The support bundle failed.'); return value;
      },
    },
  });
  return { teams, callForSupportChange, resolveRole };
}
