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
  // Keyboard activation keeps the opener focused in WebKit so restoration has the same precondition in every engine.
  await trigger.press('Enter');
  return preview(page);
}

async function canvasCenter(dialog: Locator): Promise<{ x: number; y: number }> {
  const box = (await dialog.getByRole('group', { name: 'Image canvas', exact: true }).boundingBox())!;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}

async function backdropOpacity(dialog: Locator): Promise<number> {
  return dialog.locator('.agent-image-preview-backdrop').evaluate(element => Number(getComputedStyle(element).opacity));
}

test.beforeEach(async ({ page }) => {
  await page.goto('/e2e/fixtures/image-viewer.html');
  await expect(page.getByTestId('timeline')).toBeVisible();
});

test('keeps the fullscreen image accessible without a visible title', async ({ page }) => {
  const dialog = await openMarkdown(page);
  await expect(dialog.getByRole('img', { name: 'Viewer diagram', exact: true })).toBeVisible();
  await expect(dialog.getByText('Viewer diagram', { exact: true })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Close image preview', exact: true })).toBeVisible();
});

test('floats the image and reveals the conversation during a downward drag that can be pushed back', async ({ page }, info) => {
  const dialog = await openMarkdown(page);
  const image = dialog.getByRole('img');
  const fitted = (await image.boundingBox())!;
  const timeline = page.getByTestId('timeline');
  const scrollBefore = await timeline.evaluate(element => element.scrollTop);
  const start = await canvasCenter(dialog);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 24, start.y + 140, { steps: 8 });
  await expect.poll(async () => (await image.boundingBox())!.y).toBeGreaterThan(fitted.y + 60);
  await expect.poll(async () => (await image.boundingBox())!.width).toBeLessThan(fitted.width * 0.99);
  await expect.poll(() => backdropOpacity(dialog)).toBeLessThan(0.95);
  expect(await timeline.evaluate(element => element.scrollTop)).toBeCloseTo(scrollBefore, 0);
  await page.screenshot({ path: info.outputPath('image-viewer-pull-down.png') });

  await page.mouse.move(start.x, start.y, { steps: 8 });
  await expect.poll(async () => (await image.boundingBox())!.y).toBeCloseTo(fitted.y, 0);
  await expect.poll(async () => (await image.boundingBox())!.width).toBeCloseTo(fitted.width, 0);
  await expect.poll(() => backdropOpacity(dialog)).toBeCloseTo(1, 2);
  await expect(dialog).toBeVisible();
  await page.mouse.up();
  await expect(dialog).toBeVisible();
  expect(await timeline.evaluate(element => element.scrollTop)).toBeCloseTo(scrollBefore, 0);
});

test('rebounds a short held drag and dismisses a long drag without losing reading position or focus', async ({ page }) => {
  const dialog = await openMarkdown(page);
  const image = dialog.getByRole('img');
  const fitted = (await image.boundingBox())!;
  const trigger = page.getByRole('button', { name: 'Open image: Viewer diagram', exact: true });
  const timeline = page.getByTestId('timeline');
  const scrollBefore = await timeline.evaluate(element => element.scrollTop);
  const triggerBefore = (await trigger.boundingBox())!;
  const start = await canvasCenter(dialog);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x, start.y + 48, { steps: 6 });
  await expect.poll(async () => (await image.boundingBox())!.y).toBeGreaterThan(fitted.y + 20);
  // Holding the pointer removes flick velocity so only the drag distance matters.
  await page.waitForTimeout(180);
  await page.mouse.up();
  await expect(dialog).toBeVisible();
  await expect.poll(async () => (await image.boundingBox())!.y).toBeCloseTo(fitted.y, 0);
  await expect.poll(async () => (await image.boundingBox())!.width).toBeCloseTo(fitted.width, 0);

  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x, start.y + Math.min(240, page.viewportSize()!.height * 0.3), { steps: 10 });
  await page.waitForTimeout(180);
  await page.mouse.up();
  await expect(dialog).toHaveCount(0);
  await expect(trigger).toBeFocused();
  expect(await timeline.evaluate(element => element.scrollTop)).toBeCloseTo(scrollBefore, 0);
  expect((await trigger.boundingBox())!.y).toBeCloseTo(triggerBefore.y, 0);
});

