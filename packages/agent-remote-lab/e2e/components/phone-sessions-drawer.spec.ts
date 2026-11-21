import { expect, test } from '@playwright/test';

// On a compact screen the Window's Sessions panel is a full-width drawer that covers the page (its focus rules, Escape and the Tab loop,
// are unit tested in `SupportingRail`; the open and close rules in `panels`). What a browser decides is its layout: no panel is wider than
// its scrollport, the footer stays put while the list scrolls, and its close control is within reach at the top.
const routes = async (page: import('@playwright/test').Page) => {
  await page.route('**/v1/favorites', route => route.fulfill({ json: { revision: 0, folders: [], stars: [] } }));
  await page.route('**/v1/remote/hosts/host/vscode-tunnel', route => route.fulfill({ json: { status: 'stopped', processAlive: false, revision: 0 } }));
  await page.route('**/v1/remote/hosts/host/previews', route => route.fulfill({ json: { revision: 1, registrations: [] } }));
};

for (const viewport of [{ width: 393, height: 852 }, { width: 320, height: 568 }, { width: 844, height: 390 }]) {
  test(`at ${viewport.width}px the drawer keeps discovery and navigation reachable, and each panel fits its own scrollport`, async ({ page }, info) => {
    await page.setViewportSize(viewport);
    await routes(page);
    await page.goto('/e2e/fixtures/session-stars.html?sidebar=1');
    await page.getByRole('button', { name: 'Open sessions', exact: true }).click();
    const rail = page.getByRole('dialog', { name: 'Context', exact: true });
    await expect(rail).toBeVisible();
    expect((await rail.boundingBox())!.width).toBe(viewport.width);
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
    await assertPanelWidth('Sessions');
    // Settings, Controller updates and the VS Code tunnel are Settings pages now, not drawer panels.
    await expect(rail.getByRole('button', { name: /Controller updates/ })).toBeHidden();
    await expect(rail.getByRole('region', { name: 'Host VS Code tunnel' })).toHaveCount(0);
    await expect(rail.getByRole('searchbox', { name: 'Find an execution environment' })).toBeHidden();
    if (viewport.height > 600) await expect(discover.locator('.lab-session-row').first()).toBeInViewport();
    await expect(page.getByRole('alert')).toHaveCount(0);
    await page.screenshot({ path: info.outputPath('sessions.png') });
    // The footer is pinned: scrolling the list to its end moves the rows, not the footer, and the list ends above it.
    const footer = rail.getByRole('button', { name: 'New session', exact: true });
    const before = await footer.boundingBox();
    await scroll.evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect(discover.locator('.lab-session-row').last()).toBeInViewport();
    expect(await footer.boundingBox()).toEqual(before);
    const scrollBox = (await scroll.boundingBox())!;
    expect(scrollBox.y + scrollBox.height).toBeLessThanOrEqual(before!.y);
    await expect(rail.getByRole('navigation', { name: 'Sidebar sections' })).toBeInViewport();
    await rail.getByRole('button', { name: 'Favorites', exact: true }).click();
    await assertPanelWidth('Favorites');
    await rail.getByRole('button', { name: 'Sessions', exact: true }).click();
    expect(await scroll.evaluate(element => element.scrollTop)).toBe(0);
    await rail.locator('.lab-host-disclosure > summary').click();
    await assertPanelWidth('Sessions with Host details');
    await rail.getByRole('searchbox', { name: 'Find an execution environment' }).fill('mac zsh');
    await expect(rail.getByRole('status').filter({ hasText: '1 matching Hosts' })).toBeVisible();
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  });
}

test('the drawer filters its list and keeps its close control in reach, at touch size, after the list scrolls', async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await routes(page);
  await page.goto('/e2e/fixtures/session-stars.html?sidebar=1');
  await page.getByRole('button', { name: 'Open sessions', exact: true }).tap();
  const drawer = page.getByRole('dialog', { name: 'Context', exact: true });
  await expect(drawer).toBeVisible();
  const search = drawer.locator('.lab-session-search input');
  await search.fill('no-matching-session-xyz');
  await expect(drawer.locator('.lab-session-row')).toHaveCount(0);
  await expect(drawer.getByText('No matching loaded sessions.')).toBeVisible();
  await search.fill('');
  await expect(drawer.locator('.lab-session-row').first()).toBeVisible();
  await drawer.locator('.lab-sidebar-content').evaluate(element => { element.scrollTop = element.scrollHeight; });
  const close = drawer.getByRole('button', { name: 'Close Context', exact: true });
  const bounds = (await close.boundingBox())!;
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.y + bounds.height).toBeLessThan(80);
  expect(bounds.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: info.outputPath('phone-drawer.png') });
  await close.tap();
  await expect(drawer).toHaveCount(0);
});

test('choosing a session closes the drawer at once, and a drawer the person reopens while the Host attaches stays open', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await routes(page);
  await page.goto('/e2e/fixtures/session-stars.html?sidebar=1&switching&control');
  await page.evaluate(() => {
    const held = { release: () => {} };
    Object.assign(window, { fixtureAttachGate: new Promise<void>(resolve => { held.release = resolve; }), releaseAttach: () => held.release() });
  });
  const open = page.getByRole('button', { name: 'Open sessions', exact: true });
  const drawer = page.getByRole('dialog', { name: 'Context', exact: true });
  await open.click();
  await expect(drawer).toBeVisible();
  await drawer.getByRole('region', { name: 'Discover sessions' }).locator('.lab-session-row').nth(1).click();
  // The drawer closes when the session is chosen, before the Host answers.
  await expect(drawer).toBeHidden();
  await open.click();
  await expect(drawer).toBeVisible();
  await page.evaluate(() => (window as unknown as { releaseAttach(): void }).releaseAttach());
  await expect(page.getByTestId('timeline')).toContainText('Conversation for', { timeout: 10_000 });
  // The attachment finishing does not close what the person opened.
  await expect(drawer).toBeVisible();
  await drawer.getByRole('region', { name: 'Discover sessions' }).locator('.lab-session-row[aria-current="page"]').click();
  await expect(drawer).toBeHidden();
});
