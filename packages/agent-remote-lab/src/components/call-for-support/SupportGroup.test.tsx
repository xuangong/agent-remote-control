import { act } from 'react';
import { expect, it } from 'vitest';
import type { Team, TeamAction } from '@orchardworks/agent-remote-protocol';
import { render } from '../../test/setup.js';
import { SupportGroup } from './SupportGroup.js';
import { enabledProfiles, workerGroups } from './SupportSession.js';
import { describeSession } from '../../session-description.js';

const source = { hostId: 'mac', providerId: 'codex', nativeSessionId: 'worker', title: 'Implement login' };
function supportTeam(overrides: Partial<NonNullable<Team['callForSupport']>> = {}): Team {
  return { id: 'group', operationId: 'op', revision: 1, source, title: 'Cross review', status: 'active', createdAt: 1, updatedAt: 1, messages: [],
    members: [
      { id: 'coordinator', hostId: 'mac', providerId: 'codex', role: 'leader', name: 'Coordinator', responsibility: '', creation: 'ready', activity: 'idle', summary: '', updatedAt: 1, nativeSessionId: 'coordinator-native', access: 'read_only', workspace: { kind: 'shared' } },
      { id: 'requester', hostId: 'mac', providerId: 'codex', role: 'requester', name: 'Worker', responsibility: '', creation: 'ready', activity: 'idle', summary: '', updatedAt: 1, nativeSessionId: 'worker' },
      { id: 'reviewer', hostId: 'mac', providerId: 'claude', role: 'member', name: 'Opus reviewer', responsibility: 'Review.', creation: 'ready', activity: 'busy', summary: '', updatedAt: 1, nativeSessionId: 'reviewer-native',
        model: 'opus', reasoningEffort: 'max', access: 'read_only', workspace: { kind: 'shared' }, usage: { tokens: 1200, updatedAt: 1 } },
    ],
    callForSupport: { role: 'Cross review', description: 'Independent reviewers.', coordinator: { providerId: 'codex' }, status: 'active', ledger: { text: '', revision: 0 }, usage: { tokens: 1500, costUsd: 0.25 },
      mandate: { supporters: [{ providerId: 'claude', model: 'opus' }], maxSupporters: 2, workspaces: ['shared'], remoteHosts: [], approval: 'every_roster', budget: { tokensTotal: 1000 } },
      calls: [{ id: 'c1', task: 'Review the login change.', deliverable: 'findings', origin: 'worker', status: 'reported', createdAt: 1, reportedAt: 2, usage: { tokens: 1500 },
        report: { status: 'reported', summary: 'One blocking finding.', findings: [{ id: 'f1', severity: 'blocking', location: 'src/login.ts:12', problem: 'Unchecked input.', suggestion: 'Validate it.', agreement: '2 of 2' }],
          resources: [{ resourceId: 'r1', name: 'fix.patch', mediaType: 'text/x-diff', byteLength: 10, sha256: 'a'.repeat(64) }] } },
        { id: 'c2', task: 'Check the tests.', deliverable: 'answer', origin: 'user', status: 'open', createdAt: 3, usage: { tokens: 0 } }],
      ...overrides } };
}
const button = (root: ParentNode, text: string) => [...root.querySelectorAll<HTMLButtonElement>('button')].find(item => item.textContent === text)!;

it('shows calls, reports, usage and supporters, and releases a supporter', async () => {
  const changes: TeamAction[] = [];
  const view = await render(<SupportGroup team={supportTeam()} hosts={[{ id: 'mac', name: 'Mac' }]} busy={false} onChange={async input => { changes.push(input); return true; }} onDelete={async () => true} onOpenSession={() => {}} />);
  expect(view.textContent).toContain('1,500 tokens · $0.25');
  expect(view.textContent).toContain('One blocking finding.');
  expect(view.textContent).toContain('blocking · src/login.ts:12: Unchecked input. → Validate it. (2 of 2)');
  expect(view.textContent).toContain('Resources: fix.patch');
  expect(view.textContent).toContain('claude · opus · max · shared, read-only · Mac · busy · 1,200 tokens');
  await act(async () => button(view, 'Release').click());
  expect(changes).toEqual([{ teamId: 'group', action: 'release_member', memberId: 'reviewer' }]);
});

it('asks the user to decide a pending roster, with a note', async () => {
  const changes: TeamAction[] = [];
  const team = supportTeam({ roster: { id: 'roster', status: 'pending', withinMandate: false, createdAt: 1, rationale: 'A second model.',
    members: [{ name: 'Sonnet reviewer', responsibility: 'Review style.', providerId: 'claude', model: 'sonnet', workspace: 'shared' }] } });
  const view = await render(<SupportGroup team={team} hosts={[]} busy={false} onChange={async input => { changes.push(input); return true; }} onDelete={async () => true} onOpenSession={() => {}} />);
  expect(view.textContent).toContain('Outside the profile');
  expect(view.textContent).toContain('Sonnet reviewer · claude · sonnet · shared');
  const note = view.querySelector<HTMLInputElement>('input[placeholder="Optional"]')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(note, 'Use one model.'); note.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(async () => button(view, 'Reject').click());
  expect(changes).toEqual([{ teamId: 'group', action: 'resolve_roster', rosterId: 'roster', decision: 'reject', note: 'Use one model.' }]);
});

