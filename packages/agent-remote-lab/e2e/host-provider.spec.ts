import { showNewSession } from './session-navigation';
import { toggleViewPanel } from './view-options';
import { expect, test } from '@playwright/test';
import { createAgentRemoteRelay, createRemoteHostUplinkClient } from '@agent-remote-controller/agent-remote-relay';
import { createRecordedLabProvider } from '../src/server/recorded.js';

for (const selected of [{ id: 'codex', name: 'Codex CLI' }, { id: 'claude', name: 'Claude Code' }, { id: 'copilot', name: 'Copilot' }]) {
test(`selects ${selected.name} on a paired Host and creates through its real uplink`, async ({ page, request }, testInfo) => {
  const relayUrl = `http://127.0.0.1:${process.env.AGENT_REMOTE_TEST_RELAY_PORT ?? 5910}`;
  const invitation = await (await request.post(`${relayUrl}/v1/remote/pairings`, { data: {} })).json();
  const alternateInvitation = await (await request.post(`${relayUrl}/v1/remote/pairings`, { data: {} })).json();
  const relay = createAgentRemoteRelay({ providers: [createRecordedLabProvider().provider] });
  const alternateRelay = createAgentRemoteRelay({ providers: [createRecordedLabProvider().provider] });
  const agents = new Set<string>();
  const creations: Record<string, unknown>[] = [];
  // A deterministic native runtime exercises the production Host transport without model credentials.
  const uplink = createRemoteHostUplinkClient({
    relay, url: relayUrl.replace('http:', 'ws:') + '/ws/remote-host', remoteKey: invitation.key,
    installationId: `browser-${testInfo.project.name}`, name: `Browser DSH ${testInfo.project.name}`,
    providers: [{ providerId: 'dsh', displayName: 'DeepSeek DSH' }, { providerId: 'codex', displayName: 'Codex CLI' },
      { providerId: 'claude', displayName: 'Claude Code' }, { providerId: 'copilot', displayName: 'Copilot' }],
    resolveSession: (id) => agents.has(id) ? relay.requireAgent(id) : undefined,
    async control(control) {
      if (control.path.startsWith('/remote/catalog')) return { status: 200, body: JSON.stringify({ items: [], hasMore: false, revision: '1' }) };
      if (control.path.startsWith('/remote/workspaces')) return { status: 200, body: JSON.stringify({ workspaces: [{ id: 'native-project', name: 'Native project', path: '/native/project' }] }) };
      if (control.path !== '/remote/create') return { status: 404, body: '{}' };
      const body = JSON.parse(control.body!);
      creations.push(body);
      const nativeSessionId = `native-${creations.length}`;
      await relay.createAgent({ protocolVersion: '1.4.0', type: 'create_agent', payload: {
        requestId: control.sessionId!, operationId: body.operationId, agentId: control.sessionId!, providerId: 'recorded', config: { sessionId: nativeSessionId, cwd: '/native/project' },
      } });
      agents.add(control.sessionId!);
      return { status: 200, body: JSON.stringify({ agentId: control.sessionId, nativeSessionId }) };
    },
  });
  const alternateUplink = createRemoteHostUplinkClient({
    relay: alternateRelay, url: relayUrl.replace('http:', 'ws:') + '/ws/remote-host', remoteKey: alternateInvitation.key,
    installationId: `alternate-browser-${testInfo.project.name}`, name: `Alternate Host ${testInfo.project.name}`,
    providers: [{ providerId: selected.id, displayName: `Alternate ${selected.name}` }],
    resolveSession: () => undefined,
    async control(control) {
      if (control.path.startsWith('/remote/catalog')) return { status: 200, body: JSON.stringify({ items: [], hasMore: false, revision: '1' }) };
      if (control.path.startsWith('/remote/workspaces')) return { status: 200, body: JSON.stringify({ workspaces: [] }) };
      return { status: 404, body: '{}' };
    },
  });
  try {
    const { hostId } = await uplink.ready;
    const { hostId: alternateHostId } = await alternateUplink.ready;
    await page.goto('/');
    await showNewSession(page);
    const compact = testInfo.project.name === 'chromium-mobile';
    const context = () => compact ? page.getByRole('dialog', { name: 'Context' }) : page.locator('#lab-context');
    const provider = () => context().getByTestId('provider-select');
    const label = `${selected.name} · Browser DSH ${testInfo.project.name} · Online`;
    await expect(provider().getByRole('option', { name: label, exact: true })).toHaveCount(1);
    await provider().selectOption({ label });
    await expect(context().getByLabel('Connected Host')).toHaveValue(hostId);
    await context().getByLabel('Connected Host').selectOption(alternateHostId);
    await expect(provider()).toHaveValue(JSON.stringify([alternateHostId, selected.id]));
    await context().getByLabel('Connected Host').selectOption(hostId);
    await expect(provider()).toHaveValue(JSON.stringify([hostId, selected.id]));
    await context().getByLabel('Workspace', { exact: true }).selectOption('native-project');
    const creation = page.waitForResponse((response) => response.url().endsWith(`/hosts/${hostId}/create`));
    await showNewSession(page);
    await context().getByTestId('session-create').click();
    const response = await creation;
    expect(response.ok()).toBe(true);
    expect(response.request().postDataJSON()).toMatchObject({ providerId: selected.id, workspaceId: 'native-project' });
    await expect(page.getByTestId('connection-summary')).toContainText(`${selected.name} · Browser DSH ${testInfo.project.name}`);
    await expect(page.getByTestId('connection-summary')).not.toContainText('Online');
    await expect(page.getByTestId('prompt-input')).toBeEnabled();
    expect(creations).toEqual([{ providerId: selected.id, operationId: expect.any(String), workspaceId: 'native-project' }]);
    await page.getByTestId('prompt-input').fill('Hello from the Provider selector.');
    await page.getByTestId('prompt-input').press('Enter');
    await expect(page.locator('.agent-message-assistant').filter({ hasText: 'Recorded reply: Hello from the Provider selector.' })).toBeVisible();
    await page.getByTestId('prompt-input').fill('/side Continue from the paired Host context.');
    await page.getByTestId('prompt-input').press('Enter');
    const side = page.getByRole('complementary', { name: 'Side conversation' });
    await expect(side.locator('.agent-message-user').last()).toContainText('Continue from the paired Host context.');
    await expect(side.locator('.lab-fork-reference summary')).toBeVisible();
    expect(creations).toHaveLength(2);
    expect(creations[1]).toMatchObject({ providerId: selected.id, operationId: expect.any(String), cwd: '/native/project' });
    await side.getByRole('button', { name: 'Close side conversation' }).click();
    await uplink.close();
    if (compact) await toggleViewPanel(page, 'Sidebar');
    await expect(context().getByRole('region', { name: 'Lab scenario controls' })).toHaveCount(0);
    await expect(context().getByTestId('session-resume')).toBeDisabled();
    await showNewSession(page);
    await context().getByRole('button', { name: 'Retry Hosts', exact: true }).click();
    await expect(provider().getByRole('option', { name: `${selected.name} · Browser DSH ${testInfo.project.name} · Offline`, exact: true })).toHaveCount(1);
    await expect(context().getByTestId('session-create')).toBeDisabled();
    await expect(provider()).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath('host-provider.png'), fullPage: true });
    await provider().selectOption('recorded');
    await expect(context().getByTestId('session-create')).toBeEnabled();
  } finally {
    await uplink.close();
    await alternateUplink.close();
    await relay.close();
    await alternateRelay.close();
  }
});
}
