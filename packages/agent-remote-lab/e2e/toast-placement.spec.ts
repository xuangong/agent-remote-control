import { expect, test, type Page } from '@playwright/test';
import { showNewSession } from './session-navigation';

async function openReconnectingSession(page: Page, ask = false) {
  let primaryId: string | undefined;
  await page.routeWebSocket(/session-channel/, route => {
    const server = route.connectToServer();
    server.onMessage(message => {
      const envelope = JSON.parse(String(message));
      const frame = envelope.type === 'message' ? envelope.message : envelope;
      if (frame.type === 'agent_snapshot') {
        primaryId ??= frame.payload.id;
        if (!ask || frame.payload.id !== primaryId) frame.payload.runtimeInfo.connection = { state: 'reconnecting' };
      }
      route.send(JSON.stringify(envelope));
    });
  });
  await page.goto('/'); await showNewSession(page); await page.getByTestId('session-create').click();
  await expect(page.locator('.lab-primary-conversation').getByTestId('prompt-input')).toBeVisible();
  if (ask) {
    const primary = page.locator('.lab-primary-conversation');
    await primary.getByTestId('prompt-input').fill('/ask'); await primary.getByTestId('prompt-input').press('Enter');
    await page.getByRole('button', { name: 'Ask about this session', exact: true }).click();
  }
  const toast = page.locator('.lab-toast').filter({ hasText: 'Native runtime is reconnecting' });
  await expect(toast).toBeVisible();
  await toast.hover(); // Pause the countdown while checking viewport transitions.
  return ask ? page.getByRole('dialog', { name: 'Ask', exact: true }) : page.locator('.lab-primary-conversation');
}

for (const ask of [false, true]) test(`mobile toast stays above the ${ask ? 'Ask' : 'main'} composer through keyboard and draft resizing`, async ({ page }, info) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const pane = await openReconnectingSession(page, ask);
  const input = pane.getByTestId('prompt-input');
  for (const viewport of [{ height: 844, offsetTop: 0 }, { height: 420, offsetTop: 80 }, { height: 340, offsetTop: 160 }, { height: 844, offsetTop: 0 }]) {
    await page.evaluate(value => {
      for (const [key, next] of Object.entries(value)) Object.defineProperty(window.visualViewport!, key, { configurable: true, value: next });
      window.visualViewport!.dispatchEvent(new Event('resize'));
      window.visualViewport!.dispatchEvent(new Event('scroll'));
    }, viewport);
    await input.fill(viewport.height === 340 ? 'A draft\nwith several\nlines of text\nto keep visible' : 'Keep typing');
    await expect.poll(async () => {
      const notification = await page.locator('.lab-toast-region').boundingBox();
      const composer = await pane.locator('.lab-composer-dock').boundingBox();
      return !!notification && !!composer && notification.height > 0
        && notification.y >= viewport.offsetTop && notification.y + notification.height <= composer.y - 8;
    }).toBe(true);
    await expect(input).toBeVisible();
  }
  await page.screenshot({ path: info.outputPath('toast-above-composer.png') });
});

test('desktop keeps the existing bottom-right toast position', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 900 });
  await openReconnectingSession(page);
  const bounds = (await page.locator('.lab-toast-region').boundingBox())!;
  expect(bounds.x + bounds.width).toBeCloseTo(1424, 0);
  expect(bounds.y + bounds.height).toBeCloseTo(884, 0);
});

test('mobile toast follows the collapsed composer and keeps its toggle accessible', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  const pane = await openReconnectingSession(page);
  await pane.getByRole('button', { name: 'Hide message input', exact: true }).click();
  const toggle = pane.getByRole('button', { name: 'Show message input', exact: true });
  await expect.poll(async () => {
    const bounds = await page.locator('.lab-toast-region').boundingBox();
    const button = await toggle.boundingBox();
    return bounds && button ? Math.round(button.y - bounds.y - bounds.height) : undefined;
  }).toBe(12);
  await toggle.click();
  await expect.poll(async () => {
    const toast = await page.locator('.lab-toast-region').boundingBox();
    const composer = await pane.locator('.lab-composer-dock').boundingBox();
    return !!toast && !!composer && toast.y + toast.height <= composer.y - 8;
  }).toBe(true);
});
