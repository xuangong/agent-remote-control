import { expect, it } from 'vitest';
import type { Team } from '@orchardworks/agent-remote-protocol';
import { createCompositionDocument, createCompositionSlot, parseComposition } from './session-composition.js';
import { teamViewTarget } from './team-view-binding.js';
import { teamLayoutTargets } from './team-layout.js';
const team: Team = { id: 'team', operationId: 'create', revision: 1, title: 'Team', status: 'active', source: { hostId: 'local', providerId: 'recorded', nativeSessionId: 'main', title: 'Main' },
  members: [{ id: 'leader', hostId: 'local', providerId: 'recorded', nativeSessionId: 'A', role: 'leader', name: 'Leader', responsibility: '', creation: 'ready', activity: 'idle', summary: '', updatedAt: 1 }], messages: [], createdAt: 1, updatedAt: 1 };
it('retains explicit Team member identity through composition serialization for desktop and compact owners', () => {
  for (const compact of [false, true]) {
    const layout = teamLayoutTargets(team, compact), target = compact ? layout.main : layout.groupRoot!;
    const slot = createCompositionSlot('member-slot', target, 'scope');
    const document = createCompositionDocument('scope', [slot]);
    document.windows = [{ id: 'member-view', slotId: slot.id, managed: true, groupId: team.id, teamMemberId: 'leader' }];
    const restored = parseComposition(JSON.parse(JSON.stringify(document)), 'scope');
    expect(restored.slots[0]!.metadata).toMatchObject({ teamId: 'team', teamMemberId: 'leader' });
    expect(restored.windows![0]!.teamMemberId).toBe('leader');
    const following = { ...team, members: [{ ...team.members[0]!, nativeSessionId: 'B' }] };
    expect(teamViewTarget(restored, [following], target, slot.id)?.nativeSessionId).toBe('B');
    const unavailable = { ...following, members: [{ ...following.members[0]!, nativeSessionId: undefined }] };
    expect(() => teamViewTarget(restored, [unavailable], target, slot.id)).toThrow(/no current execution locator/);
  }
});
it('reads legacy Team windows but refuses to guess missing member identity from a retired anchor or title', () => {
  const target = { hostId: 'local', providerId: 'recorded', nativeSessionId: 'A', title: 'Leader' };
  const slot = createCompositionSlot('slot', target, 'scope'), document = createCompositionDocument('scope', [slot]);
  document.windows = [{ id: 'view', slotId: slot.id, managed: true, groupId: 'team' }];
  const restored = parseComposition(document, 'scope');
  expect(teamViewTarget(restored, [team], target, slot.id)?.teamMemberId).toBe('leader');
  const missing = { ...team, members: [{ ...team.members[0]!, nativeSessionId: undefined }] };
  expect(() => teamViewTarget(restored, [missing], target, slot.id)).toThrow(/saved Team member identity/);
  restored.slots[0]!.intent.kind = 'history';
  expect(teamViewTarget(restored, [missing], target, slot.id)).toBeUndefined();
});

it('keeps a released supporter reachable: listed in the layout of its group, opened as an ordinary session', () => {
  const group: Team = { ...team, members: [team.members[0]!, { ...team.members[0]!, id: 'reviewer', role: 'member', name: 'Reviewer', nativeSessionId: 'R', creation: 'released' },
    { ...team.members[0]!, id: 'pending', role: 'member', name: 'Pending', nativeSessionId: undefined, creation: 'reserved' }] };
  const layout = teamLayoutTargets(group, false);
  expect(layout.dock.map(target => target.teamMemberId)).toEqual(['leader', 'reviewer']);
  expect(layout.groupRoot?.teamMemberId).toBe('leader');
  const reviewer = layout.dock[1]!, slot = createCompositionSlot('reviewer-slot', reviewer, 'scope'), document = createCompositionDocument('scope', [slot]);
  document.windows = [{ id: 'reviewer-view', slotId: slot.id, managed: true, groupId: group.id, teamMemberId: 'reviewer' }];
  // No Team routing: its view follows the session itself.
  expect(teamViewTarget(parseComposition(document, 'scope'), [group], reviewer, slot.id)).toBeUndefined();
});
