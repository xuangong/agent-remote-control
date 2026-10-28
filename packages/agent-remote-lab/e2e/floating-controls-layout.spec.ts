import { expect, test, type Locator, type Page } from '@playwright/test';
import { sessionLinkFixture } from './session-link-fixture';

const controls = [
  { view: 'window', label: 'Windows', position: 'agent-remote:window-position' },
  { view: 'track', label: 'Tracked sessions', position: 'agent-remote-tracking-position' },
  { view: 'team', label: 'Teams', position: 'agent-remote:team-position' },
  { view: 'tpm', label: 'TPM works', position: 'agent-remote:tpm-position' },
  { view: 'ask', label: 'Ask about this session', position: 'agent-remote:ask-position' },
];

for (const control of controls) {
  test(`${control.view} floating button keeps the conversation width when moved to the right edge`, async ({ page, isMobile }, info) => {
    const width = isMobile ? 390 : 1440;
    await page.setViewportSize({ width, height: 900 });
    await page.addInitScript(({ view, position }) => {
      for (const name of ['window', 'track', 'team', 'tpm', 'ask']) {
        localStorage.setItem(`agent-remote:${name}-view`, String(name === view));
      }
      localStorage.setItem(position, JSON.stringify({ x: 120, y: 260 }));
      localStorage.setItem('agent-remote:desktop-notifications', 'false');
    }, control);
    await page.route('**/v1/favorites', route => route.fulfill({ json: { revision: 0, folders: [], stars: [] } }));
    await page.route('**/v1/remote/hosts/host/vscode-tunnel', route => route.fulfill({ json: { status: 'stopped', processAlive: false, revision: 0 } }));
    await page.route('**/v1/remote/hosts/host/previews', route => route.fulfill({ json: { revision: 1, registrations: [] } }));
    await page.goto('/e2e/fixtures/session-stars.html');
    const button = page.getByRole('button', { name: control.label, exact: true });
    await expect(button).toBeEnabled();
    const rail = page.locator('.lab-main-stage .lab-session-dock-rail');
    await expect(rail).toBeVisible();
    const original = (await rail.boundingBox())!;
    const anchor = (await button.boundingBox())!;
    await page.mouse.move(anchor.x + anchor.width / 2, anchor.y + anchor.height / 2);
    await page.mouse.down();
    await page.mouse.move(width - 1, anchor.y + anchor.height / 2, { steps: 10 });
    await page.mouse.up();
    await expect.poll(async () => {
      const box = (await button.boundingBox())!;
      return Math.round(width - box.x - box.width);
    }).toBe(12);
    await page.screenshot({ path: info.outputPath('right-edge.png') });
    expect((await rail.boundingBox())!.width).toBeCloseTo(original.width, 1);

    await button.press('Shift+ArrowLeft');
    expect((await button.boundingBox())!.x).toBeLessThan(width - anchor.width - 12);
    expect((await rail.boundingBox())!.width).toBeCloseTo(original.width, 1);
    await button.press('Shift+ArrowRight');
    await expect.poll(async () => {
      const box = (await button.boundingBox())!;
      return Math.round(width - box.x - box.width);
    }).toBe(12);
    expect((await rail.boundingBox())!.width).toBeCloseTo(original.width, 1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(width);
  });
}

async function drag(page: Page, button: Locator, dx: number, dy: number) {
  const box = (await button.boundingBox())!;
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  await page.mouse.move(start.x, start.y); await page.mouse.down();
  await page.mouse.move(start.x + dx, start.y + dy, { steps: 10 }); await page.mouse.up();
  return box;
}

test('Team moves after a remembered workspace confirms its access', async ({ page, isMobile }) => {
  const fixture = await sessionLinkFixture({ automaticSignIn: true });
  try {
    await page.addInitScript(() => localStorage.setItem('agent-remote:team-view', 'true'));
    await page.goto(fixture.url);
    await page.getByRole('link', { name: 'Sign in', exact: true }).click();
    const close = page.getByRole('button', { name: 'Close Context', exact: true });
    const button = page.getByRole('button', { name: 'Teams', exact: true });
    const team = page.locator('.lab-team-floating');
    await expect(team).toBeAttached();
    // A relaunched phone app renders the remembered workspace before its access is confirmed; Team appears only then.
    let confirm!: () => void;
    const confirmed = new Promise<void>(resolve => { confirm = resolve; });
    await page.route('**/auth/status', async route => { await confirmed; await route.continue(); });
    await page.goto(fixture.url);
    await expect(page.locator('.lab-shell')).toBeVisible();
    await expect(team).toHaveCount(0);
    confirm();
    await expect(team).toBeAttached();
    if (isMobile) { await expect(close).toBeVisible(); await close.click(); }
    await expect(button).toBeVisible();
    const before = await drag(page, button, -40, 150);
    await expect.poll(async () => Math.round((await button.boundingBox())!.y)).toBe(Math.round(before.y + 150));
    await expect(button).toHaveAttribute('aria-expanded', 'false');
  } finally { await fixture.close(); }
});

test('TPM shown after loading starts at its stylesheet place and moves', async ({ page, isMobile }) => {
  const width = isMobile ? 390 : 1440;
  await page.setViewportSize({ width, height: 900 });
  await page.addInitScript(() => localStorage.setItem('agent-remote:tpm-view', 'false'));
  await page.route('**/v1/favorites', route => route.fulfill({ json: { revision: 0, folders: [], stars: [] } }));
  await page.route('**/v1/remote/hosts/host/vscode-tunnel', route => route.fulfill({ json: { status: 'stopped', processAlive: false, revision: 0 } }));
  await page.route('**/v1/remote/hosts/host/previews', route => route.fulfill({ json: { revision: 1, registrations: [] } }));
  await page.goto('/e2e/fixtures/session-stars.html');
  const button = page.getByRole('button', { name: 'TPM works', exact: true });
  await expect(button).toBeHidden();
  await page.getByRole('button', { name: 'View options', exact: true }).click();
  const options = page.getByRole('region', { name: 'View options', exact: true });
  await options.getByRole('checkbox', { name: 'TPM view', exact: true }).check();
  await options.press('Escape');
  await expect(button).toBeVisible();
  // The stylesheet keeps TPM against the right edge; it was read while hidden as the left edge.
  await expect.poll(async () => { const box = (await button.boundingBox())!; return Math.round(width - box.x - box.width); }).toBe(12);
  const before = await drag(page, button, -60, 120);
  await expect.poll(async () => Math.round((await button.boundingBox())!.y)).toBe(Math.round(before.y + 120));
});
