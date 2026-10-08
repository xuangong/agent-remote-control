import { expect, test, type Locator, type Page } from '@playwright/test';
import { showNewSession } from './session-navigation';

async function enableAsk(view: Locator) {
  const input = view.getByTestId('prompt-input');
  await expect(input).toBeEnabled();
  await input.fill('/ask');
  await input.press('Enter');
}

async function start(page: Page, isMobile: boolean) {
  if (!isMobile) await page.setViewportSize({ width: 1600, height: 1000 });
  await page.goto('/');
  await showNewSession(page);
  await page.getByTestId('session-create').click();
  const owner = page.locator('.lab-primary-conversation');
  await enableAsk(owner.locator(':scope > .lab-session-view'));
  const trigger = owner.getByRole('button', { name: 'Ask about this session', exact: true });
  await expect(trigger).toBeVisible();
  return { owner, trigger };
}

async function beginDrag(page: Page, trigger: Locator, target: { x: number; y: number }, touch: boolean) {
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

async function expectEdge(trigger: Locator, owner: Locator, edge: 'left' | 'right') {
  await expect.poll(async () => {
    const button = (await trigger.boundingBox())!, view = (await owner.boundingBox())!;
    return Math.abs(edge === 'left' ? button.x - view.x : button.x + button.width - view.x - view.width);
  }).toBeLessThan(1);
}

test('Ask drags freely, animates to an edge at the released height, and stays clickable after docking', async ({ page, isMobile, browserName }, testInfo) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  const { owner, trigger } = await start(page, isMobile);
  const view = (await owner.boundingBox())!, initial = (await trigger.boundingBox())!;
  const ask = owner.getByRole('dialog', { name: 'Ask', exact: true });
  await expectEdge(trigger, owner, 'right');
  const release = await beginDrag(page, trigger, { x: view.x + view.width * .35, y: initial.y + initial.height / 2 + 90 }, isMobile && browserName === 'chromium');
  const moved = (await trigger.boundingBox())!;
  expect(moved.y).toBeCloseTo(initial.y + 90, 0);
  expect(moved.x).toBeGreaterThan(view.x);
  expect(moved.x + moved.width).toBeLessThan(view.x + view.width);
  await expect(ask).toHaveCount(0);
  await release();
  const animations = await owner.locator(':scope > .lab-ask-floating').evaluate(element => element.getAnimations().map(animation => animation.effect?.getTiming().duration));
  expect(animations.some(duration => typeof duration === 'number' && duration >= 150)).toBe(true);
  await expectEdge(trigger, owner, 'left');
  expect((await trigger.boundingBox())!.y).toBeCloseTo(moved.y, 0);
  await expect(ask).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath('ask-docked-left.png') });
  await trigger.click();
  await expect(ask.getByTestId('prompt-input')).toBeEnabled();
  await ask.getByRole('button', { name: 'Minimize Ask', exact: true }).click();
  await expectEdge(trigger, owner, 'left');
  expect((await trigger.boundingBox())!.y).toBeCloseTo(moved.y, 0);
  const returnRight = await beginDrag(page, trigger, { x: view.x + view.width * .7, y: initial.y + initial.height / 2 + 20 }, isMobile && browserName === 'chromium');
  await returnRight();
  await expectEdge(trigger, owner, 'right');
  expect((await trigger.boundingBox())!.y).toBeCloseTo(initial.y + 20, 0);
  await expect(ask).toHaveCount(0);
});

test('keyboard docking honors reduced motion and restores each source independently', async ({ page, isMobile }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const { owner, trigger } = await start(page, isMobile);
  const initialTop = (await trigger.boundingBox())!.y - (await owner.boundingBox())!.y;
  await trigger.focus();
  await trigger.press('ArrowLeft');
  await trigger.press('Shift+ArrowDown');
  await expect(trigger).toBeFocused();
  await expectEdge(trigger, owner, 'left');
  expect((await trigger.boundingBox())!.y - (await owner.boundingBox())!.y).toBeCloseTo(initialTop + 40, 0);
  expect(await owner.locator(':scope > .lab-ask-floating').evaluate(element => parseFloat(getComputedStyle(element).transitionDuration))).toBeLessThanOrEqual(.00001);
  const primary = owner.locator(':scope > .lab-session-view');
  await primary.getByTestId('prompt-input').fill('/side Keep a separate Ask dock');
  await primary.getByTestId('prompt-input').press('Enter');
  const side = page.locator('.lab-side-conversation');
  await expect(side.locator('.agent-message-assistant').last()).toContainText('Keep a separate Ask dock');
  const sideView = side.locator(':scope > .lab-session-view');
  const takeControl = sideView.getByRole('button', { name: 'Take control', exact: true });
  if (await takeControl.isVisible()) await takeControl.click();
  await enableAsk(sideView);
  const sideTrigger = side.getByRole('button', { name: 'Ask about this session', exact: true });
  await expectEdge(sideTrigger, side, 'right');
  await page.reload();
  await expect(sideView.getByTestId('prompt-input')).toBeEnabled();
  await expectEdge(sideTrigger, side, 'right');
  if (isMobile) await page.getByRole('combobox', { name: 'Side path' }).selectOption({ index: 0 });
  await expectEdge(trigger, owner, 'left');
  expect((await trigger.boundingBox())!.y - (await owner.boundingBox())!.y).toBeCloseTo(initialTop + 40, 0);
  if (!isMobile) {
    await page.setViewportSize({ width: 1200, height: 900 });
    await expectEdge(trigger, owner, 'left');
    await expectEdge(sideTrigger, side, 'right');
  }
  await trigger.press('ArrowRight');
  await expectEdge(trigger, owner, 'right');
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(page.viewportSize()!.width);
});
