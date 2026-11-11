import { expect, test, devices } from '@playwright/test';
import { selectConnectedHost } from './all-sessions';
import { showNewSession } from './session-navigation';
import { sessionLinkFixture } from './session-link-fixture';

test('a clean mobile browser finds desktop Side and Ask from their source without creating or replaying them', async ({ browser, page }, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-desktop', 'Uses separate desktop and mobile contexts.');
  const f = await sessionLinkFixture();
  const mobile = await browser.newContext({ ...devices['iPhone 13'], baseURL: f.url });
  try {
    await page.goto(f.url + '/auth/login');
    await page.getByRole('link', { name: 'Sign in as alice' }).click();
    await selectConnectedHost(page, f.hostId);
    await showNewSession(page);
    await expect(page.getByTestId('session-create')).toBeEnabled();
    await page.getByTestId('session-create').click();
    const primary = page.locator('.lab-primary-conversation');
    const input = primary.getByTestId('prompt-input');
    await expect(input).toBeEnabled();
    // The address names the session once it is open; before that it only names the Window.
    await expect(page).toHaveURL(/[?&]session=/);
    const sourceUrl = page.url();
    await input.fill('/ask Desktop question'); await input.press('Enter');
    const ask = page.getByRole('dialog', { name: 'Ask', exact: true });
    await expect(ask.locator('.agent-message-assistant').last()).toContainText('Desktop question');
    const askMessages = await ask.locator('.agent-message-user').count();
    await ask.getByRole('button', { name: 'Minimize Ask', exact: true }).click();
    await input.fill('/side Desktop side question'); await input.press('Enter');
    // A Side opens as an attached Window pane beside its source.
    const side = page.locator('.lab-side-conversation').filter({ has: page.locator('.agent-message-user').filter({ hasText: 'Desktop side question' }) });
    await expect(side.locator('.agent-message-assistant').last()).toContainText('Desktop side question');
    const sideMessages = await side.locator('.agent-message-user').count();
    const phone = await mobile.newPage();
    const writes: string[] = [];
    // Selecting a view is a shared Window layout operation; nothing may create or replay a session.
    phone.on('request', request => {
      const path = new URL(request.url()).pathname;
      if (request.method() === 'POST' && /\/create$|\/operations$/.test(path) && !/\/v1\/windows\/[^/]+\/operations$/.test(path)) writes.push(request.url());
    });
    await phone.goto(sourceUrl);
    await phone.getByRole('link', { name: 'Sign in' }).click();
    await phone.getByRole('link', { name: 'Sign in as alice' }).click();
    const phonePrimary = phone.locator('.lab-primary-conversation');
    // The phone opens the shared Window, whose selected view is the desktop's Side; a narrow page shows only that view.
    // Its Side path leads back to the source, where the Side and Ask are found again.
    const sidePath = phone.getByRole('combobox', { name: 'Side path', exact: true });
    await expect(sidePath.locator('option')).toHaveText(['Root · New session', 'Side 1 · Fork of New session']);
    await sidePath.selectOption({ index: 0 });
    await expect(phonePrimary).toBeVisible();
    // Each Side entry sits beside its own actions menu.
    const entries = phonePrimary.getByRole('navigation', { name: 'Forked sessions' }).getByRole('button', { name: /^Side \d+ · / });
    await expect(entries).toHaveCount(1);
    // Since fd548154 Ask is one global control behind a per-browser Ask view preference, off in a clean browser.
    await phone.getByRole('button', { name: 'View options', exact: true }).first().click();
    const viewOptions = phone.getByRole('region', { name: 'View options', exact: true });
    await viewOptions.getByRole('checkbox', { name: 'Ask view', exact: true }).check();
    await viewOptions.press('Escape');
    await expect(viewOptions).toHaveCount(0);
    await expect(phone.getByRole('button', { name: 'Ask about this session', exact: true })).toBeVisible();
    await entries.click();
    const phoneSide = phone.locator('.lab-side-conversation:visible');
    await expect(phoneSide.locator('.agent-message-assistant').last()).toContainText('Desktop side question');
    await expect(phoneSide.locator('.agent-message-user')).toHaveCount(sideMessages);
    await expect(phoneSide.getByTestId('prompt-input')).toBeEnabled();
    expect(await phone.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await phone.screenshot({ animations: 'disabled', path: testInfo.outputPath('mobile-shared-side.png') });
    await phone.goto(sourceUrl);
    await sidePath.selectOption({ index: 0 });
    await expect(phonePrimary).toBeVisible();
    await phone.getByRole('button', { name: 'Ask about this session', exact: true }).click();
    const phoneAsk = phone.getByRole('dialog', { name: 'Ask', exact: true });
    await expect(phoneAsk.locator('.agent-message-assistant').last()).toContainText('Desktop question');
    await phone.screenshot({ animations: 'disabled', path: testInfo.outputPath('mobile-shared-ask.png') });
    await expect(phoneAsk.locator('.agent-message-user')).toHaveCount(askMessages);
    expect(writes).toEqual([]);
  } finally { await mobile.close(); await f.close(); }
});
