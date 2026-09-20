import { expect, test, type Page } from '@playwright/test';
import { showNewSession } from './session-navigation';

async function start(page: Page) {
  await page.goto('/');
  await showNewSession(page);
  await page.getByTestId('session-create').click();
  const primary = page.locator('.lab-primary-conversation');
  await expect(primary.getByTestId('prompt-input')).toBeEnabled();
  return primary;
}

test('Ask floats over its source, preserves a minimized draft and starts fresh on Clean', async ({ page }, info) => {
  await start(page);
  const url = page.url();
  const creations: Record<string, unknown>[] = [];
  page.on('request', request => { if (new URL(request.url()).pathname.endsWith('/create')) creations.push(request.postDataJSON()); });
  await page.getByRole('button', { name: 'Ask about this session', exact: true }).click();
  const ask = page.getByRole('dialog', { name: 'Ask', exact: true });
  await expect(ask.getByTestId('prompt-input')).toBeEnabled();
  expect(creations).toHaveLength(1);
  expect(creations[0]!.sourceNativeSessionId).toBe(new URL(url).searchParams.get('session'));
  await expect(ask.locator('.lab-fork-reference')).toHaveCount(0);
  await expect(page.getByRole('navigation', { name: 'Forked sessions' })).toHaveCount(0);
  await ask.getByTestId('prompt-input').fill('Explain the choice.');
  await ask.getByTestId('prompt-input').press('Enter');
  await expect(ask.locator('.agent-message-assistant').last()).toContainText('Explain the choice.');
  await ask.getByTestId('prompt-input').fill('A draft to keep');
  await ask.getByRole('button', { name: 'Minimize Ask' }).click();
  await expect(ask).toHaveCount(0);
  await page.getByRole('button', { name: 'Ask about this session', exact: true }).click();
  await expect(ask.getByTestId('prompt-input')).toHaveValue('A draft to keep');
  await expect(ask.locator('.agent-message-assistant').last()).toContainText('Explain the choice.');
  expect(creations).toHaveLength(1);
  await ask.getByRole('button', { name: 'Clean Ask' }).click();
  await expect.poll(() => creations.length).toBe(2);
  await expect(ask.getByTestId('prompt-input')).toHaveValue('');
  await expect(ask.getByTestId('timeline')).not.toContainText('Explain the choice.');
  expect(creations[1]!.sourceNativeSessionId).toBe(creations[0]!.sourceNativeSessionId);
  expect(creations[1]!.operationId).not.toBe(creations[0]!.operationId);
  expect(page.url()).toBe(url);
  const box = (await ask.boundingBox())!;
  expect(box.width).toBeLessThanOrEqual(page.viewportSize()!.width - 16);
  expect(box.y).toBeGreaterThanOrEqual(0);
  expect(box.y + box.height).toBeLessThanOrEqual(page.viewportSize()!.height);
  await ask.getByTestId('prompt-input').fill('What should I consider next?');
  await ask.getByTestId('prompt-input').press('Enter');
  await expect(ask.locator('.agent-message-assistant').last()).toContainText('What should I consider next?');
  await page.screenshot({ path: `../../.tmp/ask-${info.project.name}.png` });
});

test('/ask sends its question once and stays attached to the source when sessions change', async ({ page }) => {
  const primary = await start(page);
  const originalUrl = page.url();
  await primary.getByTestId('prompt-input').fill('/ask Why was this approach chosen?');
  await primary.getByTestId('prompt-input').press('Enter');
  const ask = page.getByRole('dialog', { name: 'Ask', exact: true });
  await expect(ask.locator('.agent-message-assistant').last()).toContainText('Why was this approach chosen?');
  await expect(ask.locator('.agent-message-user').filter({ hasText: 'Why was this approach chosen?' })).toHaveCount(1);
  await ask.getByRole('button', { name: 'Minimize Ask' }).click();
  await showNewSession(page);
  await page.getByTestId('session-create').click();
  await page.getByRole('button', { name: 'Ask about this session', exact: true }).click();
  await expect(ask.getByTestId('prompt-input')).toBeEnabled();
  await expect(ask.getByTestId('timeline')).not.toContainText('Why was this approach chosen?');
  await page.goto(originalUrl);
  await page.getByRole('button', { name: 'Ask about this session', exact: true }).click();
  await expect(ask.locator('.agent-message-assistant').last()).toContainText('Why was this approach chosen?');
});

test('a lost Clean response keeps the old conversation and retries the same creation', async ({ page }) => {
  await start(page);
  await page.getByRole('button', { name: 'Ask about this session', exact: true }).click();
  const ask = page.getByRole('dialog', { name: 'Ask', exact: true });
  await ask.getByTestId('prompt-input').fill('Keep this answer until reset succeeds');
  await ask.getByTestId('prompt-input').press('Enter');
  await expect(ask.locator('.agent-message-assistant').last()).toContainText('Keep this answer');
  await ask.getByTestId('prompt-input').fill('Reset this draft too');
  const operations: string[] = [];
  await page.route('**/v1/remote/create', async route => {
    operations.push(route.request().postDataJSON().operationId);
    const response = await route.fetch();
    if (operations.length === 1) await route.fulfill({ status: 504, json: { error: 'Creation outcome is unknown. Retry to reconnect.' } });
    else await route.fulfill({ response });
  });
  await ask.getByRole('button', { name: 'Clean Ask' }).click();
  await expect(ask.getByRole('alert')).toContainText('Creation outcome is unknown');
  await expect(ask.locator('.agent-message-assistant').last()).toContainText('Keep this answer');
  await ask.getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(ask.getByRole('alert')).toHaveCount(0);
  await expect(ask.getByTestId('timeline')).not.toContainText('Keep this answer');
  await expect(ask.getByTestId('prompt-input')).toHaveValue('');
  expect(operations).toHaveLength(2);
  expect(operations[1]).toBe(operations[0]);
});

