import { expect, test } from '@playwright/test';

for (const viewport of [{ width: 393, height: 852 }, { width: 320, height: 568 }, { width: 844, height: 390 }]) {
  test(`mobile sidebar keeps discovery and navigation reachable at ${viewport.width}`, async ({ page }, info) => {
    test.skip(!info.project.use.isMobile);
    await page.setViewportSize(viewport);
    await page.route('**/v1/favorites', route => route.fulfill({ json: { revision: 0, folders: [], stars: [] } }));
    await page.route('**/v1/remote/hosts/host/vscode-tunnel', route => route.fulfill({ json: { status: 'stopped', processAlive: false, revision: 0 } }));
    await page.route('**/v1/remote/hosts/host/previews', route => route.fulfill({ json: { revision: 1, registrations: [] } }));
    await page.goto('/e2e/fixtures/session-stars.html?sidebar=1');
    const tracking = page.getByRole('button', { name: 'Tracked sessions', exact: true });
    await expect(tracking).toBeVisible();
    await page.getByRole('button', { name: 'Open sessions', exact: true }).click();
    const rail = page.getByRole('dialog', { name: 'Context', exact: true });
    const scroll = rail.locator('.lab-sidebar-content');
    async function assertPanelWidth(panel: string) {
      const bounds = await scroll.evaluate(element => {
        element.scrollLeft = 1000;
        return { width: element.clientWidth, scrollWidth: element.scrollWidth, left: element.scrollLeft };
      });
      expect(bounds.scrollWidth, `${panel} must fit its own scrollport`).toBeLessThanOrEqual(bounds.width + 1);
      expect(bounds.left, `${panel} must not scroll horizontally`).toBe(0);
    }
    const discover = rail.getByRole('region', { name: 'Discover sessions' });
    await expect(discover.locator('.lab-session-row')).toHaveCount(24);
    await expect(tracking).toBeHidden();
    await assertPanelWidth('Sessions');
    await expect(rail.getByRole('button', { name: /Controller updates/ })).toBeHidden();
    await expect(rail.getByRole('region', { name: 'Host VS Code tunnel' })).toHaveCount(0);
    await expect(rail.getByRole('searchbox', { name: 'Find an execution environment' })).toBeHidden();
    if (viewport.height > 600) await expect(discover.locator('.lab-session-row').first()).toBeInViewport();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('sessions.png') });
    const footer = rail.getByRole('button', { name: 'New session', exact: true });
    const before = await footer.boundingBox();
    await scroll.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect(discover.locator('.lab-session-row').last()).toBeInViewport();
    expect(await footer.boundingBox()).toEqual(before);
    const scrollBox = (await scroll.boundingBox())!;
    expect(scrollBox.y + scrollBox.height).toBeLessThanOrEqual(before!.y);
    await expect(rail.getByRole('navigation', { name: 'Sidebar sections' })).toBeInViewport();
    await rail.getByRole('button', { name: 'Settings', exact: true }).click();
    expect(await scroll.evaluate(element => element.scrollTop)).toBe(0);
    await assertPanelWidth('Settings');
    const updates = rail.getByRole('button', { name: /Controller updates/ });
    await expect(updates).toBeVisible();
    await updates.click();
    await assertPanelWidth('Settings with Controller updates');
    const vscode = rail.getByRole('region', { name: 'Host VS Code tunnel' });
    await expect(vscode).toBeVisible();
    const checkbox = vscode.getByRole('checkbox');
    await checkbox.check();
    expect((await checkbox.boundingBox())!.height).toBeLessThanOrEqual(22);
    await expect(vscode.getByRole('button', { name: 'Start tunnel' })).toBeEnabled();
    await page.screenshot({ path: info.outputPath('settings.png') });
    await rail.getByRole('button', { name: 'Favorites', exact: true }).click();
    await assertPanelWidth('Favorites');
    await expect(rail.getByRole('button', { name: /Controller updates/ })).toBeHidden();
    await rail.getByRole('button', { name: 'Settings', exact: true }).click();
    await expect(updates).toHaveAttribute('aria-expanded', 'true');
    await rail.getByRole('button', { name: 'Sessions', exact: true }).click();
    expect(await scroll.evaluate(element => element.scrollTop)).toBe(0);
    await rail.locator('.lab-host-disclosure > summary').click();
    await assertPanelWidth('Sessions with Host details');
    await rail.getByRole('searchbox', { name: 'Find an execution environment' }).fill('mac zsh');
    await expect(rail.getByRole('status').filter({ hasText: '1 matching Hosts' })).toBeVisible();
    await rail.locator('.lab-host-disclosure > summary').click();
    await rail.locator('.lab-rail-close').focus();
    await page.keyboard.press('Shift+Tab');
    await expect(footer).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(rail.locator('.lab-rail-close')).toBeFocused();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(tracking).toBeVisible();
    await expect(page.getByRole('button', { name: 'Open sessions', exact: true })).toBeFocused();
  });
}
