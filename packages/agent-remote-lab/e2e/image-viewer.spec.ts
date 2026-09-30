import { expect, test, type Locator, type Page } from '@playwright/test';

async function preview(page: Page): Promise<Locator> {
  const dialog = page.getByRole('dialog', { name: 'Image preview', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('img')).toBeVisible();
  await expect.poll(() => dialog.getByRole('img').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(1200);
  const bounds = (await dialog.boundingBox())!;
  const viewport = page.viewportSize()!;
  expect(bounds.width).toBeGreaterThanOrEqual(viewport.width * 0.98);
  expect(bounds.height).toBeGreaterThanOrEqual(viewport.height * 0.98);
  expect(bounds.x).toBeGreaterThanOrEqual(0);
  expect(bounds.y).toBeGreaterThanOrEqual(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  return dialog;
}

async function openMarkdown(page: Page): Promise<Locator> {
  const trigger = page.getByRole('button', { name: 'Open image: Viewer diagram', exact: true });
  await trigger.scrollIntoViewIfNeeded();
  await expect(trigger.getByRole('img')).toBeVisible();
  await trigger.focus();
  await trigger.click();
  return preview(page);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/e2e/fixtures/image-viewer.html');
  await expect(page.getByTestId('timeline')).toBeVisible();
});

test('renders bound native images in content-only view and opens a zoomable fullscreen preview', async ({ page }, info) => {
  for (const provider of ['codex', 'claude']) {
    await page.goto(`/e2e/fixtures/image-viewer.html?content=1&native-image=${provider}`);
    const timeline = page.getByTestId('timeline');
    await timeline.dispatchEvent('wheel', { deltaY: -1 });
    await timeline.getByRole('heading', { name: 'Conversation image', exact: true }).scrollIntoViewIfNeeded();
    const trigger = timeline.getByRole('button', { name: 'Open image: Viewer diagram', exact: true });
    await expect(trigger).toBeVisible();
    await trigger.scrollIntoViewIfNeeded();
    const inlineImage = timeline.getByRole('img', { name: 'Viewer diagram', exact: true });
    await expect(inlineImage).toHaveCount(1);
    await expect(inlineImage).toBeVisible();
    await expect.poll(() => inlineImage.evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(1200);
    await expect(page.getByRole('region', { name: 'Referenced resources', exact: true })).toHaveCount(0);
    await page.screenshot({ path: info.outputPath(`content-${provider}-image.png`) });
    await trigger.click();
    const dialog = await preview(page);
    const image = dialog.getByRole('img');
    const fittedWidth = (await image.boundingBox())!.width;
    await dialog.getByRole('button', { name: 'Zoom in', exact: true }).click();
    await expect.poll(async () => (await image.boundingBox())!.width).toBeGreaterThan(fittedWidth * 1.1);
    await dialog.getByRole('button', { name: 'Close image preview', exact: true }).click();
    await expect(dialog).toHaveCount(0);
    await expect(inlineImage).toBeVisible();
    await expect(page.getByRole('region', { name: 'Referenced resources', exact: true })).toHaveCount(0);
  }
});

test('opens a Markdown image across the viewport and restores reading position and focus', async ({ page }, info) => {
  const timeline = page.getByTestId('timeline');
  await timeline.dispatchEvent('wheel', { deltaY: -1 });
  const trigger = page.getByRole('button', { name: 'Open image: Viewer diagram', exact: true });
  await trigger.scrollIntoViewIfNeeded();
  await expect(trigger.getByRole('img')).toBeVisible();
  await trigger.focus();
  const scrollBefore = await timeline.evaluate(element => element.scrollTop);
  const frameBefore = await trigger.boundingBox();
  await trigger.press('Enter');
  const dialog = await preview(page);
  await page.screenshot({ path: info.outputPath('image-viewer-fullscreen.png') });
  await dialog.getByRole('button', { name: 'Close image preview', exact: true }).focus();
  await page.keyboard.press('Shift+Tab');
  expect(await dialog.evaluate(element => element.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(await timeline.evaluate(element => element.scrollTop)).toBeCloseTo(scrollBefore, 0);
  expect((await trigger.boundingBox())!.y).toBeCloseTo(frameBefore!.y, 0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('opens resource thumbnails, sent image tags and image file links in the shared viewer', async ({ page }) => {
  const targets = [
    page.getByRole('region', { name: 'Referenced resources' }).getByRole('img', { name: './viewer.png', exact: true }),
    page.getByRole('button', { name: 'Preview image #1', exact: true }),
    page.getByRole('button', { name: 'Open diagram file', exact: true }),
  ];
  for (const target of targets) {
    await page.getByTestId('timeline').dispatchEvent('wheel', { deltaY: -1 });
    await target.evaluate(element => element.scrollIntoView({ block: 'center' }));
    const timelineWidth = (await page.getByTestId('timeline').boundingBox())!.width;
    await target.click();
    const dialog = await preview(page);
    await expect.poll(async () => (await page.getByTestId('timeline').boundingBox())!.width).toBeCloseTo(timelineWidth, 0);
    await dialog.getByRole('button', { name: 'Close image preview', exact: true }).click();
    await expect(dialog).toHaveCount(0);
  }
});

test('keeps following new messages after opening and manipulating an image at the conversation tail', async ({ page, browserName, isMobile }) => {
  await page.goto('/e2e/fixtures/image-viewer.html?tail=1');
  const timeline = page.getByTestId('timeline');
  const bottomDistance = () => timeline.evaluate(element => Math.abs(element.scrollTop));
  const trigger = page.getByRole('button', { name: 'Open image: Latest diagram', exact: true });
  await expect(trigger.getByRole('img')).toBeVisible();
  await expect(trigger).toBeInViewport({ ratio: 1 });
  await expect.poll(bottomDistance).toBeLessThanOrEqual(4);
  await trigger.click();
  const dialog = await preview(page);
  const canvas = dialog.getByRole('group', { name: 'Image canvas', exact: true });
  await dialog.getByRole('button', { name: 'Zoom in', exact: true }).click();
  const bounds = (await canvas.boundingBox())!;
  const center = { x: bounds.x + bounds.width / 2, y: bounds.y + bounds.height / 2 };
  await page.mouse.move(center.x, center.y);
  if (browserName !== 'webkit' || !isMobile) await page.mouse.wheel(0, -100);
  await page.mouse.down();
  await page.mouse.move(center.x + 50, center.y + 50, { steps: 6 });
  await page.mouse.up();
  if (browserName === 'chromium' && isMobile) {
    const touch = await page.context().newCDPSession(page);
    try {
      await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 0, ...center }] });
      for (const offset of [10, 20, 30, 40, 50]) {
        await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 0, x: center.x, y: center.y + offset }] });
      }
      await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    } finally { await touch.detach(); }
  }
  await dialog.getByRole('button', { name: 'Close image preview', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await page.evaluate(() => (window as unknown as { appendImageViewerMessage(): void }).appendImageViewerMessage());
  await expect(page.getByText('New message after image preview', { exact: true })).toBeAttached();
  await expect.poll(bottomDistance).toBeLessThanOrEqual(4);
  await expect(page.getByRole('button', { name: 'Back to latest' })).toHaveCount(0);
});

test('zooms the image, pans it with a pointer and resets to the fitted view', async ({ page }, info) => {
  const dialog = await openMarkdown(page);
  const image = dialog.getByRole('img');
  const fitted = (await image.boundingBox())!;
  await dialog.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await expect.poll(async () => (await image.boundingBox())!.width).toBeGreaterThan(fitted.width * 1.1);
  const zoomed = (await image.boundingBox())!;
  const viewport = page.viewportSize()!;
  const start = { x: viewport.width / 2, y: viewport.height / 2 };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 60, start.y + 35, { steps: 8 });
  await page.mouse.up();
  await expect.poll(async () => Math.abs((await image.boundingBox())!.x - zoomed.x)).toBeGreaterThan(20);
  await page.screenshot({ path: info.outputPath('image-viewer-zoomed.png') });
  await dialog.getByRole('button', { name: 'Zoom out', exact: true }).click();
  await expect.poll(async () => (await image.boundingBox())!.width).toBeLessThan(zoomed.width);
  await dialog.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await dialog.getByRole('button', { name: 'Reset zoom', exact: true }).click();
  await expect.poll(async () => (await image.boundingBox())!.width).toBeCloseTo(fitted.width, 0);
  expect((await image.boundingBox())!.x).toBeCloseTo(fitted.x, 0);
  expect((await image.boundingBox())!.y).toBeCloseTo(fitted.y, 0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('zooms with the mouse wheel while preserving conversation scroll', async ({ page, browserName, isMobile }) => {
  test.skip(browserName === 'webkit' && isMobile, 'Playwright does not support mouse-wheel input in mobile WebKit.');
  const dialog = await openMarkdown(page);
  const image = dialog.getByRole('img');
  const canvas = dialog.getByRole('group', { name: 'Image canvas', exact: true });
  const fitted = (await image.boundingBox())!;
  const stage = (await canvas.boundingBox())!;
  const scrollBefore = await page.getByTestId('timeline').evaluate(element => element.scrollTop);
  await page.mouse.move(stage.x + stage.width / 2, stage.y + stage.height / 2);
  await page.mouse.wheel(0, -240);
  await expect.poll(async () => (await image.boundingBox())!.width).toBeGreaterThan(fitted.width * 1.2);
  expect(await page.getByTestId('timeline').evaluate(element => element.scrollTop)).toBeCloseTo(scrollBefore, 0);
});

test('supports double click and keyboard controls and refits after viewport changes', async ({ page }) => {
  const dialog = await openMarkdown(page);
  const image = dialog.getByRole('img');
  const canvas = dialog.getByRole('group', { name: 'Image canvas', exact: true });
  const fitted = (await image.boundingBox())!;
  await canvas.dblclick();
  await expect.poll(async () => (await image.boundingBox())!.width).toBeGreaterThanOrEqual(fitted.width * 1.99);
  await canvas.dblclick();
  await expect.poll(async () => (await image.boundingBox())!.width).toBeCloseTo(fitted.width, 0);
  await canvas.focus();
  await page.keyboard.press('0');
  await expect(dialog.getByRole('button', { name: 'Zoom out', exact: true })).toBeDisabled();
  await page.keyboard.press('+');
  await expect.poll(async () => (await image.boundingBox())!.width).toBeGreaterThan(fitted.width * 1.4);
  const zoomed = (await image.boundingBox())!;
  await page.keyboard.press('ArrowRight');
  await expect.poll(async () => (await image.boundingBox())!.x).toBeLessThan(zoomed.x - 20);
  await page.keyboard.press('-');
  await expect.poll(async () => (await image.boundingBox())!.width).toBeCloseTo(fitted.width, 0);
  await page.keyboard.press('=');
  const viewport = page.viewportSize()!;
  await page.setViewportSize({ width: viewport.width - 40, height: viewport.height - 80 });
  await expect(dialog.getByRole('button', { name: 'Zoom out', exact: true })).toBeDisabled();
  const resizedImage = (await image.boundingBox())!;
  const resizedCanvas = (await canvas.boundingBox())!;
  expect(resizedImage.x).toBeGreaterThanOrEqual(resizedCanvas.x - 1);
  expect(resizedImage.y).toBeGreaterThanOrEqual(resizedCanvas.y - 1);
  expect(resizedImage.x + resizedImage.width).toBeLessThanOrEqual(resizedCanvas.x + resizedCanvas.width + 1);
  expect(resizedImage.y + resizedImage.height).toBeLessThanOrEqual(resizedCanvas.y + resizedCanvas.height + 1);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('pinches the image without zooming the mobile page', async ({ page, browserName, isMobile }) => {
  test.skip(browserName !== 'chromium' || !isMobile, 'Native multi-touch injection requires a Chromium mobile context.');
  const dialog = await openMarkdown(page);
  const image = dialog.getByRole('img');
  const fitted = (await image.boundingBox())!;
  const viewport = page.viewportSize()!;
  const center = { x: viewport.width / 2, y: viewport.height / 2 };
  const pageScale = await page.evaluate(() => visualViewport?.scale);
  const touch = await page.context().newCDPSession(page);
  try {
    const points = (distance: number) => [
      { id: 0, x: center.x - distance, y: center.y },
      { id: 1, x: center.x + distance, y: center.y },
    ];
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: points(35) });
    for (const distance of [45, 55, 65, 75, 85]) {
      await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: points(distance) });
    }
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect.poll(async () => (await image.boundingBox())!.width).toBeGreaterThan(fitted.width * 1.5);
    expect(await page.evaluate(() => visualViewport?.scale)).toBe(pageScale);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await dialog.getByRole('button', { name: 'Reset zoom', exact: true }).click();
    await expect.poll(async () => (await image.boundingBox())!.width).toBeCloseTo(fitted.width, 0);
  } finally { await touch.detach(); }
});
