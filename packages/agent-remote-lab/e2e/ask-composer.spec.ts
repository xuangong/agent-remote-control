import { expect, test } from '@playwright/test';
import { showNewSession } from './session-navigation';

for (const running of [false, true]) test(`Ask exposes shared composer controls while ${running ? 'working' : 'idle'} without moving the conversation or losing its draft`, async ({ page }, info) => {
  let primaryAgent: string | undefined;
  await page.routeWebSocket(/session-channel/, route => {
    const server = route.connectToServer();
    server.onMessage(message => {
      const envelope = JSON.parse(String(message));
      const frame = envelope.type === 'message' ? envelope.message : envelope;
      if (frame.type === 'agent_snapshot') {
        primaryAgent ??= frame.payload.id;
        frame.payload.capabilities.imageInput = {
          mediaTypes: ['image/png'], maxImages: 8, maxImageBytes: 10485760, maxMessageBytes: 20971520,
        };
        if (running && frame.payload.id !== primaryAgent) {
          frame.payload.status = 'running';
          frame.payload.runtimeInfo.status = 'running';
          frame.payload.activeTurn = { turnId: 'ask-turn', startedAt: new Date().toISOString() };
        }
      }
      route.send(JSON.stringify(envelope));
    });
  });
  await page.goto('/');
  await showNewSession(page);
  await page.getByTestId('session-create').click();
  const primary = page.locator('.lab-primary-conversation');
  await expect(primary.getByTestId('prompt-input')).toBeEnabled();
  await primary.getByTestId('prompt-input').fill('/ask');
  await primary.getByTestId('prompt-input').press('Enter');
  await page.getByRole('button', { name: 'Ask about this session', exact: true }).click();
  const ask = page.getByRole('dialog', { name: 'Ask', exact: true });
  const input = ask.getByTestId('prompt-input');
  await expect(input).toBeEnabled();
  await expect(ask.getByRole('button', { name: 'Hide message input', exact: true })).toBeVisible();
  if (running) await expect(ask.getByTestId('agent-activity-label')).toHaveText('Working');
  if (running) await expect(ask.getByTestId('turn-elapsed')).toBeVisible();
  await expect(ask.getByRole('button', { name: 'Add images' })).toBeVisible();
  const commands = ask.getByRole('button', { name: 'Open chat commands' });
  await expect(commands).toBeVisible();
  await commands.click();
  await expect(ask.getByRole('listbox', { name: 'Native commands' })).toBeVisible();
  await input.press('Escape');
  await input.fill('Keep this Ask draft');

  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const [trigger, label] of [
      [ask.getByTestId('session-model-button'), 'Model settings'],
      [ask.getByTestId('session-permissions-button'), 'Permission settings'],
      [ask.getByRole('button', { name: 'Status', exact: true }), 'Session status'],
    ] as const) {
      const before = (await ask.getByTestId('timeline').boundingBox())!;
      await trigger.click();
      const panel = ask.getByRole('region', { name: label, exact: true });
      await expect(panel).toBeVisible();
      if (label === 'Session status') await expect(panel.getByRole('switch', { name: 'Planning mode' })).toBeVisible();
      const bounds = (await ask.boundingBox())!;
      const menu = (await panel.boundingBox())!;
      expect(menu.x).toBeGreaterThanOrEqual(bounds.x);
      expect(menu.y).toBeGreaterThanOrEqual(bounds.y);
      expect(menu.x + menu.width).toBeLessThanOrEqual(bounds.x + bounds.width);
      expect((await ask.getByTestId('timeline').boundingBox())!.height).toBe(before.height);
      await trigger.press('Escape');
      await expect(ask).toBeVisible();
      await expect(panel).toBeHidden();
      await expect(trigger).toBeFocused();
    }
    await expect(input).toContainText('Keep this Ask draft');
    const actions = await ask.locator('.agent-composer-actions').evaluate(element => {
      const parent = element.getBoundingClientRect();
      return [...element.querySelectorAll('button')].filter(button => button.getClientRects().length).every(button => {
        const box = button.getBoundingClientRect();
        return box.left >= parent.left && box.right <= parent.right && box.bottom <= parent.bottom;
      });
    });
    expect(actions).toBe(true);
    if (running) {
      const activity = (await ask.locator('.agent-activity').boundingBox())!;
      const controls = (await commands.boundingBox())!;
      expect(activity.y + activity.height).toBeLessThanOrEqual(controls.y);
      await expect(ask.getByRole('button', { name: 'Interrupt', exact: true })).toBeVisible();
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(width);
    await ask.screenshot({ path: info.outputPath(`ask-composer-${width}.png`) });
  }
  await ask.getByTestId('session-model-button').click();
  await commands.focus();
  await expect(commands).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(ask).toBeVisible();
  await expect(ask.getByRole('region', { name: 'Model settings', exact: true })).toBeHidden();
  await ask.getByRole('button', { name: 'Minimize Ask' }).click();
  await page.getByRole('button', { name: 'Ask about this session', exact: true }).click();
  await expect(input).toContainText('Keep this Ask draft');
  await ask.press('Escape');
  await expect(ask).toHaveCount(0);
});

