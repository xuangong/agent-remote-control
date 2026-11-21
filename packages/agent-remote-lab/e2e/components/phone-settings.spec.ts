import { expect, test } from '@playwright/test';
import { openSettingsPage } from '../all-sessions.js';

// Settings on a phone: the Computers group with a computer that has a very long name and a pairing key with long unbroken command
// lines. The Workbench runs on the Vite server alone; the Relay's answers are routed.

const longHost = 'DevelopmentWorkstationWithAnUnbrokenName0123456789abcdef0123456789';

async function openComputers(page: import('@playwright/test').Page) {
  await page.setViewportSize({ width: 390, height: 740 });
  await page.route('**/auth/status', route => route.fulfill({ json: { basePath: '/u/alice/', expiresAt: Date.now() + 120_000 } }));
  await page.route('**/v1/remote/hosts', route => route.fulfill({ json: { hosts: [{
    id: 'phone-host', name: longHost, online: true, managed: true, access: 'owner', credentialRotation: true,
    providers: [{ providerId: 'codex', displayName: 'Codex' }],
  }] } }));
  await page.route('**/v1/remote/pairings', route => route.request().method() !== 'POST' ? route.fallback() : route.fulfill({ json: {
    id: 'pairing-phone', purpose: 'host', status: 'unused',
    key: 'arc_test_' + 'x'.repeat(64), expiresAt: new Date(Date.now() + 60000).toISOString(),
    serverUrl: 'https://agents.example.test', command: 'AGENT_HOST_REMOTE_KEY=arc_test_' + 'x'.repeat(64) + ' agent-remote-controller start',
  } }));
  // Window mode, whose Me tab holds Settings; a phone's home is the assistant list.
  await page.goto('/?mode=window');
  const settings = await openSettingsPage(page, 'Computers');
  await expect(settings.locator('.lab-host-card')).toContainText('DevelopmentWorkstation');
  /** Every control stays inside the screen and the page does not scroll sideways. A Back button is aligned by its glyph and reaches 16 px past the left edge by design. */
  const fits = async (width: number) => {
    await page.setViewportSize({ width, height: 740 });
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBeLessThanOrEqual(1);
    expect(await settings.evaluate(element => element.scrollWidth - element.clientWidth), 'Settings does not scroll sideways').toBeLessThanOrEqual(1);
    const controls = await settings.locator('button:visible:not(.ui-icon-button, .lab-host-back), select:visible, textarea:visible').evaluateAll(elements => elements.map(element => {
      const rect = element.getBoundingClientRect(); return { name: (element.getAttribute('aria-label') ?? element.textContent ?? element.tagName).slice(0, 40), left: rect.left, right: rect.right };
    }));
    expect(controls.length).toBeGreaterThan(0);
    for (const bounds of controls) { expect(bounds.left, bounds.name).toBeGreaterThanOrEqual(0); expect(bounds.right, bounds.name).toBeLessThanOrEqual(width); }
  };
  return { settings, fits };
}

test('Settings > Computers and its pairing key keep every control and line inside a 390px and a 320px phone', async ({ page }, info) => {
  const { settings, fits } = await openComputers(page);
  await settings.getByRole('button', { name: 'Pair a computer', exact: true }).tap();
  const created = page.waitForResponse(response => response.url().endsWith('/v1/remote/pairings') && response.request().method() === 'POST');
  await settings.getByRole('button', { name: 'Generate pairing key', exact: true }).tap();
  await created;
  // The install commands have long unbroken lines; they scroll inside their own box, not the page.
  await expect(settings.getByLabel('Agent Host configuration')).toHaveValue(/agent-remote-controller start/);
  await page.screenshot({ path: info.outputPath('settings-pairing.png') });
  for (const width of [390, 320]) await fits(width);
});

test('a computer with a long unbroken name keeps its page and Rotate credential inside a 390px and a 320px phone', async ({ page }, info) => {
  // An open defect: the computer page's heading (`.lab-host-page-head h2`) does not wrap an unbroken name, so the page is 580 px wide
  // and Settings scrolls sideways. The test is expected to fail until the heading wraps; then remove this line.
  test.fail(true, 'the computer page heading does not wrap an unbroken name');
  const { settings, fits } = await openComputers(page);
  await settings.locator('.lab-host-open').first().tap();
  await settings.getByRole('button', { name: 'Rotate credential', exact: true }).tap();
  await page.screenshot({ path: info.outputPath('computer-page.png') });
  for (const width of [390, 320]) await fits(width);
});