test('dismisses a short downward flick but keeps a zoomed image open during a long pan', async ({ page }) => {
  let dialog = await openMarkdown(page);
  let start = await canvasCenter(dialog);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x, start.y + 96, { steps: 2 });
  await page.mouse.up();
  await expect(dialog).toHaveCount(0);

  dialog = await openMarkdown(page);
  const image = dialog.getByRole('img');
  const fitted = (await image.boundingBox())!;
  await dialog.getByRole('button', { name: 'Zoom in', exact: true }).click();
  await dialog.getByRole('button', { name: 'Zoom in', exact: true }).click();
  start = await canvasCenter(dialog);
  const scrollBefore = await page.getByTestId('timeline').evaluate(element => element.scrollTop);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x + 45, start.y + 230, { steps: 6 });
  await page.mouse.up();
  await expect(dialog).toBeVisible();
  expect((await image.boundingBox())!.width).toBeGreaterThan(fitted.width * 2);
  expect(await backdropOpacity(dialog)).toBeCloseTo(1, 2);
  expect(await page.getByTestId('timeline').evaluate(element => element.scrollTop)).toBeCloseTo(scrollBefore, 0);
});

test('uses a native touch drag to dismiss while keeping pinch and remaining-finger movement inside the viewer', async ({ page, browserName, isMobile }) => {
  test.skip(browserName !== 'chromium' || !isMobile, 'Native multi-touch injection requires a Chromium mobile context.');
  const dialog = await openMarkdown(page);
  const image = dialog.getByRole('img');
  const fitted = (await image.boundingBox())!;
  const timeline = page.getByTestId('timeline');
  const scrollBefore = await timeline.evaluate(element => element.scrollTop);
  const center = await canvasCenter(dialog);
  const touch = await page.context().newCDPSession(page);
  try {
    const first = { id: 0, x: center.x - 35, y: center.y };
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [first] });
    await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...first, y: center.y + 90 }] });
    await expect.poll(async () => (await image.boundingBox())!.y).toBeGreaterThan(fitted.y + 35);
    const pair = (span: number) => [
      { id: 0, x: center.x - span, y: center.y + 90 },
      { id: 1, x: center.x + span, y: center.y + 90 },
    ];
    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: pair(35) });
    for (const span of [45, 55, 65]) {
      await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: pair(span) });
    }
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [pair(65)[0]!] });
    await touch.send('Input.dispatchTouchEvent', {
      type: 'touchMove', touchPoints: [{ id: 0, x: center.x - 65, y: center.y + 260 }],
    });
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(dialog).toBeVisible();
    expect((await image.boundingBox())!.width).toBeGreaterThan(fitted.width * 1.4);
    expect(await backdropOpacity(dialog)).toBeCloseTo(1, 2);
    await dialog.getByRole('button', { name: 'Reset zoom', exact: true }).click();
    await expect.poll(async () => (await image.boundingBox())!.width).toBeCloseTo(fitted.width, 0);

    await touch.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ id: 0, ...center }] });
    for (const offset of [30, 60, 90, 120, 160, 200, 240]) {
      await touch.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ id: 0, x: center.x, y: center.y + offset }] });
    }
    await expect.poll(() => backdropOpacity(dialog)).toBeLessThan(0.95);
    await touch.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    await expect(dialog).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Open image: Viewer diagram', exact: true })).toBeFocused();
    expect(await timeline.evaluate(element => element.scrollTop)).toBeCloseTo(scrollBefore, 0);
  } finally { await touch.detach(); }
});

