import { expect, test } from '@playwright/test';
import { sessionLinkFixture } from './session-link-fixture';
import { showNewSession } from './session-navigation';

test('cached startup and foreground recovery keep the editor while business traffic waits for access', async ({ page }, testInfo) => {
  test.setTimeout(60000);
  const f = await sessionLinkFixture();
  let release!: () => void;
  try {
    await page.goto(f.url);
    await page.getByRole('link', { name: 'Sign in through gateway' }).click();
    await page.getByRole('link', { name: 'Sign in as alice' }).click();
    await page.getByLabel('Connected Host').selectOption(f.hostId);
    await showNewSession(page);
    await page.getByTestId('session-create').click();
    const input = page.getByTestId('prompt-input');
    await expect(input).toBeEnabled();
    await input.fill('Seamless cache marker');
    await page.getByTestId('prompt-submit').click();
    await expect(page.locator('.agent-message-assistant').last()).toContainText('Seamless cache marker');
    await expect.poll(() => page.evaluate(() => Object.keys(localStorage).some(key => key.endsWith(':workspace')))).toBe(true);
    await input.fill('My unsent draft');
    const timeline = page.getByTestId('timeline');
    await timeline.evaluate(element => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -150, bubbles: true }));
      element.scrollTop = Math.max(0, element.scrollHeight - element.clientHeight - 150);
      element.dispatchEvent(new Event('scroll'));
    });
    const readingTop = await timeline.evaluate(element => element.scrollTop);
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide')));
    const gate = new Promise<void>(resolve => { release = resolve; });
    let waiting = true;
    const premature: string[] = [];
    page.on('request', request => { if (waiting && /\/u\/[^/]+\/v1\//.test(request.url())) premature.push(request.url()); });
    await page.route('**/auth/status', async route => { await gate; await route.continue(); });
    await page.reload();
    await expect(page.locator('.agent-message-assistant').last()).toContainText('Seamless cache marker');
    await expect(input).toBeVisible();
    await expect(input).toHaveValue('My unsent draft');
    await expect.poll(async () => Math.abs(await timeline.evaluate(element => element.scrollTop) - readingTop)).toBeLessThan(4);
    await page.screenshot({ path: testInfo.outputPath('cached-workspace.png') });
    const editor = await input.elementHandle();
    await input.fill('Continue typing before authorization');
    expect(premature).toEqual([]);
    waiting = false; release();
    await expect(page.getByTestId('connection-summary')).toContainText('Ready');
    await expect.poll(() => editor!.evaluate(element => element.isConnected)).toBe(true);
    await expect(input).toHaveValue('Continue typing before authorization');
    await expect.poll(async () => Math.abs(await timeline.evaluate(element => element.scrollTop) - readingTop)).toBeLessThan(4);
    await expect(page.locator('.agent-message-assistant').last()).toContainText('Seamless cache marker');
    let finishResume!: () => void;
    const resume = new Promise<void>(resolve => { finishResume = resolve; });
    await page.route('**/auth/refresh', async route => { await resume; await route.continue(); });
    waiting = true; premature.length = 0;
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pageshow', { persisted: true })));
    await expect(input).toBeVisible();
    await input.fill('Still editing during recovery');
    await expect(page.locator('.gateway-recovery')).toBeVisible({ timeout: 7000 });
    expect(premature).toEqual([]);
    expect(await editor!.evaluate(element => element.isConnected)).toBe(true);
    waiting = false; finishResume();
    await expect(page.locator('.gateway-recovery')).not.toBeVisible();
    await expect(input).toHaveValue('Still editing during recovery');
    await page.getByTestId('prompt-submit').click();
    await expect(page.locator('.agent-message-assistant').last()).toContainText('Still editing during recovery');
  } finally { release?.(); await f.close(); }
});

test('returning browsers automatically complete Gateway authorization without an extra sign-in click', async ({ page }) => {
  const f = await sessionLinkFixture({ automaticSignIn: true });
  try {
    await page.goto(f.url);
    await page.getByRole('link', { name: 'Sign in through gateway' }).click();
    await expect(page.getByLabel('Connected Host')).toBeVisible();
    await page.evaluate(() => sessionStorage.removeItem('agent-remote:automatic-sign-in'));
    await page.context().clearCookies();
    await page.reload();
    await expect(page.getByLabel('Connected Host')).toBeVisible();
    await expect(page).toHaveURL(f.url + '/');
    expect(await page.evaluate(() => !!sessionStorage.getItem('agent-remote:automatic-sign-in'))).toBe(true);
  } finally { await f.close(); }
});
