import type { Team } from '@orchardworks/agent-remote-protocol';
import type { SessionWindowTarget } from './hooks/useSessionWindows.js';

/** Teams supply a layout preset; the workspace owns navigation and window lifetime. */
export function teamLayoutTargets(team: Team, compact: boolean): { main: SessionWindowTarget; dock: SessionWindowTarget[]; groupRoot?: SessionWindowTarget } {
  const ready = team.members.filter(member => member.creation === 'ready' && member.nativeSessionId);
  const target = (member: (typeof ready)[number]): SessionWindowTarget => ({
    teamId: team.id, teamMemberId: member.id, hostId: member.hostId, providerId: member.providerId, nativeSessionId: member.nativeSessionId!, title: member.name,
  });
  if (compact) {
    const leader = ready.find(member => member.role === 'leader');
    if (!leader) throw new Error('The Leader session has no current execution locator. Check its status in the Team list.');
    return { main: target(leader), dock: [] };
  }
  const leader = ready.find(member => member.role === 'leader');
  return { main: team.source, groupRoot: leader ? target(leader) : undefined, dock: [...ready.filter(member => member.role === 'leader'), ...ready.filter(member => member.role !== 'leader')].map(target) };
}
