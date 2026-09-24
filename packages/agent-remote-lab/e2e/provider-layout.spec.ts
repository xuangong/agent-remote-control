import { expect, test, type Locator } from '@playwright/test';
import { createAgentRemoteRelay, createRemoteHostUplinkClient } from '@orchardworks/agent-remote-relay';

const providers = [
  { providerId: 'codex', displayName: 'Codex CLI' },
  { providerId: 'claude', displayName: 'Claude Code' },
  { providerId: 'copilot', displayName: 'GitHub Copilot CLI' },
];
const longValue = 'Workstation0123456789'.repeat(12);

async function expectContained(drawer: Locator) {
  const layout = await drawer.evaluate(element => {
    const bounds = element.getBoundingClientRect();
    const scrollers = [element, ...element.querySelectorAll('.lab-sidebar-content, .lab-session-list')];
    const overflow = scrollers.filter(item => item.clientWidth > 0).map(item => {
      item.scrollLeft = 100;
      return { class: item.className, extraWidth: item.scrollWidth - item.clientWidth, scrollLeft: item.scrollLeft };
    });
    const controls = [...element.querySelectorAll('button, select, input, textarea')].filter(item => item.getClientRects().length).map(item => {
      const rect = item.getBoundingClientRect();
      return { label: item.getAttribute('aria-label') ?? item.tagName, left: rect.left, right: rect.right };
    });
    return { left: bounds.left, right: bounds.right, overflow, controls };
  });
  for (const item of layout.overflow) { expect(item.extraWidth, item.class).toBeLessThanOrEqual(1); expect(item.scrollLeft).toBe(0); }
  for (const item of layout.controls) {
    expect(item.left, item.label).toBeGreaterThanOrEqual(layout.left);
    expect(item.right, item.label).toBeLessThanOrEqual(layout.right);
  }
}

for (const width of [320, 390, 844]) {
  test(`contains all three Browse providers at ${width}px through list, error, creation and settings`, async ({ page, request }, testInfo) => {
    test.skip(!['chromium-mobile', 'webkit-mobile-sidebar'].includes(testInfo.project.name), 'Mobile drawer layout.');
    await page.setViewportSize({ width, height: width === 844 ? 390 : 740 });
    const relayUrl = `http://127.0.0.1:${process.env.AGENT_REMOTE_TEST_RELAY_PORT ?? 5910}`;
    const invitation = await (await request.post(`${relayUrl}/v1/remote/pairings`, { data: {} })).json();
    const relay = createAgentRemoteRelay({ providers: [] });
    const requests: string[] = [];
    let failCatalog = false;
    const uplink = createRemoteHostUplinkClient({
      relay, url: relayUrl.replace('http:', 'ws:') + '/ws/remote-host', remoteKey: invitation.key,
      installationId: `provider-layout-${width}`, name: longValue, providers,
      resolveSession: () => undefined,
      async control(control) {
        const url = new URL(control.path, relayUrl);
        const providerId = url.searchParams.get('providerId')!;
        requests.push(`${url.pathname}:${providerId}`);
        if (url.pathname === '/remote/catalog/revision') return { status: 200, body: JSON.stringify({ revision: '1' }) };
        if (url.pathname === '/remote/catalog') return failCatalog
          ? { status: 503, body: JSON.stringify({ error: `Discovery failed: ${longValue}` }) }
          : { status: 200, body: JSON.stringify({ items: Array.from({ length: 12 }, (_, index) => ({
            providerId, nativeSessionId: `${providerId}-${index}`, title: `${providerId} ${longValue}`,
            workspace: `/projects/${longValue}`, model: longValue, state: 'idle',
            createdAt: '2026-09-14T00:00:00Z', updatedAt: '2026-09-14T00:00:00Z',
          })), hasMore: false, revision: '1' }) };
        if (url.pathname === '/remote/workspaces') return { status: 200, body: JSON.stringify({ workspaces: [{ id: 'project', name: longValue, path: `/projects/${longValue}` }] }) };
        return { status: 404, body: '{}' };
      },
    });
    try {
      const { hostId } = await uplink.ready;
      await page.goto('/');
      const drawer = page.getByRole('dialog', { name: 'Context', exact: true });
      await expect(drawer).toBeVisible();
      for (const provider of providers) await test.step(provider.displayName, async () => {
        const selection = JSON.stringify([hostId, provider.providerId]);
        await expect(drawer.getByRole('combobox', { name: 'Browse provider' }).locator(`option[value='${selection}']`)).toHaveCount(1);
        await drawer.getByRole('combobox', { name: 'Browse provider' }).selectOption(selection);
        await expect(drawer.getByRole('region', { name: 'Discover sessions' }).locator('.lab-session-row')).toHaveCount(12);
        await expectContained(drawer);
        failCatalog = true;
        await drawer.getByRole('region', { name: 'Discover sessions' }).getByRole('button', { name: 'Refresh', exact: true }).click();
        await expect(drawer.getByRole('alert')).toContainText('Discovery failed');
        await expectContained(drawer);
        failCatalog = false;
        await drawer.getByRole('region', { name: 'Discover sessions' }).getByRole('button', { name: 'Refresh', exact: true }).click();
        await expect(drawer.getByRole('alert')).toHaveCount(0);
        await drawer.getByRole('button', { name: 'New session', exact: true }).click();
        await expect(drawer.getByLabel('Workspace', { exact: true }).locator('option[value="project"]')).toHaveCount(1);
        await drawer.getByLabel('Workspace', { exact: true }).selectOption('project');
        await drawer.getByLabel('Model', { exact: true }).fill(longValue);
        await expectContained(drawer);
        await drawer.getByLabel('Workspace', { exact: true }).selectOption('');
        await drawer.getByLabel('Working directory', { exact: true }).fill(`/projects/${longValue}`);
        await expectContained(drawer);
        await drawer.getByRole('button', { name: 'Settings', exact: true }).click();
        await drawer.getByRole('button', { name: 'Pair Agent Host', exact: true }).click();
        await expectContained(drawer);
        await page.screenshot({ path: testInfo.outputPath(`${provider.providerId}-settings.png`) });
        await drawer.getByRole('button', { name: 'Pair Agent Host', exact: true }).click();
        await drawer.getByRole('button', { name: 'Sessions', exact: true }).click();
        expect(requests).toContain(`/remote/catalog:${provider.providerId}`);
        expect(requests).toContain(`/remote/workspaces:${provider.providerId}`);
      });
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
    } finally { await uplink.close(); await relay.close(); }
  });
}
