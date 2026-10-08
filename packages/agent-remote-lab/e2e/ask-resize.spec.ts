import { expect, test, type Locator, type Page } from '@playwright/test';
import { showNewSession } from './session-navigation';

test.describe.configure({ timeout: 45_000 });

async function openAsk(page: Page) {
  await page.goto('/');
  await showNewSession(page);
  await page.getByTestId('session-create').click();
  const primary = page.locator('.lab-primary-conversation > .lab-session-view');
  await expect(primary.getByTestId('prompt-input')).toBeEnabled();
  await primary.getByTestId('prompt-input').fill('/ask');
  await primary.getByTestId('prompt-input').press('Enter');
  let creations = 0;
  page.on('request', request => { if (new URL(request.url()).pathname.endsWith('/create')) creations++; });
  const trigger = page.getByRole('button', { name: 'Ask about this session', exact: true });
  await trigger.click();
  const ask = page.getByRole('dialog', { name: 'Ask', exact: true });
  await expect(ask.getByTestId('prompt-input')).toBeEnabled();
  return { ask, trigger, primary, creations: () => creations };
}

async function moveAsk(page: Page, ask: Locator, x: number, y: number) {
  const before = (await ask.boundingBox())!;
  const heading = (await ask.locator('.lab-workbench-heading').boundingBox())!;
  await page.mouse.move(heading.x + 60, heading.y + 24);
  await page.mouse.down();
  await page.mouse.move(x + heading.x - before.x + 60, y + heading.y - before.y + 24, { steps: 8 });
  await page.mouse.up();
  const viewport = (await ask.locator('..').boundingBox())!;
  await expect.poll(async () => {
    const box = (await ask.boundingBox())!;
    return { x: Math.round(box.x), y: Math.round(box.y) };
  }).toEqual({ x: Math.round(Math.max(viewport.x + 12, Math.min(x, viewport.x + viewport.width - before.width - 12))), y: Math.round(Math.max(viewport.y + 12, Math.min(y, viewport.y + viewport.height - before.height - 12))) });
}

async function resizeAsk(page: Page, ask: Locator, dx: number, dy: number) {
  const handle = ask.getByRole('button', { name: 'Resize Ask', exact: true });
  await expect(handle).toBeVisible();
  const before = (await ask.boundingBox())!;
  const box = (await handle.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + dx, box.y + box.height / 2 + dy, { steps: 10 });
  await page.mouse.up();
  const viewport = (await ask.locator('..').boundingBox())!;
  await expect.poll(async () => {
    const resized = (await ask.boundingBox())!;
    return { width: Math.round(resized.width), height: Math.round(resized.height) };
  }).toEqual({ width: Math.round(Math.min(viewport.x + viewport.width - before.x - 12, Math.max(360, before.width + dx))), height: Math.round(Math.min(viewport.y + viewport.height - before.y - 12, Math.max(320, before.height + dy))) });
}

test('desktop Ask resizing keeps its position, draft and session through minimize and reload', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Desktop resizing.');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const { ask, trigger, creations } = await openAsk(page);
  const before = (await ask.boundingBox())!;
  const floating = page.locator('.lab-ask-floating');
  const anchor = (await floating.boundingBox())!;
  await ask.getByTestId('prompt-input').fill('Keep this question while resizing');
  await resizeAsk(page, ask, -60, 100);
  await expect.poll(async () => (await ask.boundingBox())!.width).toBeCloseTo(before.width - 60, 0);
  const resized = (await ask.boundingBox())!;
  expect(resized.height).toBeCloseTo(before.height + 100, 0);
  expect(resized.x).toBeCloseTo(before.x, 0);
  expect(resized.y).toBeCloseTo(before.y, 0);
  expect((await floating.boundingBox())!.x).toBeCloseTo(anchor.x, 0);
  expect((await floating.boundingBox())!.y).toBeCloseTo(anchor.y, 0);
  await expect(ask.getByTestId('prompt-input')).toHaveValue('Keep this question while resizing');
  expect(creations()).toBe(1);
  await ask.getByRole('button', { name: 'Minimize Ask' }).click();
  await trigger.click();
  await expect(ask.getByTestId('prompt-input')).toHaveValue('Keep this question while resizing');
  await expect.poll(() => ask.boundingBox()).toEqual(resized);
  await page.reload();
  await expect(ask).toBeVisible();
  await expect(ask.getByTestId('prompt-input')).toHaveValue('Keep this question while resizing');
  await expect.poll(() => ask.boundingBox()).toEqual(resized);
  expect(creations()).toBe(1);
  await moveAsk(page, ask, resized.x - 80, resized.y + 50);
  const moved = (await ask.boundingBox())!;
  expect(moved.width).toBe(resized.width);
  expect(moved.height).toBe(resized.height);
  expect(moved.x).toBeCloseTo(resized.x - 80, 0);
  expect(moved.y).toBeCloseTo(resized.y + 50, 0);
});