test('Ask handles Escape within its own settings and window without dismissing background session settings', async ({ page }) => {
  await page.goto('/');
  await showNewSession(page);
  await page.getByTestId('session-create').click();
  const primary = page.locator('.lab-primary-conversation');
  const primaryInput = primary.getByTestId('prompt-input');
  await expect(primaryInput).toBeEnabled();
  await primaryInput.fill('/ask');
  await primaryInput.press('Enter');
  const openAsk = page.getByRole('button', { name: 'Ask about this session', exact: true });
  await openAsk.click();
  const ask = page.getByRole('dialog', { name: 'Ask', exact: true });
  await expect(ask.getByTestId('prompt-input')).toBeEnabled();
  await ask.getByRole('button', { name: 'Minimize Ask' }).click();

  await primary.getByTestId('session-model-button').click();
  const backgroundSettings = primary.getByRole('region', { name: 'Model settings', exact: true });
  await expect(backgroundSettings).toBeVisible();
  await openAsk.focus();
  await openAsk.press('Enter');
  await expect(ask).toBeFocused();
  await expect(backgroundSettings).toBeVisible();

  const askModel = ask.getByTestId('session-model-button');
  await askModel.focus();
  await askModel.press('Enter');
  const askSettings = ask.getByRole('region', { name: 'Model settings', exact: true });
  await expect(askSettings).toBeVisible();
  await askModel.press('Escape');
  await expect(askSettings).toBeHidden();
  await expect(backgroundSettings).toBeVisible();
  await expect(askModel).toBeFocused();

  await ask.press('Escape');
  await expect(ask).toHaveCount(0);
  await expect(backgroundSettings).toBeVisible();
  await expect(openAsk).toBeFocused();
});

test('Ask opens the shared file preview above overlapping floating conversations', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Desktop previews share the non-modal workspace.');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto('/');
  await showNewSession(page);
  await page.getByTestId('session-create').click();
  const input = page.locator('.lab-primary-conversation').getByTestId('prompt-input');
  await expect(input).toBeEnabled();
  await input.fill('/ask');
  await input.press('Enter');
  await page.getByRole('button', { name: 'Ask about this session', exact: true }).click();
  const ask = page.getByRole('dialog', { name: 'Ask', exact: true });
  const file = ask.getByRole('button', { name: 'lab-proof.txt', exact: true });
  await file.click();
  const preview = page.getByRole('dialog', { name: 'File preview', exact: true });
  await expect(preview).toBeVisible();
  await expect(page.locator('.agent-preview-workspace')).toHaveCount(1);
  const overlap = await preview.evaluate(element => {
    const a = element.getBoundingClientRect();
    const b = document.querySelector('.lab-ask-window')!.getBoundingClientRect();
    const left = Math.max(a.left, b.left), right = Math.min(a.right, b.right);
    const top = Math.max(a.top, b.top), bottom = Math.min(a.bottom, b.bottom);
    return { intersects: right > left && bottom > top,
      previewOnTop: element.contains(document.elementFromPoint((left + right) / 2, (top + bottom) / 2)) };
  });
  expect(overlap).toEqual({ intersects: true, previewOnTop: true });
  await preview.getByRole('button', { name: 'Close file preview' }).click();
  await expect(preview).toBeHidden();
  await expect(ask).toBeVisible();
  await expect(file).toBeFocused();
});
