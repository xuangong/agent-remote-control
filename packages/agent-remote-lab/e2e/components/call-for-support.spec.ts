import { expect, test } from '@playwright/test';

const source = { hostId: 'mac', providerId: 'codex', nativeSessionId: 'source', title: 'Project' };
const mandate = { supporters: [{ providerId: 'claude-code', model: 'opus' }], maxSupporters: 2, workspaces: ['shared'], remoteHosts: [], approval: 'every_roster' };
const profiles = [{ id: 'review', name: 'Cross review', description: 'Independent reviewers.', coordinator: {}, enableByDefault: false, revision: 1, updatedAt: 1, mandate }];
const group = (rosterStatus: 'pending' | 'provisioned') => ({ id: 'group', operationId: 'op', revision: 1, source, title: 'Cross review', status: 'active', createdAt: 1, updatedAt: 1, messages: [],
  members: [
    { id: 'coordinator', hostId: 'mac', providerId: 'codex', role: 'leader', name: 'Coordinator', responsibility: '', creation: 'ready', activity: 'idle', summary: '', updatedAt: 1, nativeSessionId: 'leader', access: 'read_only', workspace: { kind: 'shared' } },
    { id: 'requester', hostId: 'mac', providerId: 'codex', role: 'requester', name: 'Worker', responsibility: '', creation: 'ready', activity: 'idle', summary: '', updatedAt: 1, nativeSessionId: 'source' },
  ],
  callForSupport: { profileId: 'review', profileRevision: 1, role: 'Cross review', description: 'Independent reviewers.', coordinator: { providerId: 'codex' }, status: 'active', ledger: { text: '', revision: 0 },
    usage: { tokens: 1200 }, mandate,
    calls: [{ id: 'c1', task: 'Review the login change.', deliverable: 'findings', origin: 'worker', status: 'open', createdAt: 1, usage: { tokens: 1200 } }],
    roster: { id: 'roster', status: rosterStatus, withinMandate: true, createdAt: 1, rationale: 'An independent model.',
      members: [{ name: 'Opus reviewer', responsibility: 'Review for correctness.', providerId: 'claude-code', model: 'opus', workspace: 'shared' }] } } });

test('approves a support roster and calls for support from the Team panel', async ({ page }) => {
  const actions: unknown[] = [], created: unknown[] = [], enabled: unknown[] = [];
  let rosterStatus: 'pending' | 'provisioned' = 'pending';
  await page.route('**/v1/remote/teams', route => route.fulfill({ json: { teams: [group(rosterStatus)] } }));
  await page.route('**/v1/remote/teams/action', route => { const input = route.request().postDataJSON(); actions.push(input); rosterStatus = 'provisioned'; return route.fulfill({ json: group(rosterStatus) }); });
  await page.route('**/v1/remote/teams/create', route => { created.push(route.request().postDataJSON()); return route.fulfill({ json: group(rosterStatus) }); });
  await page.route('**/v1/remote/call-for-support', route => route.fulfill({ json: { profiles, enablement: [] } }));
  await page.route('**/v1/remote/call-for-support/enablement', route => { const input = route.request().postDataJSON(); enabled.push(input); return route.fulfill({ json: { profiles, enablement: [{ ...input, updatedAt: 2 }] } }); });
  await page.goto('/e2e/fixtures/team.html');

  const teams = page.getByRole('button', { name: 'Teams, a decision is waiting', exact: true });
  await teams.click();
  const role = page.getByRole('region', { name: 'Support role Cross review' });
  await expect(role.getByLabel('Roster proposal')).toContainText('Opus reviewer');
  await role.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect.poll(() => actions).toEqual([{ teamId: 'group', action: 'resolve_roster', rosterId: 'roster', decision: 'approve' }]);
  await expect(page.getByRole('button', { name: 'Teams', exact: true })).toBeVisible();

  const panel = page.getByRole('region', { name: 'Call For Support' });
  await expect(panel).toContainText('1 open call');
  await panel.getByRole('checkbox', { name: 'Cross review' }).check();
  await panel.getByRole('button', { name: 'Save for this session' }).click();
  await expect.poll(() => enabled).toEqual([{ hostId: 'mac', providerId: 'codex', nativeSessionId: 'source', profileIds: ['review'] }]);
  await expect(panel).toContainText('Chosen for this session.');

  await panel.getByRole('button', { name: 'Call for support…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Call for support' });
  await dialog.getByLabel('Support').selectOption('profile:review');
  await dialog.getByLabel('Start fresh').check();
  await dialog.getByLabel('Task').fill('Review the session handling before the pull request.');
  await dialog.getByLabel('Commit').fill('abcdef1');
  await dialog.getByRole('button', { name: 'Call', exact: true }).click();
  await expect.poll(() => created).toEqual([{ operationId: expect.any(String), source,
    callForSupport: { profileId: 'review', fresh: true, call: { task: 'Review the session handling before the pull request.', deliverable: 'findings', context: { commit: 'abcdef1' } } } }]);
  await expect(dialog).toBeHidden();
});
