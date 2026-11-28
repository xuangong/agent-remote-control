/**
 * Teams on the Relay: the `TeamBroker` wired to the Relay's saved state, with the account's chains beside it.
 *
 * Contract. `teams` changes only through `TeamBroker`'s `change`, which commits one draft of `BrokerState`: only the Teams a change touches
 * are copied, measured and validated; a Team over its bound first loses its oldest settled receipts; a change may shrink a Team or the
 * Relay's saved state but never grow either past its bound (`Team storage capacity reached.`), and an unchanged result commits nothing.
 * `resolveRole` names the session that holds a role on a Host now, across handoffs; it throws when the Host is not known. A Host that does
 * not announce Teams or tasks is refused with a 409 that says to update the Controller.
 */
import { validChains } from './broker-state.js';
import type { BotChain, ChainThresholds } from '@orchardworks/agent-remote-protocol';
import { defaultBrokerScheduler } from './transport.js';
import { isDeepStrictEqual } from 'node:util';
import { resolveRoleSuccession, type NativeSessionRef } from '@orchardworks/agent-remote-protocol';
import type { BrokerState } from './broker-state.js';
import { BrokerError, type Host, type HostBrokerOptions } from './broker-types.js';
import { committed, detached } from './drafts.js';
import { TEAM_RECORD_BYTES, teamBytes, teamStateBytes, trimTeamDeliveryReceipts, validSavedTeam, type SavedTeam } from './team-delivery.js';
import { createHostPlaces } from './host-places.js';
import { TeamBroker, teamMessageBudgetBytes } from './teams.js';
import type { HostSession } from './host-session.js';
import type { Succession } from './succession-service.js';

export interface TeamServicePorts {
  brokerState: BrokerState;
  options: Pick<HostBrokerOptions, 'attachments' | 'stateRoom' | 'assistantGroups' | 'placeBot' | 'setMission' | 'setMemory' | 'setChief' | 'setPrimary' | 'scheduler' | 'alertChain'>;
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
  const chains = {
    read: () => brokerState.chains ?? [],
    change: <T>(update: (chains: BotChain[]) => T) => brokerState.commit(draft => {
      const next = structuredClone(brokerState.chains ?? []), value = structuredClone(update(next));
      if (!validChains(next)) throw new Error('Invalid chains.');
      draft.chains = next; return { value, publish() { brokerState.chains = next; } };
    }),
    thresholds: () => brokerState.chainThresholds ?? {},
    setThresholds: (thresholds: ChainThresholds) => brokerState.commit(draft => {
      const next = structuredClone(thresholds);
      draft.chainThresholds = next; return { value: undefined, publish() { brokerState.chainThresholds = next; } };
    }),
  };
  const teams = new TeamBroker({ chains, ...(options.alertChain ? { alertChain: options.alertChain } : {}),
    resolveSession: resolveRole,
    places: createHostPlaces({ hosts: () => [...brokerState.hosts.values()], rpc: (host, method, path, sessionId, body) => ports.rpc(host, method, path, sessionId, body) }),
    scheduler: options.scheduler ?? defaultBrokerScheduler,
    assertRecipient: target => ports.assertAssociationOpen(target),
    assertRecipientSupport(hostId, generic) {
      const host = ports.requireHost(hostId);
      if (generic && host.teamSuccession !== 1) throw new BrokerError(409, 'team_succession_upgrade_required', 'Update the Controller to hand off Team members.');
    },
    ...(options.attachments ? { attachments: options.attachments } : {}),
    now, read: () => brokerState.teams,
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
    tasks: {
      capable: hostId => brokerState.hosts.get(hostId)?.tasks === 1,
      assertHost(hostId) { if (ports.requireHost(hostId).tasks !== 1) throw new BrokerError(409, 'tasks_upgrade_required', 'Update the Controller to use tasks.'); },
    },
    // Hosts that run tasks also bind assistants' main sessions to links.
    ...(options.assistantGroups ? { assistants: { groups: options.assistantGroups, capable: (hostId: string) => brokerState.hosts.get(hostId)?.tasks === 1, ...(options.placeBot ? { placeBot: options.placeBot } : {}), ...(options.setMission ? { setMission: options.setMission } : {}), ...(options.setMemory ? { setMemory: options.setMemory } : {}), ...(options.setChief ? { setChief: options.setChief } : {}), ...(options.setPrimary ? { setPrimary: options.setPrimary } : {}) } } : {}),
  });
  return { teams, resolveRole };
}
