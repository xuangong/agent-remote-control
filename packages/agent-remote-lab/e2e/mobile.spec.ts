import { expect, test, type Page } from '@playwright/test';
import { toggleViewPanel } from './view-options';

test.beforeEach(async ({}, testInfo) => {
  test.skip(testInfo.project.name !== 'chromium-mobile', 'Touch layout acceptance.');
});

async function openSession(page: Page) {
  await page.goto('/');
  await page.getByTestId('session-create').click();
  await expect(page.getByTestId('prompt-input')).toBeEnabled();
}

test('keeps status readable and composer actions in one row on a small phone', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 320, height: 640 });
  await openSession(page);
  await expect(page.locator('.lab-app-bar')).toBeHidden();
  await toggleViewPanel(page, 'Header');
  await expect(page.getByTestId('connection-summary').getByText('Ready', { exact: true })).toBeVisible();
  const commands = (await page.getByRole('button', { name: 'Open chat commands' }).boundingBox())!;
  const send = (await page.getByTestId('prompt-submit').boundingBox())!;
  expect(send.y).toBe(commands.y);
  expect(send.x + send.width).toBeLessThanOrEqual(320);
  expect(send.height).toBeGreaterThanOrEqual(44);
  await page.getByTestId('session-model-button').tap();
  await expect(page.getByRole('region', { name: 'Model settings', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Close session controls' }).tap();
  await page.getByTestId('prompt-input').fill('A phone message');
  await page.getByTestId('prompt-submit').tap();
  await expect(page.locator('.agent-message-assistant').last()).toContainText('A phone message');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBe(320);
  await page.screenshot({ path: testInfo.outputPath('phone-chat.png') });
});

test('uses one chat viewport in landscape and returns to the retained source draft', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 844, height: 390 });
  await openSession(page);
  const primary = page.locator('.lab-primary-conversation');
  await primary.getByTestId('prompt-input').fill('/side');
  await primary.getByTestId('prompt-input').press('Enter');
  const side = page.getByRole('complementary', { name: 'Side conversation' });
  await expect(side.getByTestId('prompt-input')).toBeEnabled();
  await expect(primary).toBeHidden();
  const input = side.getByTestId('prompt-input');
  await input.fill('Side draft on phone');
  const send = (await side.getByTestId('prompt-submit').boundingBox())!;
  expect(send.y + send.height).toBeLessThanOrEqual(390);
  await side.getByRole('button', { name: 'Close side conversation' }).tap();
  await expect(primary).toBeVisible();
  await primary.getByTestId('prompt-input').fill('Source draft on phone');
  await primary.getByRole('navigation', { name: 'Forked sessions' }).getByRole('button').tap();
  await expect(side.getByTestId('prompt-input')).toHaveValue('Side draft on phone');
  await page.screenshot({ path: testInfo.outputPath('landscape-side.png') });
  await side.getByRole('button', { name: 'Close side conversation' }).tap();
  await expect(primary.getByTestId('prompt-input')).toHaveValue('Source draft on phone');
});

test('keeps the composer and command menu inside a contracted visual viewport', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.addInitScript(() => {
    const viewport = Object.assign(new EventTarget(), { height: 844, offsetTop: 0, scale: 1 });
    Object.defineProperty(window, 'visualViewport', { configurable: true, value: viewport });
  });
  await openSession(page);
  await page.getByTestId('prompt-input').fill('/');
  await page.evaluate(() => {
    Object.assign(window.visualViewport!, { height: 400, offsetTop: 20 });
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await expect.poll(async () => {
    const bounds = (await page.getByTestId('prompt-submit').boundingBox())!;
    return bounds.y + bounds.height;
  }).toBeLessThanOrEqual(420);
  const menu = (await page.getByRole('listbox', { name: 'Native commands' }).boundingBox())!;
  expect(menu.y).toBeGreaterThanOrEqual(20);
  await page.screenshot({ path: testInfo.outputPath('contracted-viewport.png') });
  await page.evaluate(() => {
    Object.assign(window.visualViewport!, { height: 200, offsetTop: 40, scale: 2 });
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  expect((await page.locator('.lab-shell').boundingBox())!.height).toBe(400);
  await page.evaluate(() => {
    Object.assign(window.visualViewport!, { height: 844, offsetTop: 0, scale: 1 });
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await expect.poll(async () => (await page.locator('.lab-shell').boundingBox())!.height).toBe(844);
  await expect(page.getByTestId('prompt-input')).toHaveValue('/');
});

test('keeps drawer dismissal reachable after scrolling and preserves the chat draft', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await openSession(page);
  await page.getByTestId('prompt-input').fill('Retain my phone draft');
  await page.getByRole('button', { name: 'View options', exact: true }).tap();
  await page.getByRole('checkbox', { name: 'Sidebar', exact: true }).tap();
  const drawer = page.getByRole('dialog', { name: 'Context', exact: true });
  await expect(drawer).toBeVisible();
  await drawer.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  const close = drawer.getByRole('button', { name: 'Close Context', exact: true });
  const bounds = (await close.boundingBox())!;
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(bounds.y + bounds.height).toBeLessThan(80);
  expect(bounds.height).toBeGreaterThanOrEqual(44);
  await page.screenshot({ path: testInfo.outputPath('phone-drawer.png') });
  await close.tap();
  await expect(drawer).toHaveCount(0);
  await expect(page.getByTestId('prompt-input')).toHaveValue('Retain my phone draft');
});
