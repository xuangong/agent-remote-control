// Component projects: orchard-phone-webkit
import { expect, test, type Locator } from '@playwright/test';

// The Sessions drawer of a phone with three providers and values far longer than the screen: its list, a failed listing, the creation form
// and the provider chooser stay inside the drawer at every phone width. The fixture (`session-stars.html?providers`) serves three
// providers with twelve long sessions each and fails the listing while `window.fixtureCatalogFails` is set.
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
  test(`the drawer contains all three Browse providers at ${width}px through list, error and creation`, async ({ page }, info) => {
    await page.setViewportSize({ width, height: width === 844 ? 390 : 740 });
    await page.route('**/v1/favorites', route => route.fulfill({ json: { revision: 0, folders: [], stars: [] } }));
    await page.route('**/v1/remote/hosts/host/vscode-tunnel', route => route.fulfill({ json: { status: 'stopped', processAlive: false, revision: 0 } }));
    await page.route('**/v1/remote/hosts/host/previews', route => route.fulfill({ json: { revision: 1, registrations: [] } }));
    await page.goto('/e2e/fixtures/session-stars.html?sidebar=1&providers');
    await page.getByRole('button', { name: 'Open sessions', exact: true }).click();
    const drawer = page.getByRole('dialog', { name: 'Context', exact: true });
    await expect(drawer).toBeVisible();
    const discover = drawer.getByRole('region', { name: 'Discover sessions' });
    const chooser = drawer.getByRole('combobox', { name: 'Browse provider' });
    for (const provider of providers) await test.step(provider.displayName, async () => {
      const selection = JSON.stringify(['host', provider.providerId]);
      await expect(chooser.locator(`option[value='${selection}']`)).toHaveCount(1);
      await chooser.selectOption(selection);
      await expect(discover.locator('.lab-session-row')).toHaveCount(12);
      await expectContained(drawer);
      await page.evaluate(() => Object.assign(window, { fixtureCatalogFails: true }));
      await discover.getByRole('button', { name: 'Refresh', exact: true }).click();
      await expect(drawer.getByRole('alert')).toContainText('Discovery failed');
      await expectContained(drawer);
      await page.evaluate(() => Object.assign(window, { fixtureCatalogFails: false }));
      await discover.getByRole('button', { name: 'Refresh', exact: true }).click();
      await expect(drawer.getByRole('alert')).toHaveCount(0);
      await drawer.getByRole('button', { name: 'New session', exact: true }).click();
      await expect(drawer.getByLabel('Workspace', { exact: true }).locator('option[value="project"]')).toHaveCount(1);
      await drawer.getByLabel('Workspace', { exact: true }).selectOption('project');
      await drawer.getByLabel('Model', { exact: true }).fill(longValue);
      await expectContained(drawer);
      await drawer.getByLabel('Workspace', { exact: true }).selectOption('');
      await drawer.getByLabel('Working directory', { exact: true }).fill(`/projects/${longValue}`);
      await expectContained(drawer);
      await page.screenshot({ path: info.outputPath(`${provider.providerId}-creation.png`) });
      await drawer.getByRole('navigation', { name: 'Sidebar sections' }).getByRole('button', { name: 'Sessions', exact: true }).click();
    });
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  });
}