for (const cancellation of ['pointercancel', 'lost capture'] as const) {
  test(`rebounds a long drag after ${cancellation} instead of dismissing the viewer`, async ({ page }) => {
    const dialog = await openMarkdown(page);
    const image = dialog.getByRole('img');
    const canvas = dialog.getByRole('group', { name: 'Image canvas', exact: true });
    const fitted = (await image.boundingBox())!;
    const timeline = page.getByTestId('timeline');
    const scrollBefore = await timeline.evaluate(element => element.scrollTop);
    // Capture the browser-assigned ID rather than assuming mouse pointer IDs match across engines.
    await canvas.evaluate(element => element.addEventListener('gotpointercapture', event => {
      element.setAttribute('data-test-captured-pointer', String((event as PointerEvent).pointerId));
    }, { once: true }));
    const start = await canvasCenter(dialog);
    const endY = start.y + Math.min(240, page.viewportSize()!.height * 0.3);
    await page.mouse.move(start.x, start.y);
    await page.mouse.down();
    await page.mouse.move(start.x, endY, { steps: 8 });
    await expect.poll(async () => (await image.boundingBox())!.y).toBeGreaterThan(fitted.y + 100);
    await expect(canvas).toHaveAttribute('data-test-captured-pointer', /^\d+$/);
    const pointerId = Number(await canvas.getAttribute('data-test-captured-pointer'));
    if (cancellation === 'pointercancel') {
      await canvas.dispatchEvent('pointercancel', { pointerId, pointerType: 'mouse', isPrimary: true, buttons: 0 });
    } else {
      await canvas.evaluate((element, id) => element.releasePointerCapture(id), pointerId);
      await page.mouse.move(start.x + 1, endY);
    }
    await expect(dialog).toBeVisible();
    await expect.poll(async () => (await image.boundingBox())!.y).toBeCloseTo(fitted.y, 0);
    await expect.poll(async () => (await image.boundingBox())!.width).toBeCloseTo(fitted.width, 0);
    await expect.poll(() => backdropOpacity(dialog)).toBeCloseTo(1, 2);
    await page.mouse.up();
    await expect(dialog).toBeVisible();
    expect(await timeline.evaluate(element => element.scrollTop)).toBeCloseTo(scrollBefore, 0);
  });
}

test('refits and cancels an active dismiss drag when the viewport changes', async ({ page }) => {
  const dialog = await openMarkdown(page);
  const image = dialog.getByRole('img');
  const canvas = dialog.getByRole('group', { name: 'Image canvas', exact: true });
  const fitted = (await image.boundingBox())!;
  const start = await canvasCenter(dialog);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x, start.y + Math.min(240, page.viewportSize()!.height * 0.3), { steps: 8 });
  await expect.poll(async () => (await image.boundingBox())!.y).toBeGreaterThan(fitted.y + 100);

  const viewport = page.viewportSize()!;
  await page.setViewportSize({ width: viewport.width - 40, height: viewport.height - 80 });
  await expect(dialog).toBeVisible();
  await expect.poll(() => backdropOpacity(dialog)).toBeCloseTo(1, 2);
  await expect(dialog.getByRole('button', { name: 'Zoom out', exact: true })).toBeDisabled();
  await expect.poll(async () => {
    const picture = (await image.boundingBox())!;
    const stage = (await canvas.boundingBox())!;
    return Math.max(
      Math.abs(picture.x + picture.width / 2 - stage.x - stage.width / 2),
      Math.abs(picture.y + picture.height / 2 - stage.y - stage.height / 2),
      Math.abs(picture.width - Math.min(1200, stage.width, stage.height * 2)),
    );
  }).toBeLessThan(1);
  await page.mouse.up();
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test('supports dragging to dismiss with reduced motion and restores focus', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  const dialog = await openMarkdown(page);
  const image = dialog.getByRole('img');
  const fitted = (await image.boundingBox())!;
  const timeline = page.getByTestId('timeline');
  const scrollBefore = await timeline.evaluate(element => element.scrollTop);
  const start = await canvasCenter(dialog);
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  await page.mouse.move(start.x, start.y + Math.min(240, page.viewportSize()!.height * 0.3), { steps: 8 });
  await expect.poll(async () => (await image.boundingBox())!.y).toBeGreaterThan(fitted.y + 100);
  await expect.poll(() => backdropOpacity(dialog)).toBeLessThan(0.95);
  await page.mouse.up();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open image: Viewer diagram', exact: true })).toBeFocused();
  expect(await timeline.evaluate(element => element.scrollTop)).toBeCloseTo(scrollBefore, 0);
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
