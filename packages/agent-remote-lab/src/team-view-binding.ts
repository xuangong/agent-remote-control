import type { Team } from '@orchardworks/agent-remote-protocol';
import type { CompositionDocument } from './session-composition.js';
import { sessionKey, type SessionEntry } from './session-tree.js';

/** Local member identity selects public roster evidence; it never grants native authority. */
export function teamViewTarget(document: CompositionDocument, teams: readonly Team[] | undefined, source: SessionEntry, viewId?: string): SessionEntry | undefined {
  if (source.parentNativeSessionId) return;
  const slot = viewId ? document.slots.find(slot => slot.id === viewId) : undefined;
  if (slot?.intent.kind === 'history') return;
  const window = document.windows?.find(window => window.slotId === viewId && window.managed);
  const root = window?.closeWith ? document.windows?.find(root => root.id === window.closeWith) : window;
  const teamId = source.teamId ?? slot?.metadata?.teamId ?? root?.groupId;
  if (!teamId) return;
  const team = teams?.find(team => team.id === teamId);
  if (!team) throw new Error('This Team is unavailable. Reopen it from the Team list when its roster is ready.');
  const memberId = source.teamMemberId ?? slot?.metadata?.teamMemberId ?? window?.teamMemberId;
  const matches = memberId ? team.members.filter(member => member.id === memberId) : team.members.filter(member => member.nativeSessionId
    && sessionKey({ hostId: member.hostId, providerId: member.providerId, nativeSessionId: member.nativeSessionId }) === sessionKey(source));
  if (matches.length !== 1) throw new Error('The saved Team member identity is unavailable. Reopen this member from the Team list.');
  const member = matches[0]!;
  // A released supporter takes no Team messages; its session stays open as an ordinary session.
  if (member.creation === 'released') return;
  if (member.creation !== 'ready') throw new Error(member.error ?? 'This Team member session is not ready. Check creation in the Team list.');
  if (!member.nativeSessionId) throw new Error('This Team member has no current execution locator. Its history and draft are preserved.');
  return { ...source, teamId, teamMemberId: member.id, hostId: member.hostId, providerId: member.providerId, nativeSessionId: member.nativeSessionId, title: member.name };
}
