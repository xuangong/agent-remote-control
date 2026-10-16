import { expect, test, type Locator, type Page } from '@playwright/test';
import { showNewSession } from './session-navigation';

async function enableAsk(view: Locator) {
  const input = view.getByTestId('prompt-input');
  await expect(input).toBeEnabled();
  await input.fill('/ask');
  await expect(view.getByTestId('prompt-submit')).toBeEnabled();
  await input.press('Enter');
}

async function start(page: Page, isMobile: boolean) {
  if (!isMobile) await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/');
  await showNewSession(page);
  const created = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/create'));
  await page.getByTestId('session-create').click();
  const response = await created;
  expect(response.ok()).toBe(true);
  const identity = await response.json() as { nativeSessionId: string };
  await expect(page).toHaveTitle('New session · Agent Remote Control');
  const owner = page.locator('.lab-primary-conversation');
  await enableAsk(owner.locator(':scope > .lab-session-view'));
  const trigger = page.getByRole('button', { name: 'Ask about this session', exact: true });
  await expect(trigger).toBeEnabled();
  const surface = page.locator('.lab-ask-workspaces');
  await expect(surface).toHaveCount(1);
  await expect.poll(async () => {
    const bounds = (await surface.boundingBox())!;
    return { x: bounds.x, width: bounds.width, bottom: bounds.y + bounds.height };
  }).toEqual({ x: 0, width: page.viewportSize()!.width, bottom: page.viewportSize()!.height });
  return { owner, surface, trigger, identity };
}

async function beginDrag(page: Page, trigger: Locator, target: { x: number; y: number }, touch: boolean) {
  await expect(trigger).toBeEnabled();
  const box = (await trigger.boundingBox())!;
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  if (touch) {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...start, id: 1 }] });
    for (let step = 1; step <= 4; step++) await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{
      x: start.x + (target.x - start.x) * step / 4, y: start.y + (target.y - start.y) * step / 4, id: 1,
    }] });
    // CDP acknowledgement can precede the final touch move reaching the renderer.
    await expect.poll(async () => {
      const current = (await trigger.boundingBox())!;
      return Math.hypot(current.x + current.width / 2 - target.x, current.y + current.height / 2 - target.y);
    }).toBeLessThan(1);
    return async () => {
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      await cdp.detach();
    };
  }
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(target.x, target.y, { steps: 5 });
  return () => page.mouse.up();
}

async function expectPosition(trigger: Locator, point: { x: number; y: number }) {
  await expect.poll(async () => {
    const button = (await trigger.boundingBox())!;
    return Math.max(Math.abs(button.x - point.x), Math.abs(button.y - point.y));
  }).toBeLessThan(1);
}

test('the Ask launcher moves freely without snapping, suppresses drag clicks, and restores its position', async ({ page, isMobile, browserName }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const { surface, trigger } = await start(page, isMobile);
  const view = (await surface.boundingBox())!, initial = (await trigger.boundingBox())!;
  const ask = page.getByRole('dialog', { name: 'Ask', exact: true });
  const release = await beginDrag(page, trigger, { x: view.x + view.width * .35, y: initial.y + initial.height / 2 + 90 }, isMobile && browserName === 'chromium');
  const moved = (await trigger.boundingBox())!;
  expect(moved.y).toBeCloseTo(initial.y + 90, 0);
  expect(moved.x).toBeGreaterThan(view.x);
  expect(moved.x + moved.width).toBeLessThan(view.x + view.width);
  await expect(ask).toHaveCount(0);
  await release();
  await expectPosition(trigger, moved);
  await expect(ask).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('ask-free-position.png') });
  await trigger.click();
  await expect(ask.getByTestId('prompt-input')).toBeEnabled();
  await expect(trigger).toBeVisible();
  await expect(trigger).toHaveCount(1);
  await ask.getByRole('button', { name: 'Minimize Ask', exact: true }).click();
  await expectPosition(trigger, moved);
  const returnRight = await beginDrag(page, trigger, { x: view.x + view.width * .7, y: initial.y + initial.height / 2 + 20 }, isMobile && browserName === 'chromium');
  const final = (await trigger.boundingBox())!;
  await returnRight();
  await expectPosition(trigger, final);
  expect(final.x).toBeGreaterThan(view.x + 12);
  expect(final.x + final.width).toBeLessThan(view.x + view.width - 12);
  await expect(ask).toHaveCount(0);
  await page.reload();
  await expect(trigger).toBeEnabled();
  await expectPosition(trigger, final);
  await expect(ask).toHaveCount(0);
});