test('desktop Ask supports keyboard resizing and clamps both dimensions to its source view', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Desktop resizing.');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const { ask } = await openAsk(page);
  const bounds = (await ask.locator('..').boundingBox())!;
  await moveAsk(page, ask, bounds.x + 12, bounds.y + 12);
  const before = (await ask.boundingBox())!;
  const handle = ask.getByRole('button', { name: 'Resize Ask', exact: true });
  await handle.focus();
  await handle.press('ArrowRight');
  await handle.press('ArrowRight');
  await handle.press('Shift+ArrowDown');
  await expect.poll(() => ask.boundingBox()).toEqual({ ...before, width: before.width + 20, height: before.height + 40 });
  await resizeAsk(page, ask, 2000, 2000);
  await expect.poll(async () => { const box = (await ask.boundingBox())!; return box.x + box.width; }).toBeCloseTo(bounds.x + bounds.width - 12, 0);
  const maximum = (await ask.boundingBox())!;
  expect(maximum.x).toBeCloseTo(bounds.x + 12, 0);
  expect(maximum.y).toBeCloseTo(bounds.y + 12, 0);
  expect(maximum.x + maximum.width).toBeCloseTo(bounds.x + bounds.width - 12, 0);
  expect(maximum.y + maximum.height).toBeCloseTo(bounds.y + bounds.height - 12, 0);
  await resizeAsk(page, ask, -2000, -2000);
  await expect.poll(async () => (await ask.boundingBox())!.width).toBe(360);
  const minimum = (await ask.boundingBox())!;
  expect(minimum.width).toBeGreaterThanOrEqual(360);
  expect(minimum.height).toBeGreaterThanOrEqual(320);
  expect(minimum.width).toBeLessThan(before.width);
  expect(minimum.height).toBeLessThan(before.height);
  await expect(ask.getByRole('button', { name: 'Minimize Ask' })).toBeInViewport();
  await expect(ask.getByTestId('prompt-submit')).toBeInViewport();
  await resizeAsk(page, ask, 280, 380);
  const preferred = (await ask.boundingBox())!;
  await page.setViewportSize({ width: 1280, height: 650 });
  await expect.poll(async () => { const box = (await ask.boundingBox())!; const owner = (await ask.locator('..').boundingBox())!; return box.y + box.height <= owner.y + owner.height - 12; }).toBe(true);
  await expect(ask.getByTestId('prompt-submit')).toBeInViewport();
  await handle.focus();
  await handle.press('ArrowRight');
  await expect.poll(async () => (await ask.boundingBox())!.width).toBeCloseTo(preferred.width + 10, 0);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect.poll(async () => (await ask.boundingBox())!.height).toBeCloseTo(preferred.height, 0);
  await page.setViewportSize({ width: 1280, height: 650 });
  await expect.poll(async () => (await ask.boundingBox())!.height).toBeLessThan(preferred.height);
  await resizeAsk(page, ask, 10, 0);
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect.poll(async () => (await ask.boundingBox())!.height).toBeCloseTo(preferred.height, 0);
});

test('a resized desktop Ask returns to mobile layout and follows the visual keyboard viewport', async ({ page, isMobile }) => {
  test.skip(isMobile, 'Switches between desktop and mobile geometry.');
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const { ask, primary } = await openAsk(page);
  const owner = (await primary.boundingBox())!;
  await moveAsk(page, ask, owner.x + 12, owner.y + 12);
  await resizeAsk(page, ask, 240, 120);
  const preferred = (await ask.boundingBox())!;
  await ask.getByTestId('prompt-input').fill('Keep the responsive draft');
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(ask.getByRole('button', { name: 'Resize Ask', exact: true })).toBeHidden();
  await expect.poll(async () => JSON.stringify(await ask.boundingBox()) === JSON.stringify(await primary.boundingBox())).toBe(true);
  await page.evaluate(() => {
    Object.defineProperty(window.visualViewport!, 'height', { configurable: true, value: 360 });
    Object.defineProperty(window.visualViewport!, 'offsetTop', { configurable: true, value: 120 });
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await expect.poll(async () => { const box = (await ask.boundingBox())!; const owner = (await primary.boundingBox())!; return Math.abs(box.y + box.height - owner.y - owner.height); }).toBeLessThan(1);
  await expect(ask.getByTestId('prompt-input')).toHaveValue('Keep the responsive draft');
  await expect(ask.getByTestId('prompt-submit')).toBeInViewport();
  await page.evaluate(() => {
    delete (window.visualViewport as unknown as Record<string, unknown>).height;
    delete (window.visualViewport as unknown as Record<string, unknown>).offsetTop;
    window.visualViewport!.dispatchEvent(new Event('resize'));
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await expect(ask.getByRole('button', { name: 'Resize Ask', exact: true })).toBeVisible();
  await expect.poll(async () => (await ask.boundingBox())!.width).toBeCloseTo(preferred.width, 0);
  await expect.poll(async () => (await ask.boundingBox())!.height).toBeCloseTo(preferred.height, 0);
  await expect(ask.getByTestId('prompt-input')).toHaveValue('Keep the responsive draft');
});
