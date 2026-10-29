import type { CallForSupportProfileInput, TeamHostCall, TeamSeat } from '@orchardworks/agent-remote-protocol';
import { TeamBroker, type TeamBrokerPorts } from '../teams.js';
import { validSavedTeam, type SavedTeam } from '../team-delivery.js';
import { emptyCallForSupportState, executeProfileCommand, setEnablement, type CallForSupportState } from '../call-for-support-profiles.js';

export const review: CallForSupportProfileInput = { name: 'Cross review', description: 'Independent reviewers.', coordinator: { model: 'gpt-5.5', reasoningEffort: 'high' }, enableByDefault: false,
  mandate: { supporters: [{ providerId: 'claude', model: 'opus' }], maxSupporters: 2, workspaces: ['shared'], remoteHosts: [], approval: 'every_roster' } };

export function supportFixture(options: { capable?: string[]; readOnly?: boolean } = {}) {
  let teams: SavedTeam[] = [], now = 100;
  const state: CallForSupportState = emptyCallForSupportState();
  const seats: TeamSeat[] = [];
  const resolve = (hostId: string, providerId: string, nativeSessionId: string) => ({ controllerId: hostId, providerId, nativeSessionId });
  const ports: TeamBrokerPorts = {
    resolveSession: resolve, read: () => teams, now: () => ++now, assertHost: () => {},
    change: async update => { const draft = structuredClone(teams), value = structuredClone(update(draft)); if (!draft.every(validSavedTeam)) throw new Error('Invalid Team state.'); teams = draft; return value; },
    createSeat: async (_hostId, seat) => {
      seats.push(structuredClone(seat));
      const member = seat.member;
      return member.role === 'requester' ? { ...member, cwd: '/repo', creation: 'ready', activity: 'idle' } : { ...member, nativeSessionId: `native-${member.id}`, creation: 'ready', activity: 'idle' };
    },
    callForSupport: {
      state: () => state,
      assertHost: hostId => { if (!(options.capable ?? ['mac', 'linux']).includes(hostId)) throw new Error('Update the Controller to use Call For Support.'); },
      readOnly: () => options.readOnly ?? true,
    },
  };
  const broker = new TeamBroker(ports);
  const profile = (input: CallForSupportProfileInput = review) => executeProfileCommand(state, { type: 'create', profile: input }, 1)!;
  const enable = (nativeSessionId: string, profileIds: string[], hostId = 'mac') => setEnablement(state, resolve, { hostId, providerId: 'codex', nativeSessionId }, profileIds, ++now);
  const worker = (nativeSessionId = 'worker') => ({ providerId: 'codex', nativeSessionId, title: 'Implement login' });
  const call = (input: Partial<Extract<TeamHostCall, { action: 'call_for_support' }>> & { operationId: string }, hostId = 'mac') =>
    broker.hostCall(hostId, { action: 'call_for_support', worker: worker(), task: 'Review the change.', deliverable: 'findings', context: { commit: 'abcdef1' }, ...input } as TeamHostCall) as Promise<any>;
  return { broker, ports, state, seats, profile, enable, call, worker, teams: () => teams, team: (id: string) => teams.find(team => team.id === id)! };
}
