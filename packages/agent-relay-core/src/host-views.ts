import { SESSION_STATE_LIMIT, type HostSessionState, type RemoteHostUplinkMessage } from '@orchardworks/agent-remote-protocol';
import { type Access } from './access.js';
import { type BrokerState } from './broker-state.js';
import { type HostStates, type VisibleHostStates } from './broker-types.js';
import { RELAY_SOCKET_OPEN } from './transport.js';

/**
 * What the Relay shows of its Hosts: the Hosts a subject may see and the session states they last reported.
 *
 * Contract: pure reads of `BrokerState` filtered by `Access`. A subject sees its own Hosts and the Hosts shared with it; on a shared
 * Host it sees only the sessions it created, and its own `sessionQuota`. A Host is `online` only while it is registered and its
 * socket is open. `receiveSessionStates` merges one report into a Host's states: a full report replaces them and confirms them,
 * a partial one adds, updates and removes, at most `SESSION_STATE_LIMIT` states are kept, and `changedAt` moves only when a state's
 * value or time changed. Ports: `BrokerState`, `Access`, the clock.
 */
export type HostViews = ReturnType<typeof createHostViews>;

export function createHostViews({ brokerState, access, accountBacked, ownerSubject, now }: { brokerState: BrokerState; access: Access; accountBacked: boolean; ownerSubject: string | undefined; now(): number }) {
  const { owner, hostAllowed } = access;
  function receiveSessionStates(target: HostStates, report: Extract<RemoteHostUplinkMessage, { type: 'session_states' }>) {
    const at = now(), stateKey = (state: { providerId: string; nativeSessionId: string }) => JSON.stringify([state.providerId, state.nativeSessionId]);
    const next = report.full ? new Map<string, HostSessionState & { changedAt: number }>() : target.states;
    for (const removed of report.removed ?? []) next.delete(stateKey(removed));
    for (const state of report.states) {
      const id = stateKey(state), previous = target.states.get(id);
      if (!next.has(id) && next.size >= SESSION_STATE_LIMIT) continue;
      const unchanged = previous && previous.state === state.state && previous.updatedAt === state.updatedAt;
      next.set(id, { ...state, changedAt: unchanged ? previous.changedAt : at });
    }
    target.states = next;
    if (report.full) target.confirmedAt = at;
  }
  /** Session states a subject may see: every session on its own Hosts, and on shared Hosts only the sessions it created. */
  function sessionStates(subject: string): VisibleHostStates[] {
    return [...brokerState.hosts.values()].filter(host => hostAllowed(host.id, subject)).map(host => {
      const created = owner(subject) ? undefined : new Set([...brokerState.bindings.values()].filter(binding => binding.hostId === host.id && binding.creatorSubject === subject)
        .map(binding => JSON.stringify([binding.providerId, binding.nativeSessionId])));
      const states = [...host.sessionStates?.states.values() ?? []].filter(state => !created || created.has(JSON.stringify([state.providerId, state.nativeSessionId])));
      return { hostId: host.id, online: host.ready === true && host.socket?.readyState === RELAY_SOCKET_OPEN,
        ...(host.sessionStates?.confirmedAt === undefined ? {} : { confirmedAt: host.sessionStates.confirmedAt }), states };
    });
  }
  function visibleHosts(subject?: string) {
    return [...brokerState.hosts.values()].filter(host => hostAllowed(host.id, subject)).map(({ id, name, providers: named, legacyDsh, socket, ready, credentialRotation, environment, controller, providerManagement, tpmManagement, teamManagement, hostStatus, outbox, control, tasks, coordinatorProviders }) => {
    // A provider whose assistants can be coordinators: the Host runs tasks and gives that provider's sessions the task tools.
    const providers = named.map(provider => tasks === 1 && coordinatorProviders?.includes(provider.providerId) ? { ...provider, coordinator: true as const } : provider);
    return {
      ...(outbox ? { outbox } : {}),
      ...(control ? { sessionControl: true as const } : {}),
      ...(teamManagement ? { teamManagement } : {}),
      ...(tpmManagement ? { tpmManagement } : {}),
      ...(hostStatus ? { hostStatus } : {}),
      ...(providerManagement ? { providerManagement } : {}),
      ...(controller ? { controller } : {}),
      ...(environment ? { environment } : {}),
      ...(credentialRotation ? {credentialRotation:true} : {}), id, name, online: ready === true && socket?.readyState === RELAY_SOCKET_OPEN, providers,
      ...(accountBacked && owner(subject) ? { managed: true } : {}),
      ...(ownerSubject ? { access: owner(subject) ? 'owner' as const : 'shared' as const } : {}),
      ...(!owner(subject) && subject ? { sessionQuota: brokerState.sharing.quota(id, subject) } : {}),
      ...(legacyDsh ? { providerId: 'dsh' } : providers.length === 1 ? { providerId: providers[0]!.providerId } : {}),
    };
    });
  }
  return { receiveSessionStates, sessionStates, visibleHosts };
}