test('Ask stays within a small viewport and follows the visual keyboard viewport', async ({ page }) => {
  await start(page);
  await page.getByRole('button', { name: 'Ask about this session', exact: true }).click();
  const ask = page.getByRole('dialog', { name: 'Ask', exact: true });
  await expect(ask.getByTestId('prompt-input')).toBeEnabled();
  for (const size of [{ width: 844, height: 390 }, { width: 320, height: 640 }]) {
    await page.setViewportSize(size);
    await expect.poll(async () => {
      const box = (await ask.boundingBox())!;
      return box.x >= 0 && box.y >= 0 && box.x + box.width <= size.width && box.y + box.height <= size.height;
    }).toBe(true);
  }
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport!, 'height', { configurable: true, value: 340 });
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await expect.poll(async () => {
    const box = (await ask.boundingBox())!;
    const input = (await ask.getByTestId('prompt-input').boundingBox())!;
    return box.y >= 0 && box.y + box.height <= 340 && input.y >= box.y && input.y + input.height <= box.y + box.height;
  }).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(320);
});


test('slash questions preserve an existing Ask draft', async ({ page }) => {
  const primary = await start(page);
  await page.getByRole('button', { name: 'Ask about this session', exact: true }).click();
  const ask = page.getByRole('dialog', { name: 'Ask', exact: true });
  await ask.getByTestId('prompt-input').fill('Keep my unfinished thought');
  await ask.getByRole('button', { name: 'Minimize Ask' }).click();
  await primary.getByTestId('prompt-input').fill('/ask A separate question');
  await primary.getByTestId('prompt-input').press('Enter');
  await expect(ask.locator('.agent-message-assistant').last()).toContainText('A separate question');
  await expect(ask.getByTestId('prompt-input')).toHaveValue('Keep my unfinished thought');
});

test('changing focus to a side conversation does not reopen the primary Ask', async ({ page }, info) => {
  test.skip(info.project.name !== 'chromium-desktop', 'Two visible conversations require desktop width.');
  const primary = await start(page);
  await primary.getByTestId('prompt-input').fill('/side');
  await primary.getByTestId('prompt-input').press('Enter');
  const side = page.getByRole('complementary', { name: 'Side conversation' });
  await expect(side.getByTestId('prompt-input')).toBeEnabled();
  await primary.getByTestId('prompt-input').fill('/ask');
  await primary.getByTestId('prompt-input').press('Enter');
  const ask = page.getByRole('dialog', { name: 'Ask', exact: true });
  await expect(ask.getByTestId('prompt-input')).toBeEnabled();
  const expand = page.getByRole('button', { name: 'Expand window 2:', exact: false });
  await expand.focus();
  await expand.press('Enter');
  await expect(ask).toHaveCount(0);
  await side.getByTestId('prompt-input').click();
  await expect(side.getByTestId('prompt-input')).toBeFocused();
});

test('a subsequent slash question keeps its uncertain delivery and retries with the same operation', async ({ page }) => {
  const attempts: string[] = [];
  let dropNext = false;
  await page.routeWebSocket(/.*/, route => {
    const server = route.connectToServer();
    route.onMessage(message => {
      const envelope = JSON.parse(String(message));
      const value = envelope.type === 'message' ? envelope.message : envelope;
      if (value.type === 'send_message') {
        attempts.push(value.payload.operationId);
        if (dropNext) { dropNext = false; route.close(); server.close(); return; }
      }
      server.send(message);
    });
  });
  const primary = await start(page);
  await primary.getByTestId('prompt-input').fill('/ask First question');
  await primary.getByTestId('prompt-input').press('Enter');
  const ask = page.getByRole('dialog', { name: 'Ask', exact: true });
  await expect(ask.locator('.agent-message-assistant').last()).toContainText('First question');
  await ask.getByRole('button', { name: 'Minimize Ask' }).click();
  dropNext = true;
  await primary.getByTestId('prompt-input').fill('/ask Uncertain second question');
  await primary.getByTestId('prompt-input').press('Enter');
  await expect(ask.locator('[data-delivery-state="unconfirmed"]')).toContainText('Uncertain second question');
  await ask.getByRole('button', { name: 'Minimize Ask' }).click();
  await page.getByRole('button', { name: 'Ask about this session', exact: true }).click();
  await ask.getByRole('button', { name: 'Retry message', exact: true }).click();
  await expect(ask.locator('.agent-message-assistant').last()).toContainText('Uncertain second question');
  expect(attempts).toHaveLength(3);
  expect(attempts[2]).toBe(attempts[1]);
});


test('a question queued while Ask opens survives minimizing and reload', async ({ page }) => {
  const primary = await start(page);
  let release!: () => void;
  const held = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/v1/remote/create', async route => {
    const response = await route.fetch();
    await held;
    await route.fulfill({ response });
  });
  await primary.getByTestId('prompt-input').fill('/ask Keep this queued question');
  await primary.getByTestId('prompt-input').press('Enter');
  const ask = page.getByRole('dialog', { name: 'Ask', exact: true });
  await ask.getByRole('button', { name: 'Minimize Ask' }).click();
  release();
  await expect(primary.getByTestId('prompt-input')).toHaveValue('');
  await expect(ask).toHaveCount(0);
  await page.reload();
  await page.getByRole('button', { name: 'Ask about this session', exact: true }).click();
  await expect(ask.locator('.agent-message-assistant').last()).toContainText('Keep this queued question');
  await expect(ask.locator('.agent-message-user').filter({ hasText: 'Keep this queued question' })).toHaveCount(1);
});