it('raises the budget and resumes a paused role', async () => {
  const changes: TeamAction[] = [];
  const view = await render(<SupportGroup team={supportTeam({ status: 'paused_budget', pauseReason: 'This role used 1500 tokens of its 1000-token budget.' })} hosts={[]} busy={false}
    onChange={async input => { changes.push(input); return true; }} onDelete={async () => true} onOpenSession={() => {}} />);
  expect(view.textContent).toContain('Paused: budget reached');
  const total = [...view.querySelectorAll('label')].find(label => label.textContent?.startsWith('Tokens in total'))!.querySelector('input')!;
  await act(async () => { Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(total, '5000'); total.dispatchEvent(new Event('input', { bubbles: true })); });
  await act(async () => button(view, 'Raise budget and resume').click());
  expect(changes).toEqual([{ teamId: 'group', action: 'update_mandate', mandate: { ...supportTeam().callForSupport!.mandate, budget: { tokensTotal: 5000 } } }, { teamId: 'group', action: 'resume_group' }]);
});

it('finds a session\'s support roles and enabled profiles', () => {
  const team = supportTeam();
  // Archived roles take calls, which reopen them, after the active ones; an archiving role takes none.
  expect(workerGroups([{ ...team, id: 'archived', status: 'archived' }, team, { ...team, id: 'other', members: team.members.map(member => member.role === 'requester' ? { ...member, nativeSessionId: 'else' } : member) },
    { ...team, id: 'archiving', status: 'archiving' }], source).map(item => item.id)).toEqual(['group', 'archived']);
  const profile = { id: 'p', name: 'P', description: '', coordinator: {}, enableByDefault: true, revision: 1, updatedAt: 1, mandate: team.callForSupport!.mandate };
  expect(enabledProfiles({ profiles: [profile], enablement: [] }, source)).toEqual({ profiles: [profile], explicit: false });
  expect(enabledProfiles({ profiles: [profile], enablement: [{ ...source, profileIds: [], updatedAt: 1 }] }, source)).toEqual({ profiles: [], explicit: true });
});

it('describes the worker, the coordinator and supporters of a support role', () => {
  const team = supportTeam();
  const roles = (nativeSessionId: string) => describeSession({ session: { hostId: 'mac', providerId: nativeSessionId === 'reviewer-native' ? 'claude' : 'codex', nativeSessionId } as never, teams: [team] });
  expect(JSON.stringify(roles('worker'))).toContain('Calls for support');
  expect(JSON.stringify(roles('worker'))).toContain('1 open call');
  expect(JSON.stringify(roles('coordinator-native'))).toContain('Support coordinator');
  expect(JSON.stringify(roles('reviewer-native'))).toContain('Supporter');
});

it('lets the user settle a delivery whose outcome is uncertain', async () => {
  const changes: TeamAction[] = [];
  const team = supportTeam();
  team.messages = [{ id: 'm1', from: 'reviewer', to: 'coordinator', text: 'Opus reviewer: input is unchecked.', status: 'unknown', createdAt: 1, error: 'The operation may have reached the native runtime.' }];
  const view = await render(<SupportGroup team={team} hosts={[]} busy={false} onChange={async input => { changes.push(input); return true; }} onDelete={async () => true} onOpenSession={() => {}} />);
  expect(view.textContent).toContain('Opus reviewer → Coordinator: Opus reviewer: input is unchecked.');
  await act(async () => button(view, 'Confirm not received').click());
  expect(changes).toEqual([{ teamId: 'group', action: 'resolve_message', messageId: 'm1', outcome: 'rejected' }]);
});

it('archives a role and restores an archived one', async () => {
  const changes: TeamAction[] = [];
  const active = await render(<SupportGroup team={supportTeam()} hosts={[]} busy={false} onChange={async input => { changes.push(input); return true; }} onDelete={async () => true} onOpenSession={() => {}} />);
  await act(async () => button(active, 'Archive').click());
  expect(changes).toEqual([{ teamId: 'group', action: 'archive' }]);
  const archived = await render(<SupportGroup team={{ ...supportTeam(), status: 'archived' }} hosts={[]} busy={false} onChange={async input => { changes.push(input); return true; }} onDelete={async () => true} onOpenSession={() => {}} />);
  await act(async () => button(archived, 'Restore').click());
  expect(changes).toEqual([{ teamId: 'group', action: 'archive' }, { teamId: 'group', action: 'restore' }]);
});

it('deletes an archived role only after confirmation', async () => {
  let deleted = 0;
  const active = await render(<SupportGroup team={supportTeam()} hosts={[]} busy={false} onChange={async () => true} onDelete={async () => { deleted++; return true; }} onOpenSession={() => {}} />);
  expect(button(active, 'Delete')).toBeUndefined();
  const archived = await render(<SupportGroup team={{ ...supportTeam(), status: 'archived' }} hosts={[]} busy={false} onChange={async () => true} onDelete={async () => { deleted++; return true; }} onOpenSession={() => {}} />);
  expect(archived.textContent).toContain('a call reopens it');
  await act(async () => button(archived, 'Delete').click());
  await act(async () => button(archived, 'Keep').click());
  expect(deleted).toBe(0);
  await act(async () => button(archived, 'Delete').click());
  await act(async () => button(archived, 'Confirm deletion').click());
  expect(deleted).toBe(1);
});