test('keyboard movement shares one launcher while binding each Ask to the selected source', async ({ page, isMobile }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const { owner, surface, trigger, identity } = await start(page, isMobile);
  const initial = (await trigger.boundingBox())!;
  await trigger.focus();
  await trigger.press('ArrowLeft');
  await trigger.press('Shift+ArrowDown');
  await expect(trigger).toBeFocused();
  const preferred = { x: initial.x - 10, y: initial.y + 40 };
  await expectPosition(trigger, preferred);
  expect(await surface.locator('.lab-ask-floating').evaluate(element => parseFloat(getComputedStyle(element).transitionDuration))).toBeLessThanOrEqual(.00001);
  const primary = owner.locator(':scope > .lab-session-view');
  const sideCreated = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/create'));
  await primary.getByTestId('prompt-input').fill('/side Keep a separate Ask conversation');
  await expect(primary.getByTestId('prompt-submit')).toBeEnabled();
  await primary.getByTestId('prompt-input').press('Enter');
  const sideIdentity = await (await sideCreated).json();
  const side = page.locator('.lab-side-conversation');
  await expect(side.locator('.agent-message-assistant').last()).toContainText('Keep a separate Ask conversation');
  const sideView = side.locator(':scope > .lab-session-view');
  const takeControl = sideView.getByRole('button', { name: 'Take control', exact: true });
  if (await takeControl.isVisible()) await takeControl.click();
  await sideView.getByTestId('prompt-input').focus();
  await expect(trigger).toHaveCount(1);
  await expectPosition(trigger, preferred);
  const sideAskCreation = page.waitForRequest(request => new URL(request.url()).pathname.endsWith('/create'));
  await trigger.click();
  expect((await sideAskCreation).postDataJSON().sourceNativeSessionId).toBe(sideIdentity.nativeSessionId);
  const ask = page.getByRole('dialog', { name: 'Ask', exact: true });
  await expect(ask.getByTestId('prompt-input')).toBeEnabled();
  await ask.getByTestId('prompt-input').fill('Keep the side Ask draft');
  await expect(trigger).toBeVisible();
  await expect(side.getByRole('dialog', { name: 'Ask', exact: true })).toHaveCount(0);
  await ask.getByRole('button', { name: 'Minimize Ask', exact: true }).click();
  if (isMobile) await page.getByRole('combobox', { name: 'Side path' }).selectOption({ index: 0 });
  else await primary.getByTestId('prompt-input').focus();
  const primaryAskCreation = page.waitForRequest(request => new URL(request.url()).pathname.endsWith('/create'));
  await trigger.click();
  expect((await primaryAskCreation).postDataJSON().sourceNativeSessionId).toBe(identity.nativeSessionId);
  await expect(ask.getByTestId('prompt-input')).toBeEnabled();
  await expect(ask.getByTestId('prompt-input')).toHaveText('');
  await ask.getByRole('button', { name: 'Minimize Ask', exact: true }).click();
  await page.reload();
  await expect(primary.getByTestId('prompt-input')).toBeEnabled();
  await expect(trigger).toHaveCount(1);
  await expectPosition(trigger, preferred);
  if (isMobile) await page.getByRole('combobox', { name: 'Side path' }).selectOption({ index: 1 });
  else await sideView.getByTestId('prompt-input').focus();
  await trigger.click();
  await expect(ask.getByTestId('prompt-input')).toHaveText('Keep the side Ask draft');
  await ask.getByRole('button', { name: 'Minimize Ask', exact: true }).click();
  if (!isMobile) {
    await page.setViewportSize({ width: 1200, height: 900 });
    await expect.poll(async () => { const box = (await trigger.boundingBox())!; return box.x + box.width; }).toBeLessThanOrEqual(1188);
  }
  const before = (await trigger.boundingBox())!;
  await expect(trigger).toBeEnabled();
  await trigger.press('ArrowLeft');
  await expectPosition(trigger, { x: before.x - 10, y: before.y });
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
});

test('an open global Ask keeps Window, Team and View controls operable without losing its draft', async ({ page, isMobile }) => {
  const { trigger } = await start(page, isMobile);
  await trigger.click();
  const ask = page.getByRole('dialog', { name: 'Ask', exact: true });
  await expect(ask.getByTestId('prompt-input')).toBeEnabled();
  await ask.getByTestId('prompt-input').fill('Keep this question while using global controls');
  for (const name of ['Windows', 'Teams'] as const) {
    await page.getByRole('button', { name, exact: true }).click();
    const menu = page.getByRole('region', { name, exact: true });
    await expect(menu).toBeVisible();
    await menu.getByRole('button', { name: `Close ${name}`, exact: true }).click();
    await expect(ask).toBeVisible();
    await expect(ask.getByTestId('prompt-input')).toHaveText('Keep this question while using global controls');
  }
  await page.getByRole('button', { name: 'View options', exact: true }).click();
  const options = page.getByRole('region', { name: 'View options', exact: true });
  await expect(options.getByRole('checkbox', { name: 'Ask view', exact: true })).toBeChecked();
  await options.press('Escape');
  await expect(options).toHaveCount(0);
  await expect(trigger).toBeVisible();
  await expect(ask.getByTestId('prompt-input')).toHaveText('Keep this question while using global controls');
});
