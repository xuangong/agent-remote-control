import { expect, test } from '@playwright/test';
import { createAgentRemoteRelay, createRemoteHostUplinkClient } from '@borgee/agent-remote-relay';
import { createRecordedLabProvider } from '../src/server/recorded.js';

test('selects a paired Host as a Provider and creates through its real uplink', async ({ page, request }, testInfo) => {
  const relayUrl = `http://127.0.0.1:${process.env.AGENT_REMOTE_TEST_RELAY_PORT ?? 5910}`;
  const invitation = await (await request.post(`${relayUrl}/v1/remote/pairings`, { data: {} })).json();
  const relay = createAgentRemoteRelay({ providers: [createRecordedLabProvider().provider] });
  const agents = new Set<string>();
  const creations: Record<string, unknown>[] = [];
  // A deterministic native runtime exercises the production Host transport without model credentials.
  const uplink = createRemoteHostUplinkClient({
    relay, url: relayUrl.replace('http:', 'ws:') + '/ws/remote-host', remoteKey: invitation.key,
    installationId: `browser-${testInfo.project.name}`, name: `Browser DSH ${testInfo.project.name}`,
    resolveSession: (id) => agents.has(id) ? relay.requireAgent(id) : undefined,
    async control(control) {
      if (control.path.startsWith('/remote/catalog')) return { status: 200, body: JSON.stringify({ items: [], hasMore: false, revision: '1' }) };
      if (control.path === '/remote/workspaces') return { status: 200, body: JSON.stringify({ workspaces: [{ id: 'native-project', name: 'Native project', path: '/native/project' }] }) };
      if (control.path !== '/remote/create') return { status: 404, body: '{}' };
      const body = JSON.parse(control.body!);
      creations.push(body);
      await relay.createAgent({ protocolVersion: '1.2.0', type: 'create_agent', payload: {
        requestId: control.sessionId!, agentId: control.sessionId!, providerId: 'recorded', config: { sessionId: body.nativeSessionId },
      } });
      agents.add(control.sessionId!);
      return { status: 200, body: JSON.stringify({ nativeSessionId: body.nativeSessionId }) };
    },
  });
  try {
    const { hostId } = await uplink.ready;
    await page.goto('/');
    const compact = testInfo.project.name === 'chromium-mobile';
    const context = () => compact ? page.getByRole('dialog', { name: 'Context' }) : page.locator('#lab-context');
    const provider = () => context().getByTestId('provider-select');
    const label = `DSH · Browser DSH ${testInfo.project.name} · Online`;
    await expect(provider().getByRole('option', { name: label, exact: true })).toHaveCount(1);
    await provider().selectOption({ label });
    await expect(context().getByLabel('Connected Host')).toHaveValue(hostId);
    await expect(context().getByLabel('New session mode')).toHaveCount(0);
    await context().getByLabel('Workspace', { exact: true }).selectOption('native-project');
    const creation = page.waitForResponse((response) => response.url().endsWith(`/hosts/${hostId}/create`));
    await context().getByTestId('session-create').click();
    const response = await creation;
    expect(response.ok()).toBe(true);
    expect(response.request().postDataJSON()).toMatchObject({ providerId: 'dsh', workspaceId: 'native-project' });
    await expect(page.getByTestId('prompt-input')).toBeEnabled();
    expect(creations).toEqual([{ nativeSessionId: expect.any(String), workspaceId: 'native-project' }]);
    await page.getByTestId('prompt-input').fill('Hello from the Provider selector.');
    await page.getByTestId('prompt-input').press('Enter');
    await expect(page.locator('.agent-message-assistant').filter({ hasText: 'Recorded reply: Hello from the Provider selector.' })).toBeVisible();
    await uplink.close();
    if (compact) await page.getByRole('button', { name: 'Context', exact: true }).click();
    await expect(context().getByRole('region', { name: 'Lab scenario controls' })).toHaveCount(0);
    await expect(context().getByTestId('session-resume')).toBeDisabled();
    await context().getByRole('button', { name: 'Retry Hosts', exact: true }).click();
    await expect(provider().getByRole('option', { name: `DSH · Browser DSH ${testInfo.project.name} · Offline`, exact: true })).toHaveCount(1);
    await expect(context().getByTestId('session-create')).toBeDisabled();
    await expect(provider()).toBeEnabled();
    await page.screenshot({ path: testInfo.outputPath('host-provider.png'), fullPage: true });
    await provider().selectOption('recorded');
    await expect(context().getByTestId('session-create')).toBeEnabled();
  } finally {
    await uplink.close();
    await relay.close();
  }
});
